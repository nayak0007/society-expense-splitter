import { randomUUID } from "node:crypto";

import {
  InvitationError,
  asApartmentId,
  asInvitationId,
  asMemberId,
  asSocietyId,
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
  MemberId,
  MemberRole,
  SocietyId,
  UserId,
} from "@ses/domain";

/**
 * A hand-written fake of `InvitationRepository` for the e2e suite.
 *
 * It deliberately does **not** enforce the rules the real adapter's database enforces — the caps, the
 * duplicate-live indexes, the recipient check, the transition machine, the single-use lock — because
 * those are the migration's and the canary's, and a fake that enforced them would let the *route*
 * tests pass while proving nothing about the routes. What it does reproduce is what a route test
 * needs: the society scoping (a row of another society is unreachable), the port's own answers
 * (`previewByTokenHash` returning `null`, `accept` raising the database's named refusals), and the
 * recorded digest, so a suite can assert that the token the caller received is **not** what storage
 * saw.
 *
 * The refusals it raises are the *same names* the SQL raises, mapped by the same classifier — so a
 * route test can assert the HTTP code a real expired invitation would produce without a database.
 */
export class FakeInvitationRepository implements InvitationRepository {
  private readonly rows: Invitation[] = [];
  private readonly previews = new Map<string, InvitationPreview>();
  private acceptances = new Map<
    string,
    InvitationAcceptance | InvitationError
  >();
  private readonly digests: string[] = [];
  private inviter: MemberId = asMemberId("member-inviter");
  private sequence = 0;

  /** Every digest storage was handed, in order — the assertion that no token ever arrives. */
  digestsSeen(): readonly string[] {
    return [...this.digests];
  }

  async create(
    societyId: SocietyId,
    input: CreateInvitationInput,
    _actor: UserId,
  ): Promise<Invitation> {
    this.digests.push(input.tokenHash);
    if (this.failCreate !== null) {
      const failure = this.failCreate;
      this.failCreate = null;
      throw failure;
    }
    this.sequence += 1;
    const row: Invitation = {
      id: asInvitationId(randomUUID()),
      societyId,
      apartmentId: input.apartmentId,
      apartmentNumber: null,
      invitedBy: this.inviter,
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
      createdAt: "2026-09-26T10:00:00.000Z",
    };
    this.rows.push(row);
    return row;
  }

  async list(
    societyId: SocietyId,
    _actor: UserId,
    query: InvitationQuery,
  ): Promise<InvitationPage> {
    const matching = this.rows.filter(
      (row) =>
        row.societyId === societyId &&
        (query.status === undefined || row.status === query.status),
    );
    return { invitations: matching, total: matching.length };
  }

  async findById(
    id: InvitationId,
    societyId: SocietyId,
    _actor: UserId,
  ): Promise<Invitation | null> {
    return (
      this.rows.find((row) => row.id === id && row.societyId === societyId) ??
      null
    );
  }

  async revoke(
    id: InvitationId,
    societyId: SocietyId,
    _actor: UserId,
  ): Promise<Invitation> {
    const row = this.rows.find(
      (candidate) => candidate.id === id && candidate.societyId === societyId,
    );
    if (row === undefined) {
      throw new InvitationError(
        "not_found",
        "That invitation is not available to you.",
      );
    }
    if (row.status === "accepted") {
      throw new InvitationError(
        "invitation_not_acceptable",
        "That invitation has already been accepted, so there is nothing to revoke.",
        { field: "status" },
      );
    }
    const revoked: Invitation = {
      ...row,
      status: "revoked",
      revokedAt: "2026-09-26T11:00:00.000Z",
    };
    const at = this.rows.findIndex((candidate) => candidate.id === row.id);
    this.rows[at] = revoked;
    return revoked;
  }

  async previewByTokenHash(
    tokenHash: string,
  ): Promise<InvitationPreview | null> {
    return this.previews.get(tokenHash) ?? null;
  }

  async accept(
    tokenHash: string,
    _actor: UserId,
  ): Promise<InvitationAcceptance> {
    const seeded = this.acceptances.get(tokenHash);
    if (seeded === undefined) {
      throw new InvitationError(
        "invitation_not_found",
        "That invitation link is not valid. Ask for a new one.",
      );
    }
    if (seeded instanceof InvitationError) throw seeded;
    return seeded;
  }

  // ── test surface ──────────────────────────────────────────────────────────

  /** Clears every fixture between tests. Without it, rows accumulate and  means nothing. */
  reset(): void {
    this.rows.length = 0;
    this.previews.clear();
    this.acceptances.clear();
    this.digests.length = 0;
    this.sequence = 0;
    this.failCreate = null;
  }

  private failCreate: InvitationError | null = null;

  failNextCreate(error: InvitationError): void {
    this.failCreate = error;
  }

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
    readonly invitedByName?: string;
  }): Invitation {
    this.sequence += 1;
    const row: Invitation = {
      id: asInvitationId(spec.id ?? randomUUID()),
      societyId: asSocietyId(spec.societyId),
      apartmentId:
        spec.apartmentNumber == null ? null : asApartmentId("apartment-1"),
      apartmentNumber: spec.apartmentNumber ?? null,
      invitedBy: this.inviter,
      invitedByName: spec.invitedByName ?? "Canary Admin",
      channel: spec.channel ?? "email",
      email: spec.email === undefined ? "invitee@canary.ses.test" : spec.email,
      phone: spec.phone ?? null,
      role: spec.role ?? "resident",
      status: spec.status ?? "sent",
      expiresAt: spec.expiresAt ?? "2026-10-10T10:00:00.000Z",
      openedAt: null,
      acceptedAt:
        spec.status === "accepted" ? "2026-09-26T11:00:00.000Z" : null,
      revokedAt: spec.status === "revoked" ? "2026-09-26T11:00:00.000Z" : null,
      createdAt: "2026-09-26T10:00:00.000Z",
    };
    this.rows.push(row);
    return row;
  }

  seedPreview(tokenHash: string, preview: InvitationPreview): void {
    this.previews.set(tokenHash, preview);
  }

  seedAcceptance(
    tokenHash: string,
    acceptance: InvitationAcceptance | InvitationError,
  ): void {
    this.acceptances.set(tokenHash, acceptance);
  }
}
