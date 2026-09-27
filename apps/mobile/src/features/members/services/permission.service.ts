import {
  assignMemberRole as assignMemberRoleUseCase,
  getMemberPermissions as getMemberPermissionsUseCase,
  listMyPermissions as listMyPermissionsUseCase,
  listRoles as listRolesUseCase,
  revokeMemberRole as revokeMemberRoleUseCase,
} from '@ses/application';
import type { MemberPermissionsView, RoleCatalogue } from '@ses/application';
import { assignRoleSchema } from '@ses/contracts';
import { asMemberId, asSocietyId, asUserId, MemberError } from '@ses/domain';
import type { MemberRole, Result } from '@ses/domain';
import type { ZodError } from 'zod';

import { memberDeps } from '../repository/member.deps';

/**
 * Roles and permissions service (T046) — the app's adapter over the role use cases.
 *
 * The same three responsibilities `member.service.ts` holds, in the same order: validate the
 * wire shape against the shared contract, unwrap `Result` into a throw, and resolve the
 * repository per call so `@ses/application` stays free of any dependency on this app.
 *
 * ## Why these go through the use cases rather than straight to the API
 *
 * Every rule a screen would otherwise re-derive is in `@ses/application` already: the caps, the
 * self-change refusal, the target's status, the last-admin check, and the fold that gives a
 * suspended membership an empty permission list. The API enforces the same rules again — a client
 * that reached past them would meet a refusal it cannot explain; a client that goes through them
 * gets the sentence before the request.
 *
 * ## `assignMemberRole` validates the role before it leaves the device
 *
 * `assignRoleSchema` is the same schema the API's `ZodPipe` runs, so a role the deployed server
 * does not know is a local validation error attached to the field rather than a 400 from a round
 * trip. That is not a substitute for the server's check — it is the contract's whole purpose:
 * both sides validate the same rules, one of them just does it first.
 */

/** `Result` → value, or throw. One place, so no screen ever inspects `.ok`. */
function unwrap<TValue>(result: Result<TValue, MemberError>): TValue {
  if (!result.ok) throw result.error;
  return result.value;
}

function firstIssueMessage(error: ZodError): string {
  return error.issues[0]?.message ?? 'Choose a valid role.';
}

/**
 * The role catalogue: every role with everything it may ever do.
 *
 * Read from `member.view`, like the directory — the catalogue is the society's public policy, not
 * a secret, and a screen that explains why a button is missing has to be readable by the people
 * the button is missing for.
 */
export async function loadRoles(actorId: string, societyId: string): Promise<RoleCatalogue> {
  return unwrap(await listRolesUseCase(memberDeps(), asUserId(actorId), asSocietyId(societyId)));
}

/** The caller's own effective permissions — the one read with no subject but the token. */
export async function loadMyPermissions(
  actorId: string,
  societyId: string,
): Promise<MemberPermissionsView> {
  return unwrap(
    await listMyPermissionsUseCase(memberDeps(), asUserId(actorId), asSocietyId(societyId)),
  );
}

/** One member's effective permissions — the member themselves, or an Admin. */
export async function loadMemberPermissions(
  actorId: string,
  societyId: string,
  memberId: string,
): Promise<MemberPermissionsView> {
  return unwrap(
    await getMemberPermissionsUseCase(
      memberDeps(),
      asUserId(actorId),
      asSocietyId(societyId),
      asMemberId(memberId),
    ),
  );
}

/** Assign or change a member's role. Returns the permissions the new role holds. */
export async function assignMemberRole(
  actorId: string,
  societyId: string,
  memberId: string,
  role: MemberRole,
): Promise<MemberPermissionsView> {
  const parsed = assignRoleSchema.safeParse({ role });
  if (!parsed.success) {
    throw new MemberError('validation', firstIssueMessage(parsed.error), {
      field: 'role',
    });
  }

  return unwrap(
    await assignMemberRoleUseCase(
      memberDeps(),
      asUserId(actorId),
      asSocietyId(societyId),
      asMemberId(memberId),
      parsed.data.role,
    ),
  );
}

/**
 * Revoke a member's role — the membership returns to `resident` (PRD §2.3's "Admin revokes").
 *
 * No body and no role argument: revocation is its own operation, and a screen that spelled it as
 * "assign resident" would be describing a governance act as a field value.
 */
export async function revokeMemberRole(
  actorId: string,
  societyId: string,
  memberId: string,
): Promise<MemberPermissionsView> {
  return unwrap(
    await revokeMemberRoleUseCase(
      memberDeps(),
      asUserId(actorId),
      asSocietyId(societyId),
      asMemberId(memberId),
    ),
  );
}
