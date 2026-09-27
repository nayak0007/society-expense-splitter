import {
  addMember as addMemberUseCase,
  approveJoinRequest as approveJoinRequestUseCase,
  getMember as getMemberUseCase,
  getViewer as getViewerUseCase,
  listJoinRequests as listJoinRequestsUseCase,
  listMembers as listMembersUseCase,
  reactivateMember as reactivateMemberUseCase,
  rejectJoinRequest as rejectJoinRequestUseCase,
  removeMember as removeMemberUseCase,
  suspendMember as suspendMemberUseCase,
  updateMember as updateMemberUseCase,
} from '@ses/application';
import type { JoinQueue, MemberDetail, MemberDirectory } from '@ses/application';
import {
  approveJoinRequestSchema,
  createMemberSchema,
  rejectJoinRequestSchema,
  updateMemberSchema,
} from '@ses/contracts';
import type { CreateMemberPayload, UpdateMemberPayload } from '@ses/contracts';
import {
  asApartmentId,
  asBuildingId,
  asMemberId,
  asSocietyId,
  asUserId,
  isMemberError,
  MemberError,
} from '@ses/domain';
import type {
  JoinApprovalInput,
  MemberOccupancy,
  MemberQuery,
  MemberRole,
  MemberSort,
  MemberStatus,
  MemberView,
  Result,
} from '@ses/domain';
import type { ZodError } from 'zod';

import { memberDeps } from '../repository/member.deps';

/**
 * Members service — the app's adapter over the member application layer.
 *
 * The same three responsibilities the structure and society services hold, and nothing else:
 *
 *  1. **Wire-shape validation** against the shared contract, so the rule applied here is the
 *     rule the API applies.
 *  2. **`Result` → throw.** Use cases return `Result` because a library must not decide how a
 *     caller reports failure; the app's hooks are written against thrown `MemberError`s, so
 *     the conversion happens once, here.
 *  3. **Dependency wiring** — the repository is resolved per call, never imported by the use
 *     cases, which is what keeps `@ses/application` free of any dependency on this app.
 *
 * ## Why the screens go through the use cases at all
 *
 * Because every rule they enforce is one the API enforces too. "A shadow member's number must
 * not already be recorded", "only an Admin may suspend", "your own row cannot be removed" —
 * all of it lives in `@ses/application`, shared by both callers (SAD §9.3). A screen that
 * called the API directly and re-derived a capability from a role string would be a second
 * implementation of the matrix, and the failure mode is a visible button over a refused
 * request.
 *
 * ## The viewer is read, not assumed
 *
 * `loadViewer` is the read the *other* operations stand on: each use case starts by loading
 * the caller's own membership, and over HTTP that is `GET /members/me`. Keeping it here rather
 * than in a store is what makes a *suspended* membership a real answer — the repository's
 * snapshot of the roster cannot distinguish it from a live one.
 */

/** `Result` → value, or throw. One place, so no screen ever inspects `.ok`. */
function unwrap<TValue>(result: Result<TValue, MemberError>): TValue {
  if (!result.ok) throw result.error;
  return result.value;
}

/**
 * What a screen may narrow the directory by — plain strings and enums, no branded ids.
 *
 * The conversion to the domain's `MemberQuery` happens here rather than in the screen: a
 * route parameter or a text field yields a `string`, and the branding is a fact about scope,
 * which the service is the right place to establish.
 */
