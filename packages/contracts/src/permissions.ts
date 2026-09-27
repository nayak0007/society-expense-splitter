import { ACTIONS, MEMBER_ROLES } from "@ses/domain";
import { z } from "zod";

import { memberCapabilitiesSchema } from "./member";

/**
 * Roles and permissions on the wire (T046; SAD §9.3, PRD §2.1).
 *
 * ## What is deliberately missing: any way to *write* a permission
 *
 * The contract can name a role and it can list the actions a role holds, but there is no schema
 * in which a caller sends a permission. Grants are a fixed role→action matrix in
 * `@ses/domain/member/permission-evaluator.ts`, mirrored by RLS, and `assignRoleSchema` below is
 * the only write in the file — a role, never an action. That asymmetry is the security property
 * the module rests on: a client cannot widen a role's powers by asking for one, because there is
 * no field to ask with.
 *
 * ## The action vocabulary is imported, not restated
 *
 * `ACTIONS` is the evaluator's own union — the same list the guard validates against and the
 * conformance test walks. A second copy here would be a schema that accepts an action the server
 * has never heard of, and the failure would surface as a `500` from `PermissionGuard`'s
 * "does not exist" path rather than as a `400` naming the field.
 */
export const actionSchema = z.enum(ACTIONS);
export type ActionDto = z.infer<typeof actionSchema>;

export const roleSchema = z.enum(MEMBER_ROLES);
export type RoleDto = z.infer<typeof roleSchema>;

/** One role and everything it may ever do — `RoleDefinition` in the domain. */
export const roleDefinitionSchema = z.object({
  role: roleSchema,
  /**
   * The action list is **not** paginated, sorted or filtered server-side: it is a fixed set of
   * at most 32 strings per role, computed in memory from the matrix, and a client that wants it
   * alphabetised can sort it. Sending it whole is what lets one response serve both the
   * permissions viewer and a role picker's copy.
   */
  permissions: z.array(actionSchema),
});
export type RoleDefinitionDto = z.infer<typeof roleDefinitionSchema>;

/**
 * `GET /permissions` — every role, in PRD §2.1's order, plus the caller's capabilities.
 *
 * The capabilities travel with it for the same reason they travel with the member list: a screen
 * that renders a role picker has to know whether *this* caller may use it, and asking a second
 * endpoint for that would be a second answer to one question.
 */
export const permissionCatalogueResponseSchema = z.object({
  roles: z.array(roleDefinitionSchema),
  capabilities: memberCapabilitiesSchema,
});
export type PermissionCatalogueResponseDto = z.infer<
  typeof permissionCatalogueResponseSchema
>;

/**
 * One membership's effective permissions — `GET /permissions/me`, and the same shape for
 * another member when an Admin asks (`GET /permissions/members/:memberId`).
 *
 * `role` and `permissions` are both present and always consistent, which is the point: the
 * permissions are `actionsFor(role)`, so a client never has to reconstruct the matrix to explain
 * what it was told. `memberId` is the *membership* id, not a user id — the same identifier every
 * other member route uses, because roles belong to memberships (PRD §2).
 */
export const memberPermissionsResponseSchema = z.object({
  memberId: z.string(),
  role: roleSchema,
  permissions: z.array(actionSchema),
  capabilities: memberCapabilitiesSchema,
});
export type MemberPermissionsResponseDto = z.infer<
  typeof memberPermissionsResponseSchema
>;

/**
 * The role write body — `PATCH /members/:memberId/role`.
 *
 * Strict, and one field: an unknown key is a caller mistake worth reporting rather than something
 * to ignore (SAD §7.8 stage 1), and there is exactly one thing this endpoint changes. Revocation
 * is `DELETE /members/:memberId/role`, which demotes to `resident` (PRD §2.3's "Admin revokes")
 * and therefore needs no body at all — a body with a role in it would let a caller spell
 * "revoke" as "assign resident" while the two differ in copy, and in what an audit entry would
 * say.
 */
export const assignRoleSchema = z.strictObject({
  role: roleSchema,
});
export type AssignRolePayload = z.infer<typeof assignRoleSchema>;

/**
 * The response to a role write: the membership's new role and the permissions it now holds.
 *
 * The full `memberPermissionsResponseSchema` rather than a bare `{ role }`, so a screen that just
 * changed a role can re-render the permission list from the response itself instead of
 * invalidating a query and waiting — and so the answer the user sees is the server's, not the
 * optimistic guess.
 */
export const assignRoleResponseSchema = memberPermissionsResponseSchema;
export type AssignRoleResponseDto = z.infer<typeof assignRoleResponseSchema>;
