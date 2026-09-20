import type { SupabaseClient } from '@supabase/supabase-js';
import { SocietyError, normalizeJoinCode } from '@ses/domain';
import type {
  CreateSocietyInput,
  JoinSocietyInput,
  Society,
  SocietyJoinPreview,
  SocietyMembership,
  SocietyRepository,
  UpdateSocietyInput,
} from '@ses/domain';

import { getSupabaseClient } from '@/lib/supabase/supabase.client';

import {
  createPayload,
  joinPreviewFromPayload,
  joinPreviewSchema,
  memberRowListSchema,
  memberRowSchema,
  membershipFromRow,
  occupancyToRow,
  societyErrorFromPostgrest,
  societyFromSnapshot,
  societySnapshotSchema,
  unexpectedShapeError,
  updatePayload,
} from './society.rows';
import type { MemberRow, SocietySnapshot } from './society.rows';

/**
 * `SocietyRepository` implemented against Supabase (PostgREST + RLS), replacing
 * the mock for real runs — see `society.repository.ts`, which is the only place
 * that chooses between them.
 *
 * ## The boundary is RLS, not this class
 *
 * The anon key ships in the bundle, so anyone can take it out and call PostgREST
 * directly. Nothing here is a security control: the policies and column grants in
 * `supabase/migrations/20260920130100_society_rls.sql` are. This class is a
 * translator — rows in, domain objects out — and it is written so that a bug in it
 * cannot widen access: every write goes through a function whose own membership
 * check runs before it touches a row (`20260920130200_society_rpc.sql`).
 *
 * ## Why the `actor` argument is usually not used
 *
 * The port takes `actor` so that scope can never come from ambient state. Over
 * HTTP the actor *is* the JWT: RLS resolves `auth.uid()` from it, and the server
 * ignores any id a client sends. Passing `actor` back as a query value would be
 * strictly weaker — a client-supplied id can lie, `auth.uid()` cannot — so it is
 * used only where it is the honest expression of intent: `join` (which writes
 * `user_id`) and `leave` (which must not be able to touch anyone else's row, even
 * though an Admin's policy would allow it).
 *
 * ## Round trips
 *
 * Every read is one request and every write is one request, except `join`
 * (resolve the code, then write) — the reason the write paths are SQL functions
 * rather than sequences of PostgREST calls is precisely to keep that true while
 * staying atomic. `create` retries once on a join-code collision, because the code
 * is minted by the database.
 */

const MEMBERS_TABLE = 'members';

/** Only what `SocietyMembership` needs — no PII beyond the graph identifiers. */
const MEMBER_COLUMNS = 'id, society_id, user_id, role, status, occupancy, joined_at';

export interface SupabaseSocietyRepositoryOptions {
  /** Inject a client (tests, a second project). Defaults to the app singleton. */
  readonly client?: SupabaseClient;
}

export class SupabaseSocietyRepository implements SocietyRepository {
  private readonly injected: SupabaseClient | undefined;

  constructor(options: SupabaseSocietyRepositoryOptions = {}) {
    this.injected = options.client;
  }

  /** Lazily resolved so importing this module never builds a client. */
  private get client(): SupabaseClient {
    return this.injected ?? getSupabaseClient();
  }

  // ── read ─────────────────────────────────────────────────────────────────────

  /** The signed-in user's memberships, newest first (drives the switcher). */
  async listMemberships(actor: string): Promise<readonly SocietyMembership[]> {
    const { data, error } = await this.client
      .from(MEMBERS_TABLE)
      .select(MEMBER_COLUMNS)
      // No `status = 'removed'` rows: a former member is not a member any more,
      // and the resolver routes on this list.
      .neq('status', 'removed')
      .eq('user_id', actor)
      .order('created_at', { ascending: false });

    if (error !== null) throw societyErrorFromPostgrest(error, 'read');
    return this.parseMembers(data ?? []);
  }

  /** Full society for a member of it, `null` otherwise. One request. */
  async findById(id: string): Promise<Society | null> {
    const { data, error } = await this.client.rpc('society_snapshot', {
      p_society_id: id,
    });
    if (error !== null) throw societyErrorFromPostgrest(error, 'read');
    if (data === null || data === undefined) {
      // `null` is the function's way of saying "no live membership for you",
      // and the port requires that to be indistinguishable from "no such
      // society" (PRD T041).
      return null;
    }
    const snapshot = this.parseSnapshot(data, 'society');
    return societyFromSnapshot(snapshot, snapshot.memberCount);
  }

