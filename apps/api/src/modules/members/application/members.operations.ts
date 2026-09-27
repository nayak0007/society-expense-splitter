import { Inject, Injectable, Optional } from "@nestjs/common";
import {
  addMember,
  approveJoinRequest,
  assignMemberRole,
  getMember,
  getMemberPermissions,
  getViewer,
  importMembers,
  listJoinRequests,
  listMembers,
  listMyPermissions,
  listRoles,
  previewImport,
  reactivateMember,
  rejectJoinRequest,
  removeMember,
  revokeMemberRole,
  suspendMember,
  updateMember,
} from "@ses/application";
import type {
  AddMemberCommand,
  BulkImportDeps,
  CsvImportCommand,
  CsvImportPreview,
  CsvImportResult,
  ImportApartmentReader,
  ImportInvitationList,
  JoinQueue,
  MemberDetail,
  MemberDirectory,
  MemberDeps,
  MemberPermissionsView,
  RoleCatalogue,
  UpdateMemberCommand,
} from "@ses/application";
import type {
  JoinApprovalInput,
  Member,
  MemberError,
  MemberId,
  MemberQuery,
  MemberRepository,
  MemberRole,
  Result,
  SocietyId,
  UserId,
} from "@ses/domain";

import { toAppError } from "./member-error.mapper";
import {
  IMPORT_FLAT_READER,
  IMPORT_INVITATION_LIST,
} from "./csv-import.tokens";
import { MEMBER_REPOSITORY } from "./member.tokens";

/**
 * The API's view of the member use cases.
 *
 * **No business rules live here.** Every rule — the capability checks, the value objects, the
 * duplicate-number lookup, "absent means unchanged" — is already implemented in
 * `@ses/application`, which the mobile app calls too. This class does the two things that are
 * genuinely specific to HTTP:
 *
 *  1. it supplies the dependencies from the container rather than as values;
 *  2. it unwraps `Result` into a value or a thrown `AppError`, because a controller that had to
 *     branch on `ok` on every route would reintroduce the per-endpoint divergence the shared
 *     layer exists to prevent.
 *
 * The `(deps, actor, …) → Result` shape is what makes (1) trivial: the use cases are pure
 * functions, so there is nothing to construct per request and nothing to reset between them.
 *
 * ## Why one dependency is enough
 *
 * The structure module needs three injections because a building's removal rule asks a question
 * about its children's table. Here the caller's own membership, the target row and the
 * duplicate lookup are all reads of `members`, so a single port serves them; adding a second
 * would be a second way to read one table.
 */
@Injectable()
export class MembersOperations {
  constructor(
    @Inject(MEMBER_REPOSITORY) private readonly members: MemberRepository,
    @Optional()
    @Inject(IMPORT_FLAT_READER)
    private readonly flats: ImportApartmentReader | undefined,
    // Optional at the injection point: the invitation list is bound at the composition
    // root (app.module.ts) to avoid a module cycle, and the e2e suite boots subsets of
    // the graph. `undefined` means the import's collision check simply skips invitations,
    // which the use case's own contract documents.
    @Optional()
    @Inject(IMPORT_INVITATION_LIST)
    private readonly invitations: ImportInvitationList | undefined,
  ) {}

  private get deps(): MemberDeps {
    return { members: this.members };
  }

  async list(
    actor: UserId,
    societyId: SocietyId,
    query: MemberQuery,
  ): Promise<MemberDirectory> {
    return unwrap(listMembers(this.deps, actor, societyId, query));
  }

  async get(
    actor: UserId,
    societyId: SocietyId,
    memberId: MemberId,
  ): Promise<MemberDetail> {
    return unwrap(getMember(this.deps, actor, societyId, memberId));
  }

  /**
   * The caller's own membership — `GET /members/me`.
   *
   * The one read whose subject is the token rather than a path parameter, which is why it takes
   * no id at all: the actor *is* the row, and a route that accepted one would be a way to ask
   * whether somebody else's id exists.
   */
  async getViewer(actor: UserId, societyId: SocietyId): Promise<MemberDetail> {
    return unwrap(getViewer(this.deps, actor, societyId));
  }

  async add(
    actor: UserId,
    societyId: SocietyId,
    command: AddMemberCommand,
  ): Promise<MemberDetail> {
    return unwrap(addMember(this.deps, actor, societyId, command));
  }

  /**
   * The bulk import's dependencies, assembled per call: the member port plus the two
   * reference readers, both optional at the edge so a test wiring without them still
   * boots (the use case then answers "no invitation check", which the e2e suite
   * exercises by *providing* them — the production module always does).
   */
  private get importDeps(): BulkImportDeps {
    return {
      members: this.members,
      ...(this.flats === undefined ? {} : { flats: this.flats }),
      ...(this.invitations === undefined
        ? {}
        : { invitations: this.invitations }),
    };
  }

  /** T048 — the side-effect-free preview. */
  async importPreview(
    actor: UserId,
    societyId: SocietyId,
    command: CsvImportCommand,
  ): Promise<CsvImportPreview> {
    return unwrap(previewImport(this.importDeps, actor, societyId, command));
  }