export interface MemberDirectoryFilters {
  readonly q?: string | undefined;
  readonly role?: MemberRole | undefined;
  readonly status?: MemberStatus | undefined;
  readonly occupancy?: MemberOccupancy | undefined;
  /** Flats in this building only. */
  readonly buildingId?: string | null | undefined;
  readonly apartmentId?: string | null | undefined;
  readonly sort?: MemberSort | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

function toQuery(filters: MemberDirectoryFilters): MemberQuery {
  return {
    ...(filters.q === undefined || filters.q.trim().length === 0
      ? {}
      : { query: filters.q.trim() }),
    ...(filters.role === undefined ? {} : { role: filters.role }),
    ...(filters.status === undefined ? {} : { status: filters.status }),
    ...(filters.occupancy === undefined ? {} : { occupancy: filters.occupancy }),
    ...(filters.buildingId === undefined || filters.buildingId === null
      ? {}
      : { buildingId: asBuildingId(filters.buildingId) }),
    ...(filters.apartmentId === undefined || filters.apartmentId === null
      ? {}
      : { apartmentId: asApartmentId(filters.apartmentId) }),
    ...(filters.sort === undefined ? {} : { sort: filters.sort }),
    ...(filters.limit === undefined ? {} : { limit: filters.limit }),
    ...(filters.offset === undefined ? {} : { offset: filters.offset }),
  };
}

/** One page of the active society's directory, with the caller's capabilities. */
export async function loadMembers(
  actorId: string,
  societyId: string,
  filters: MemberDirectoryFilters = {},
): Promise<MemberDirectory> {
  return unwrap(
    await listMembersUseCase(
      memberDeps(),
      asUserId(actorId),
      asSocietyId(societyId),
      toQuery(filters),
    ),
  );
}

export async function loadMember(
  actorId: string,
  societyId: string,
  memberId: string,
): Promise<MemberDetail> {
  return unwrap(
    await getMemberUseCase(
      memberDeps(),
      asUserId(actorId),
      asSocietyId(societyId),
      asMemberId(memberId),
    ),
  );
}

/**
 * The caller's own membership — who am I in this society, and what may I do.
 *
 * The one read a member screen can make without an id of its own, which is why the member
 * *forms* use it: a create screen has no member to read, and inventing a second endpoint for
 * "may I write here" would be a permission check with its own implementation.
 */
export async function loadViewer(actorId: string, societyId: string): Promise<MemberDetail> {
  return unwrap(await getViewerUseCase(memberDeps(), asUserId(actorId), asSocietyId(societyId)));
}

/**
 * The write paths return a `MemberView`, not a `Member`.
 *
 * That is not a detail: a use case answers with the row *as this caller may see it*, so a
 * manager who just recorded somebody sees the contact details they typed. Declaring `Member`
 * here would drop `contactVisible` and leave the caller to guess whether a number was withheld
 * or absent — the one thing the domain added that field to prevent.
 */
export async function addMember(
  actorId: string,
  societyId: string,
  payload: CreateMemberPayload,
): Promise<MemberView> {
  const parsed = createMemberSchema.safeParse(payload);
  if (!parsed.success) {
    throw new MemberError('validation', firstIssueMessage(parsed.error), {
      field: parsed.error.issues[0]?.path.join('.') ?? 'displayName',
    });
  }

  const detail = unwrap(
    await addMemberUseCase(memberDeps(), asUserId(actorId), asSocietyId(societyId), parsed.data),
  );
  return detail.member;
}

export async function updateMember(
  actorId: string,
  societyId: string,
  memberId: string,
  patch: UpdateMemberPayload,
): Promise<MemberView> {
  const parsed = updateMemberSchema.safeParse(patch);
  if (!parsed.success) {
    throw new MemberError('validation', firstIssueMessage(parsed.error), {
      field: parsed.error.issues[0]?.path.join('.') ?? 'displayName',
    });
  }

  const detail = unwrap(
    await updateMemberUseCase(
      memberDeps(),
      asUserId(actorId),
      asSocietyId(societyId),
      asMemberId(memberId),
      parsed.data,
    ),
  );
  return detail.member;
}

/** Suspend a membership: the member stays on the roster and may not act. */
export async function suspendMember(
  actorId: string,
  societyId: string,
  memberId: string,
): Promise<MemberView> {
  const detail = unwrap(
    await suspendMemberUseCase(
      memberDeps(),
      asUserId(actorId),
      asSocietyId(societyId),
      asMemberId(memberId),
    ),
  );
  return detail.member;
}

export async function reactivateMember(
  actorId: string,
  societyId: string,
  memberId: string,
): Promise<MemberView> {
  const detail = unwrap(
    await reactivateMemberUseCase(
      memberDeps(),
      asUserId(actorId),
      asSocietyId(societyId),
      asMemberId(memberId),
    ),
  );
  return detail.member;
}

/** Soft removal. Admin-only, and the use case is what enforces that. */
export async function removeMember(
  actorId: string,
  societyId: string,
  memberId: string,
): Promise<void> {
  unwrap(
    await removeMemberUseCase(
      memberDeps(),
      asUserId(actorId),
      asSocietyId(societyId),
      asMemberId(memberId),
    ),
  );
}

function firstIssueMessage(error: ZodError): string {
  return error.issues[0]?.message ?? 'Please check the details and try again.';
}

/**
 * The join queue (T049) — everybody waiting to be admitted, with the claims on their flats.
 *
 * `member.approve`, not `member.view`: the use case is what refuses a Resident, so a screen
 * that reached here without the capability would be a visible screen over a refused request.
 * The claims travel with each row because *the server resolved them in the same statement as
 * the page* — matching flats from the pages a client happens to hold would show a collision
 * only when both rows were in one page, which is the bug the field exists to prevent.
 */
export async function loadJoinQueue(
  actorId: string,
  societyId: string,
  query: { readonly limit?: number | undefined; readonly offset?: number | undefined } = {},
): Promise<JoinQueue> {
  return unwrap(
    await listJoinRequestsUseCase(memberDeps(), asUserId(actorId), asSocietyId(societyId), query),
  );
}

/**
 * Admit a pending member.
 *
 * The payload is validated against the shared contract so a form error is a field error rather
 * than a rejected request, and only the fields the approver actually set are sent — an absent
 * field means "as requested" to the API, and spreading defaults here would overwrite the
 * requester's own declaration with the client's guess.
 */
export async function approveJoinRequest(
  actorId: string,
  societyId: string,
  memberId: string,
  input: JoinApprovalInput = {},
): Promise<MemberView> {
  const parsed = approveJoinRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new MemberError('validation', firstIssueMessage(parsed.error), {
      field: parsed.error.issues[0]?.path.join('.') ?? 'memberId',
    });
  }