  /** Public preview of a join code (PRD §3.2). One request, no membership needed. */
  async findJoinPreview(rawCode: string): Promise<SocietyJoinPreview | null> {
    const code = normalizeJoinCode(rawCode);
    if (code.length === 0) return null;

    const { data, error } = await this.client.rpc('society_join_preview', {
      p_code: code,
    });
    if (error !== null) throw societyErrorFromPostgrest(error, 'read');
    if (data === null || data === undefined) return null;

    const parsed = joinPreviewSchema.safeParse(data);
    if (!parsed.success) throw unexpectedShapeError('join preview');
    return joinPreviewFromPayload(parsed.data);
  }

  /**
   * Every membership of one society, as seen by `actor`.
   *
   * One request, and the membership check comes out of it for free: RLS shows an
   * active member the whole roster and *always* shows the caller their own row. So
   * a roster that does not contain the caller means they are not a member — which
   * the port requires to look like a non-existent society, not an empty list
   * (an empty list would confirm the society exists).
   */
  async listSocietyMemberships(
    societyId: string,
    actor: string,
  ): Promise<readonly SocietyMembership[]> {
    const { data, error } = await this.client
      .from(MEMBERS_TABLE)
      .select(MEMBER_COLUMNS)
      .eq('society_id', societyId)
      .order('created_at', { ascending: true });

    if (error !== null) throw societyErrorFromPostgrest(error, 'read');
    const rows = this.parseMemberRowList(data ?? []);
    const mine = rows.find((row) => row.user_id === actor);
    if (mine === undefined || mine.status === 'removed') {
      throw new SocietyError('not_found', 'That society is not available to you.');
    }

    // Shadow members (no account yet — PRD §3.2) have no `UserId`, so the domain
    // cannot represent them; the members module (T045) is where they get one.
    return rows.filter((row) => row.user_id !== null).map((row) => membershipFromRow(row));
  }

  // ── write ────────────────────────────────────────────────────────────────────

  /**
   * Create a society, its settings and the creator's Admin membership — one
   * transaction, one request (PRD §3.2). The slug, the join code and the
   * admin membership are all derived server-side; the client sends only what the
   * user actually chose.
   */
  async create(
    input: CreateSocietyInput,
  ): Promise<{ readonly society: Society; readonly membership: SocietyMembership }> {
    const payload = createPayload(input);

    let { data, error } = await this.client.rpc('society_create', { p_payload: payload });

    // The code is minted by the database, so a collision is a race, not a bug:
    // another society took the code between the uniqueness check and the insert.
    // One retry mints a different one (PRD T040).
    if (
      error !== null &&
      /23505/.test(String(error.code)) &&
      /join_code/i.test(String(error.message))
    ) {
      ({ data, error } = await this.client.rpc('society_create', { p_payload: payload }));
    }
    if (error !== null) throw societyErrorFromPostgrest(error, 'write');

    const snapshot = this.parseSnapshot(data, 'created society');
    if (snapshot.membership === null || snapshot.membership.user_id === null) {
      // `seed_society()` guarantees this row; if it is missing the database is in
      // a state this client cannot fix, and reporting success would be a lie.
      throw new SocietyError('unknown', 'Something went wrong. Please try again.', {
        hint: 'society_create() returned a snapshot without the creator membership.',
      });
    }

    return {
      society: societyFromSnapshot(snapshot, snapshot.memberCount),
      membership: membershipFromRow(snapshot.membership),
    };
  }

  /**
   * Patch the society and/or its settings atomically.
   *
   * One request, because `society_update()` wraps both tables in one
   * transaction — two PostgREST calls could apply half an edit if the connection
   * dropped between them.
   */
  async update(id: string, input: UpdateSocietyInput): Promise<Society> {
    const { data, error } = await this.client.rpc('society_update', {
      p_society_id: id,
      p_patch: updatePayload(input),
    });
    if (error !== null) throw societyErrorFromPostgrest(error, 'write');

    const snapshot = this.parseSnapshot(data, 'updated society');
    return societyFromSnapshot(snapshot, snapshot.memberCount);
  }

  /** Admin-only join-code rotation. The new code is minted server-side. */
  async regenerateJoinCode(id: string): Promise<Society> {
    const { data, error } = await this.client.rpc('society_rotate_join_code', {
      p_society_id: id,
    });
    if (error !== null) throw societyErrorFromPostgrest(error, 'write');

    const snapshot = this.parseSnapshot(data, 'rotated society');
    return societyFromSnapshot(snapshot, snapshot.memberCount);
  }

  /**
   * Soft delete: the society row stays (financial history keeps its owner, PRD
   * §3.1/§3.3), every membership is marked removed, and the join code stops
   * resolving. Admin-only, checked inside the function.
   */
  async remove(id: string): Promise<void> {
    const { error } = await this.client.rpc('society_soft_delete', { p_society_id: id });
    if (error !== null) throw societyErrorFromPostgrest(error, 'write');
  }

