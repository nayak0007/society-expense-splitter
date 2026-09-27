import {
  asApartmentId,
  asInvitationId,
  asMemberId,
  asSocietyId,
  invitationError,
} from "@ses/domain";
import type {
  CreateInvitationInput,
  Invitation,
  InvitationAcceptance,
  InvitationChannel,
  InvitationId,
  InvitationPage,
  InvitationPreview,
  InvitationQuery,
  InvitationRepository,
  InvitationStatus,
  InvitationTokenPort,
  IssuedInvitationToken,
  MemberId,
  MemberRole,
  SocietyId,
  UserId,
} from "@ses/domain";

/**
 * A hand-written fake of `InvitationRepository`.
 *
 * What it deliberately does **not** do: enforce the caps, the duplicate-live-invitation indexes,
 * the recipient rules, the transition machine or the single-use lock. Those are database facts —
 * the canary's, the e2e suite's and the migration's — and a fake that enforced them would let the
 * adapter's classification go untested while the suite stayed green.
 *
 * What it does reproduce, because a use case may rely on it:
 *
 *  - an invitation is addressable only by the pair `(id, societyId)`, so one belonging to another
 *    society is unreachable rather than merely unauthorised (PRD T041);
 *  - `list` filters by status and reports the total the filter produced;
 *  - `previewByTokenHash` answers `null` for a hash no row carries — the port's documented answer
 *    rather than an error;
 *  - `create` records the **digest** it was given and never the token, which is the assertion that
 *    makes "the raw credential never reaches storage" a test instead of a comment.
 */
export class FakeInvitationRepository implements InvitationRepository {
  private readonly rows: Invitation[] = [];
  private readonly recorded: string[] = [];
  private readonly failures = new Map<string, unknown>();
  private previews = new Map<string, InvitationPreview>();
  private acceptance: InvitationAcceptance | null = null;
  private inviterId: MemberId = asMemberId("member-inviter");
  private sequence = 0;
  private now = "2026-09-26T10:00:00.000Z";

  /** The digest `create` was last handed — the value that must never be a token. */
  lastTokenHash: string | null = null;

  create(
    societyId: SocietyId,
    input: CreateInvitationInput,
    _actor: UserId,
  ): Promise<Invitation> {
    return this.run("create", async () => {
      this.lastTokenHash = input.tokenHash;
      this.sequence += 1;
      const row: Invitation = {
        id: asInvitationId(`invitation-${String(this.sequence)}`),
        societyId,
        apartmentId: input.apartmentId,
        apartmentNumber: null,
        invitedBy: this.inviterId,
        invitedByName: "Canary Admin",
        channel: input.channel,
        email: input.email,
        phone: input.phone,
        role: input.role,
        status: "sent",
        expiresAt: input.expiresAt,
        openedAt: null,
        acceptedAt: null,
        revokedAt: null,
        createdAt: this.now,
      };
      this.rows.push(row);
      return row;
    });
  }

  list(
    societyId: SocietyId,
    _actor: UserId,
    query: InvitationQuery,
  ): Promise<InvitationPage> {
    return this.run("list", async () => {
      const matching = this.rows.filter(
        (row) =>
          row.societyId === societyId &&
          (query.status === undefined || row.status === query.status),
      );
      return { invitations: matching, total: matching.length };
    });
  }

  findById(
    id: InvitationId,
    societyId: SocietyId,
    _actor: UserId,
  ): Promise<Invitation | null> {
    return this.run("findById", async () => {
      return (
        this.rows.find((row) => row.id === id && row.societyId === societyId) ??
        null
      );
    });
  }

  revoke(
    id: InvitationId,
    societyId: SocietyId,
    _actor: UserId,
  ): Promise<Invitation> {
    return this.run("revoke", async () => {
      const row = this.rows.find(
        (candidate) => candidate.id === id && candidate.societyId === societyId,
      );
      if (row === undefined) {
        throw invitationError(
          "not_found",
          "That invitation is not available to you.",
        );
      }
      const revoked: Invitation = {
        ...row,
        status: "revoked",
        revokedAt: this.now,
      };
      this.replace(revoked);
      return revoked;
    });
  }

  previewByTokenHash(tokenHash: string): Promise<InvitationPreview | null> {
    return this.run("previewByTokenHash", async () => {
      return this.previews.get(tokenHash) ?? null;
    });
  }

