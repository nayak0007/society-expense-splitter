import {
  canOnResource,
  type MemberSnapshot,
} from "../member/resource-authorization";
import { AUDIT_CATEGORIES } from "./audit";
import type { AuditCategory } from "./audit";

/**
 * Which halves of the audit log a member may read — Roadmap T050 Stage E1.
 *
 * ## It asks the matrix, rather than comparing a role
 *
 * PRD §2.1's cell is "View audit log — ✅ Admin, 🟡 Treasurer financial only", and
 * the 🟡 is a *category* narrowing rather than a resource-ownership one. That is
 * exactly the shape `canOnResource` already handles for `audit.view`
 * (`packages/domain/src/member/resource-authorization.ts`): the rule registered for
 * the action answers `resource.category === "financial"` for a Treasurer and `true`
 * for an Admin.
 *
 * So this function does not ask "is the role a treasurer" — it enumerates the two
 * categories and asks the evaluator about each, which means:
 *
 *  - there is no second spelling of the matrix anywhere (a `role === "treasurer"`
 *    written here would be the copy no conformance test enumerates);
 *  - an inactive membership is refused by `canOnResource` itself, so a pending,
 *    suspended or removed member sees nothing even though their `role` column may
 *    still say `admin`;
 *  - a society given in the subject (rather than a second argument) is what makes
 *    the cross-tenant case structurally impossible: `canOnResource` refuses a
 *    resource whose `societyId` differs from the subject's before any rule runs.
 *
 * ## The result is the *query filter*, and the database independently agrees
 *
 * The returned list is what the read pushes into SQL (`category = ANY(...)`), and it
 * is deliberately not a post-filter: filtering after the fetch would either return
 * short pages (breaking the cursor contract) or read rows the caller may not see into
 * the process. The `audit_logs_select_authorized` policy narrows the same way
 * (`public.can_view_audit`), so the two layers answer identically — the application
 * decides which pages exist, and RLS decides which rows do.
 *
 * An empty list is a real answer, not an error: it means the membership holds no
 * view grant at all. `PermissionGuard` refuses that caller before the handler
 * (403), so over HTTP it is unreachable; the read path still refuses on it rather
 * than querying with an empty filter, which would be a read of everything.
 */
export function auditVisibleCategories(
  member: MemberSnapshot,
): readonly AuditCategory[] {
  return AUDIT_CATEGORIES.filter((category) =>
    canOnResource(member, "audit.view", {
      kind: "audit",
      societyId: member.societyId,
      category,
    }),
  );
}

/** One wording for the refusal, so the API and any other caller cannot drift. */
export const AUDIT_VIEW_REASON =
  "Your role in this society cannot view its audit log.";