  /**
   * Ask to join with a code (never auto-approved — PRD §3.2).
   *
   * Two requests: resolve the code to a society (the RPC that already knows how to
   * answer a non-member), then write the membership. The write is pinned to
   * `user_id = auth.uid()` and to `pending`/`resident` *by the policy*, so a
   * tampered client cannot approve itself; a second request in a race is answered
   * by the unique constraint, which the error mapper reports as `already_member`.
   */
  async join(input: JoinSocietyInput, actor: string): Promise<SocietyMembership> {
    const preview = await this.findJoinPreview(input.code);
    if (preview === null) {
      // One message for "no such code" and "code belongs to a deleted society": a
      // probe must not be able to enumerate societies.
      throw new SocietyError('join_code_invalid', 'That join code does not match any society.');
    }

    const existing = await this.client
      .from(MEMBERS_TABLE)
      .select(MEMBER_COLUMNS)
      .eq('society_id', preview.id)
      .eq('user_id', actor)
      .maybeSingle();
    if (existing.error !== null) throw societyErrorFromPostgrest(existing.error, 'read');

    if (existing.data !== null && existing.data !== undefined) {
      const row = this.parseMemberRow(existing.data);
      if (row.status !== 'removed') {
        throw new SocietyError('already_member', 'You are already a member of this society.');
      }
      // Re-joining after leaving: the row is history and is re-asked, never
      // re-created. The self-change trigger allows exactly this transition.
      const reasked = await this.client
        .from(MEMBERS_TABLE)
        .update({
          status: 'pending',
          occupancy: occupancyToRow(input.occupancyType),
          removed_at: null,
        })
        .eq('id', row.id)
        .select(MEMBER_COLUMNS)
        .single();
      if (reasked.error !== null) throw societyErrorFromPostgrest(reasked.error, 'write');
      return membershipFromRow(this.parseMemberRow(reasked.data));
    }

    const inserted = await this.client
      .from(MEMBERS_TABLE)
      .insert({
        society_id: preview.id,
        user_id: actor,
        occupancy: occupancyToRow(input.occupancyType),
        // `role` and `status` are intentionally absent: the column defaults
        // (`resident`, `pending`) are the only values the policy accepts, and not
        // sending them means a compromised client has nothing to lie with.
      })
      .select(MEMBER_COLUMNS)
      .single();
    if (inserted.error !== null) throw societyErrorFromPostgrest(inserted.error, 'write');

    return membershipFromRow(this.parseMemberRow(inserted.data));
  }

  /**
   * Leave, or withdraw a pending request. `user_id = actor` is explicit even
   * though the policy would also allow an Admin to update other rows — leaving is
   * by definition about your own row, and a filter is what keeps it that way.
   *
   * The "a society always has an active Admin" invariant is enforced by a
   * deferred trigger, so the refusal arrives as `SOCIETY_ADMIN_REQUIRED` →
   * `sole_admin` (the domain asks the same question first; this is what happens
   * when a stale client skips it).
   */
  async leave(societyId: string, actor: string): Promise<void> {
    const { data, error } = await this.client
      .from(MEMBERS_TABLE)
      .update({ status: 'removed' })
      .eq('society_id', societyId)
      .eq('user_id', actor)
      .neq('status', 'removed')
      .select('id');

    if (error !== null) throw societyErrorFromPostgrest(error, 'write');
    if (data === null || data.length === 0) {
      // Nothing to leave: no live membership for this caller.
      throw new SocietyError('not_found', 'That society is not available to you.');
    }
  }

  // ── parsing ──────────────────────────────────────────────────────────────────

  /** Row → domain, refusing to guess when the payload does not match. */
  private parseMembers(rows: readonly unknown[]): readonly SocietyMembership[] {
    return this.parseMemberRowList(rows).map((row) => membershipFromRow(row));
  }

  private parseMemberRowList(rows: readonly unknown[]): readonly MemberRow[] {
    const parsed = memberRowListSchema.safeParse(rows);
    if (!parsed.success) throw unexpectedShapeError('membership');
    return parsed.data;
  }

  private parseMemberRow(row: unknown): MemberRow {
    const parsed = memberRowSchema.safeParse(row);
    if (!parsed.success) throw unexpectedShapeError('membership');
    return parsed.data;
  }

  private parseSnapshot(data: unknown, what: string): SocietySnapshot {
    const parsed = societySnapshotSchema.safeParse(data);
    if (!parsed.success) throw unexpectedShapeError(what);
    return parsed.data;
  }
}