  accept(tokenHash: string, _actor: UserId): Promise<InvitationAcceptance> {
    return this.run("accept", async () => {
      if (this.acceptance === null) {
        throw invitationError(
          "invitation_not_found",
          "That invitation link is not valid. Ask for a new one.",
        );
      }
      void tokenHash;
      return this.acceptance;
    });
  }

  // ── test surface ──────────────────────────────────────────────────────────

  seedInvitation(spec: {
    readonly societyId: string;
    readonly id?: string;
    readonly status?: InvitationStatus;
    readonly channel?: InvitationChannel;
    readonly role?: MemberRole;
    readonly email?: string | null;
    readonly phone?: string | null;
    readonly expiresAt?: string;
    readonly apartmentNumber?: string | null;
    readonly invitedBy?: string;
  }): Invitation {
    this.sequence += 1;
    const row: Invitation = {
      id: asInvitationId(spec.id ?? `invitation-${String(this.sequence)}`),
      societyId: asSocietyId(spec.societyId),
      apartmentId:
        spec.apartmentNumber == null ? null : asApartmentId("apartment-1"),
      apartmentNumber: spec.apartmentNumber ?? null,
      invitedBy: asMemberId(spec.invitedBy ?? "member-inviter"),
      invitedByName: "Canary Admin",
      channel: spec.channel ?? "email",
      email: spec.email ?? "invitee@canary.ses.test",
      phone: spec.phone ?? null,
      role: spec.role ?? "resident",
      status: spec.status ?? "sent",
      expiresAt: spec.expiresAt ?? "2026-10-10T10:00:00.000Z",
      openedAt: null,
      acceptedAt: spec.status === "accepted" ? this.now : null,
      revokedAt: spec.status === "revoked" ? this.now : null,
      createdAt: this.now,
    };
    this.rows.push(row);
    return row;
  }

  /** Registers what a preview for this digest should return. */
  seedPreview(tokenHash: string, preview: InvitationPreview): void {
    this.previews.set(tokenHash, preview);
    this.previews = new Map(this.previews);
  }

  seedAcceptance(acceptance: InvitationAcceptance): void {
    this.acceptance = acceptance;
  }

  setInviter(memberId: string): void {
    this.inviterId = asMemberId(memberId);
  }

  setNow(iso: string): void {
    this.now = iso;
  }

  calls(): readonly string[] {
    return [...this.recorded];
  }

  clearCalls(): void {
    this.recorded.length = 0;
  }

  failNext(method: string, error: unknown): void {
    this.failures.set(method, error);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private replace(next: Invitation): void {
    const at = this.rows.findIndex((row) => row.id === next.id);
    if (at >= 0) this.rows[at] = next;
  }

  private async run<T>(method: string, work: () => Promise<T>): Promise<T> {
    this.recorded.push(method);
    const failure = this.failures.get(method);
    if (failure !== undefined) {
      this.failures.delete(method);
      throw failure;
    }
    return work();
  }
}

/**
 * The token port, faked.
 *
 * Deliberately **not** `node:crypto`, and the reason is worth stating rather than assumed: this
 * package compiles without Node's types (`node:crypto` fails `tsc` here, and would not exist in
 * Hermes at all), which is precisely why hashing is a port. The real digest is the API adapter's;
 * what these tests need is the one property this layer owns — that the *digest* travels and the
 * token does not — and `fakeDigest` reproduces the 64-hex shape the database's
 * `chk_invitations_token_hash` insists on without pretending to be cryptography.
 */
export class FakeInvitationTokens implements InvitationTokenPort {
  private sequence = 0;

  issue(): IssuedInvitationToken {
    this.sequence += 1;
    const token = `canary-token-${String(this.sequence)}-${"x".repeat(24)}`;
    return { token, tokenHash: this.hash(token) };
  }

  hash(token: string): string {
    return fakeDigest(token);
  }
}

/**
 * A deterministic 64-hex expansion — not a hash, and not pretending to be one.
 *
 * An FNV-style accumulator widened to four hex digits per round: enough that two different tokens
 * almost never collide, deterministic so a test can predict it, and exactly the shape the column's
 * CHECK accepts.
 */
function fakeDigest(value: string): string {
  let out = "";
  let accumulator = 7;
  for (let index = 0; out.length < 64; index += 1) {
    accumulator =
      (accumulator * 31 + (value.charCodeAt(index % value.length) || 1)) %
      0xffff;
    out += accumulator.toString(16).padStart(4, "0");
  }
  return out.slice(0, 64);
}