  const detail = unwrap(
    await approveJoinRequestUseCase(
      memberDeps(),
      asUserId(actorId),
      asSocietyId(societyId),
      asMemberId(memberId),
      parsed.data,
    ),
  );
  return detail.member;
}

/**
 * Refuse a pending member, with the reason the requester is owed.
 *
 * The reason is validated against the contract first, so "no" is a field error on the form
 * rather than a 422 the user has to decode — and the same bound the database enforces.
 */
export async function rejectJoinRequest(
  actorId: string,
  societyId: string,
  memberId: string,
  reason: string,
): Promise<MemberView> {
  const parsed = rejectJoinRequestSchema.safeParse({ reason });
  if (!parsed.success) {
    throw new MemberError('validation', firstIssueMessage(parsed.error), {
      field: 'reason',
    });
  }

  const detail = unwrap(
    await rejectJoinRequestUseCase(
      memberDeps(),
      asUserId(actorId),
      asSocietyId(societyId),
      asMemberId(memberId),
      parsed.data.reason,
    ),
  );
  return detail.member;
}

/**
 * Error → copy the UI can render.
 *
 * `MemberError` messages are written for users and are rendered verbatim; anything else is an
 * unexpected failure and gets a safe generic line rather than a raw `Error.message` that could
 * name a table or a column.
 */
export function memberErrorMessage(error: unknown): string {
  if (isMemberError(error)) return error.message;
  return 'Something went wrong. Please try again.';
}