  /** T048 — the confirmed, partial-success import. */
  async importMembers(
    actor: UserId,
    societyId: SocietyId,
    command: CsvImportCommand,
  ): Promise<CsvImportResult> {
    return unwrap(importMembers(this.importDeps, actor, societyId, command));
  }

  async update(
    actor: UserId,
    societyId: SocietyId,
    memberId: MemberId,
    command: UpdateMemberCommand,
  ): Promise<MemberDetail> {
    return unwrap(updateMember(this.deps, actor, societyId, memberId, command));
  }

  async suspend(
    actor: UserId,
    societyId: SocietyId,
    memberId: MemberId,
  ): Promise<MemberDetail> {
    return unwrap(suspendMember(this.deps, actor, societyId, memberId));
  }

  async reactivate(
    actor: UserId,
    societyId: SocietyId,
    memberId: MemberId,
  ): Promise<MemberDetail> {
    return unwrap(reactivateMember(this.deps, actor, societyId, memberId));
  }

  async remove(
    actor: UserId,
    societyId: SocietyId,
    memberId: MemberId,
  ): Promise<void> {
    return unwrap(removeMember(this.deps, actor, societyId, memberId));
  }

  // ── the join queue (T049) ───────────────────────────────────────────────────

  /** One page of the pending requests, with each row's flat claimants beside it. */
  async joinRequests(
    actor: UserId,
    societyId: SocietyId,
    query: {
      readonly limit?: number | undefined;
      readonly offset?: number | undefined;
    },
  ): Promise<JoinQueue> {
    return unwrap(listJoinRequests(this.deps, actor, societyId, query));
  }

  /**
   * Admit a pending member.
   *
   * The body travels as `JoinApprovalInput` — every field optional, absent meaning "as
   * requested" — so the use case can tell "the approver agreed with the request" from "the
   * approver cleared the flat", which a defaulted object cannot express.
   */
  async approveJoinRequest(
    actor: UserId,
    societyId: SocietyId,
    memberId: MemberId,
    input: JoinApprovalInput,
  ): Promise<MemberDetail> {
    return unwrap(
      approveJoinRequest(this.deps, actor, societyId, memberId, input),
    );
  }

  /** Refuse a pending member, with the reason the requester is owed. */
  async rejectJoinRequest(
    actor: UserId,
    societyId: SocietyId,
    memberId: MemberId,
    reason: string,
  ): Promise<MemberDetail> {
    return unwrap(
      rejectJoinRequest(this.deps, actor, societyId, memberId, reason),
    );
  }

  // ── roles and permissions (T046) ─────────────────────────────────────────────

  /**
   * The role catalogue: every role with the actions it holds, and the caller's capabilities.
   *
   * Read from the matrix (`roleDefinitions()` → `actionsFor`) rather than from the database, so
   * the catalogue cannot describe a grant the guard would refuse.
   */
  async roles(actor: UserId, societyId: SocietyId): Promise<RoleCatalogue> {
    return unwrap(listRoles(this.deps, actor, societyId));
  }

  /** Assign or change one member's role. Returns the permissions the new role holds. */
  async assignRole(
    actor: UserId,
    societyId: SocietyId,
    memberId: MemberId,
    role: MemberRole,
  ): Promise<MemberPermissionsView> {
    return unwrap(
      assignMemberRole(this.deps, actor, societyId, memberId, role),
    );
  }

  /** Revoke a member's role — the same write, aimed at `resident` (PRD §2.3). */
  async revokeRole(
    actor: UserId,
    societyId: SocietyId,
    memberId: MemberId,
  ): Promise<MemberPermissionsView> {
    return unwrap(revokeMemberRole(this.deps, actor, societyId, memberId));
  }

  /**
   * The caller's own effective permissions.
   *
   * The one read here whose subject is the token, and the one whose use case applies **no**
   * capability gate: a suspended member is entitled to see that they may do nothing. The route's
   * `@RequirePermission` is still what the guard chain enforces (§ the controller's note).
   */
  async myPermissions(
    actor: UserId,
    societyId: SocietyId,
  ): Promise<MemberPermissionsView> {
    return unwrap(listMyPermissions(this.deps, actor, societyId));
  }

  /** One member's effective permissions — the member themselves, or an Admin. */
  async memberPermissions(
    actor: UserId,
    societyId: SocietyId,
    memberId: MemberId,
  ): Promise<MemberPermissionsView> {
    return unwrap(getMemberPermissions(this.deps, actor, societyId, memberId));
  }
}

/**
 * Awaits a use case and converts failure into the API's exception.
 *
 * `await` before branching, rather than `.then`, so a rejected promise (an adapter throwing
 * something the use case could not classify — the one case the use cases let escape) propagates
 * as itself and reaches the filter's `INTERNAL` path, instead of being mistaken for a domain
 * failure.
 */
async function unwrap<TValue>(
  pending: Promise<Result<TValue, MemberError>>,
): Promise<TValue> {
  const result = await pending;
  if (!result.ok) {
    throw toAppError(result.error);
  }
  return result.value;
}

/** Re-exported so a controller can name the entity it renders without a second import. */
export type { Member };
