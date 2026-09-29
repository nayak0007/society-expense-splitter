import type { MemberId, SocietyId } from "../shared/ids";
import type {
  MemberRole,
  MembershipStatus,
  SocietyMembership,
} from "../society/society";
import { isAction, grantKind } from "./permission-evaluator";
import type { Action } from "./permission-evaluator";
import { SCOPED_ACTIONS } from "./permission-evaluator";

/**
 * The resource half of authorisation — SAD §9.3's `canOnResource`.
 *
 * ## The two questions, and why one guard cannot answer both
 *
 * `can(role, action)` answers *may this role ever perform this action?* and is all
 * a guard can answer: a guard sees a role and an action, never a row. The PRD's
 * matrix has three kinds of cell (`✅ full · 🟡 own/assigned records only · ⬜
 * none`), and `can()` deliberately collapses the first two into `true`, because
 * encoding 🟡 as denial would refuse things the PRD plainly grants — a Committee
 * Member's own draft, a Resident closing their own complaint.
 *
 * This file restores the distinction for the six 🟡 cells, and nothing else. It
 * answers *may this member perform this action on **this** record?*
 *
 * ## It is a decision function, not a layer
 *
 * `canOnResource` does not replace authentication, `SocietyGuard`,
 * `PermissionGuard` or RLS, and it must not be used as if it did. The layered
 * order is unchanged and each stage may only narrow:
 *
 * ```
 * JWT authentication                                  (who is calling)
 *   → SocietyGuard          X-Society-Id → membership  (may they know this society exists)
 *     → PermissionGuard     can(role, action)          (may their role do this at all)
 *       → canOnResource     this record                (may they do it to *this* one)
 *         → application rules + database constraints   (is the change itself legal)
 *           → RLS                                      (which rows exist for this identity)
 * ```
 *
 * RLS remains the final database boundary and is not weakened, replaced or
 * bypassed by anything here: this function decides whether the application should
 * *try*, and the database still decides what it can see.
 *
 * ## Fail closed, in every direction
 *
 * Every unknown is a refusal rather than a default:
 *
 * - a membership that is not `active` — a pending, suspended or removed member
 *   holds no authority at all, whatever their role column says;
 * - a resource belonging to another society — the cross-tenant case, refused
 *   before any rule is consulted, and the reason the tenant is an explicit field
 *   rather than something a caller is trusted to have already checked;
 * - an action that is not in the matrix, or a snapshot whose `kind` the action's
 *   rule does not cover — a `true` here would be an authorisation nobody granted;
 * - a 🟡 action with **no** rule registered — the drift case, which must fail
 *   rather than fall through to "allowed".
 *
 * The one thing this deliberately does *not* decide is what a refusal looks like
 * over HTTP. `false` is a decision, not a status code: the caller maps it to the
 * answer that leaks least, which for a row it may not see is the established
 * 404-not-403 (PRD T041).
 */

// ─────────────────────────────────────────────────────────────────────────────
// The subject
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The caller, reduced to the facts authorisation depends on.
 *
 * A membership is the only place a role exists (PRD §2: one user may be a
 * Resident in one society and a Treasurer in another), so the subject is a
 * *membership*, and `societyId` is part of the subject rather than of the
 * question.
 *
 * Deliberately not a `SocietyMembership`: the entity carries a `userId`, an
 * occupancy, a join date and contact policy, none of which any rule reads. Passing
 * the aggregate would make every rule free to depend on a field the matrix never
 * mentions, and would tie an authorisation decision to a shape that changes for
 * unrelated product reasons.
 */
export interface MemberSnapshot {
  readonly membershipId: MemberId;
  readonly societyId: SocietyId;
  readonly role: MemberRole;
  readonly status: MembershipStatus;
}

/** The membership entity → the subject of a resource decision. */
export function memberSnapshotOf(
  membership: SocietyMembership,
): MemberSnapshot {
  return {
    membershipId: membership.id,
    societyId: membership.societyId,
    role: membership.role,
    status: membership.status,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The resource
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A resource, reduced to the facts its action's rule reads — nothing else.
 *
 * ## Why one union and not one interface per module
 *
 * Two requirements pull in opposite directions and this is where they meet. The
 * rules must be typed (a rule that reads `resource.assigneeMembershipId` on a
 * report is a bug, and a string-keyed bag would make it a runtime one), and the
 * set of resources must be **open** — the modules that own expenses, complaints,
 * reports and the audit log do not exist yet, and each will arrive with facts this
 * file cannot know.
 *
 * So the shape is a discriminated union: each variant declares its own facts, the
 * `kind` is the discriminator, and a rule switches on it exhaustively. Adding a
 * resource is adding one variant and one rule; TypeScript reports every switch that
 * has not been updated, which is the property that keeps this from decaying into
 * `any`.
 *
 * ## The variants that exist today are one field long, on purpose
 *
 * `society`, `building`, `apartment`, `member`, `invitation` and `join_request` are
 * shipped, and every one of them carries only its tenant. That is not an
 * oversight: none of them has a 🟡 cell in the matrix, so the *only* resource
 * question the architecture asks about them is the tenant one — and that question
 * is worth asking centrally, because "is this row in my society" is exactly the
 * check that must never be forgotten and never be answered `true` when the row
 * could not be loaded.
 *
 * ## The variants that do not exist yet carry only what the PRD's cell names
 *
 * `expense`, `complaint`, `report` and `audit` are here because their rules are
 * specified by PRD §2.1 and cannot be written without knowing which fact the cell
 * turns on:
 *
 * | Cell (PRD §2.1)                     | Fact the rule reads                |
 * | ----------------------------------- | ---------------------------------- |
 * | Create expense — 🟡 draft only      | `expense.published`                |
 * | Edit/delete expense — 🟡 own drafts | `expense.createdBy` + `published`  |
 * | Assign complaint — 🟡 to self       | `complaint.assignee`               |
 * | Resolve complaint — 🟡 assigned/own | `complaint.assignee` / `raisedBy`  |
 * | View reports — 🟡 summary           | `report.scope`                     |
 * | View audit log — 🟡 financial only  | `audit.category`                   |
 *
 * No aggregate, entity, table or repository is introduced for any of them, and no
 * field beyond those table rows is modelled. An expense's *amount*, a complaint's
 * *text* and a report's *period* are absent because no rule reads them — and a
 * snapshot that carried them would invite a rule to.
 */
export interface SocietyResourceSnapshot {
  readonly kind: "society";
  readonly societyId: SocietyId;
}

export interface BuildingResourceSnapshot {
  readonly kind: "building";
  readonly societyId: SocietyId;
}

export interface ApartmentResourceSnapshot {
  readonly kind: "apartment";
  readonly societyId: SocietyId;
}

export interface MemberResourceSnapshot {
  readonly kind: "member";
  readonly societyId: SocietyId;
}

export interface InvitationResourceSnapshot {
  readonly kind: "invitation";
  readonly societyId: SocietyId;
}

export interface JoinRequestResourceSnapshot {
  readonly kind: "join_request";
  readonly societyId: SocietyId;
}

/**
 * An expense, as authorisation sees it.
 *
 * `published` rather than a status union: the PRD's cells distinguish exactly two
 * states — a draft and everything else — and inventing `pending_approval`,
 * `rejected` or `voided` here would be modelling the expense module's state
 * machine in the permission layer, where no rule could use it.
 */
export interface ExpenseResourceSnapshot {
  readonly kind: "expense";
  readonly societyId: SocietyId;
  readonly createdByMembershipId: MemberId | null;
  readonly published: boolean;
}

export interface ComplaintResourceSnapshot {
  readonly kind: "complaint";
  readonly societyId: SocietyId;
  readonly assigneeMembershipId: MemberId | null;
  readonly raisedByMembershipId: MemberId | null;
}

export interface ReportResourceSnapshot {
  readonly kind: "report";
  readonly societyId: SocietyId;
  /** `summary` is the aggregate view the PRD grants a Resident; `society` is the whole. */
  readonly scope: "summary" | "society";
}

export interface AuditResourceSnapshot {
  readonly kind: "audit";
  readonly societyId: SocietyId;
  /** The Treasurer's 🟡 cell is "financial only"; an Admin's ✅ cell is not narrowed. */
  readonly category: "financial" | "other";
}

export type ResourceSnapshot =
  | SocietyResourceSnapshot
  | BuildingResourceSnapshot
  | ApartmentResourceSnapshot
  | MemberResourceSnapshot
  | InvitationResourceSnapshot
  | JoinRequestResourceSnapshot
  | ExpenseResourceSnapshot
  | ComplaintResourceSnapshot
  | ReportResourceSnapshot
  | AuditResourceSnapshot;

export type ResourceKind = ResourceSnapshot["kind"];

/** Every kind, in declaration order — used by tests to assert full coverage. */
export const RESOURCE_KINDS = [
  "society",
  "building",
  "apartment",
  "member",
  "invitation",
  "join_request",
  "expense",
  "complaint",
  "report",
  "audit",
] as const satisfies readonly ResourceKind[];

/** Narrowing helper for a `kind` that arrived from outside the type system. */
export function isResourceKind(value: unknown): value is ResourceKind {
  return (
    typeof value === "string" &&
    (RESOURCE_KINDS as readonly string[]).includes(value)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The narrowing rules
// ─────────────────────────────────────────────────────────────────────────────

type NarrowingRule = (
  member: MemberSnapshot,
  resource: ResourceSnapshot,
) => boolean;

interface ScopedActionRule {
  /** The resource the rule reads. A snapshot of another kind fails closed. */
  readonly kind: ResourceKind;
  /** The PRD cell, quoted, so a rule can be checked against its source. */
  readonly cell: string;
  readonly narrows: NarrowingRule;
}

/**
 * The six 🟡 cells of PRD §2.1, one rule each.
 *
 * These are reachable **only** when `grantKind(role, action)` is `"scoped"`: a ✅
 * holder never arrives here, because their grant needs no narrowing. That is what
 * keeps `admin ✅` and `committee 🟡` from needing a special case — the cell the
 * member holds decides whether a rule applies at all.
 *
 * Where a cell carries two different qualifiers for two roles — `complaint.resolve`
 * is 🟡 *assigned* for a Committee Member and 🟡 *own (close)* for a Resident — the
 * rule is per-role, because the cells are. Folding them into one disjunction would
 * grant a Committee Member the close-own path the PRD does not give them.
 *
 * `SCOPED_RULES` is keyed by the scoped actions and is asserted to cover
 * `SCOPED_ACTIONS` exactly by `__tests__/resource-authorization.test.ts`: adding a
 * 🟡 cell to the matrix without a rule fails the build rather than falling through
 * to a silent refusal-or-permit.
 */
const SCOPED_RULES = {
  // "Create expense | ✅ | ✅ | 🟡 (draft only) | ⬜ | ⬜ | ⬜"
  // The record does not exist yet, so the snapshot is the one the caller is about
  // to write — which is the only way a create-time conditional is expressible, and
  // why the rule reads the *intended* state rather than a stored one.
  "expense.create": {
    kind: "expense",
    cell: "Create expense — Committee Member: 🟡 (draft only)",
    narrows: (_member, resource) =>
      resource.kind === "expense" && !resource.published,
  },

  // "Edit/delete expense | ✅ | ✅ | 🟡 own drafts | ⬜ | ⬜ | ⬜"
  "expense.void": {
    kind: "expense",
    cell: "Edit/delete expense — Committee Member: 🟡 own drafts",
    narrows: (member, resource) =>
      resource.kind === "expense" &&
      !resource.published &&
      resource.createdByMembershipId === member.membershipId,
  },

  // "Assign complaint | ✅ | ⬜ | 🟡 to self | ⬜ | ⬜ | ⬜"
  // The decision is about the outcome: the complaint is assignable when the
  // assignment leaves it with the caller.
  "complaint.assign": {
    kind: "complaint",
    cell: "Assign complaint — Committee Member: 🟡 to self",
    narrows: (member, resource) =>
      resource.kind === "complaint" &&
      resource.assigneeMembershipId === member.membershipId,
  },

  // "Resolve complaint | ✅ | ⬜ | 🟡 assigned | 🟡 own (close) | 🟡 own (close) | ⬜"
  "complaint.resolve": {
    kind: "complaint",
    cell: "Resolve complaint — Committee Member: 🟡 assigned; Resident/Tenant: 🟡 own (close)",
    narrows: (member, resource) => {
      if (resource.kind !== "complaint") {
        return false;
      }
      if (member.role === "committee_member") {
        return resource.assigneeMembershipId === member.membershipId;
      }
      return resource.raisedByMembershipId === member.membershipId;
    },
  },

  // "View reports (society-wide) | ✅ | ✅ | ✅ | 🟡 summary | 🟡 summary | ⬜"
  // The 🟡 is on *what is shown*, not on which report: a Resident sees the
  // aggregate view, never the society-wide one, and never the defaulter names
  // PRD §6 gates by the same row.
  "report.view_all": {
    kind: "report",
    cell: "View reports (society-wide) — Resident/Tenant: 🟡 summary",
    narrows: (_member, resource) =>
      resource.kind === "report" && resource.scope === "summary",
  },

  // "View audit log | ✅ | 🟡 financial only | ⬜ | ⬜ | ⬜ | ⬜"
  "audit.view": {
    kind: "audit",
    cell: "View audit log — Treasurer: 🟡 financial only",
    narrows: (_member, resource) =>
      resource.kind === "audit" && resource.category === "financial",
  },
} as const satisfies Partial<Record<Action, ScopedActionRule>>;

/** The scoped actions this module has a rule for, for drift tests and docs. */
export const NARROWED_ACTIONS = Object.keys(
  SCOPED_RULES,
) as readonly (keyof typeof SCOPED_RULES)[];

/** The rule registered for an action, or `undefined` when there is none. */
export function narrowingRuleFor(action: Action): ScopedActionRule | undefined {
  return (SCOPED_RULES as Partial<Record<Action, ScopedActionRule>>)[action];
}

// ─────────────────────────────────────────────────────────────────────────────
// The decision
// ─────────────────────────────────────────────────────────────────────────────

/**
 * May `member` perform `action` on `resource`?
 *
 * The checks run outermost-in, and the order is deliberate: the subject's own
 * standing is decided before anything about the record, so an inactive member gets
 * `false` without the caller having had to load a resource at all.
 *
 * A `true` answer means "no rule in the matrix forbids this". It is **not** a
 * statement that the change is legal — capacity caps, self-change refusals and the
 * "a society keeps an active Admin" invariant are the domain's own rules and are
 * enforced where they already are. Layers narrow; they do not substitute.
 */
export function canOnResource(
  member: MemberSnapshot,
  action: Action,
  resource: ResourceSnapshot,
): boolean {
  // 1 · The subject must be able to act at all. Folded in here rather than trusted
  //     to the caller: this function is reachable from a use case invoked outside
  //     the HTTP pipeline, where no guard has run.
  if (member.status !== "active") {
    return false;
  }

  // 2 · The record must belong to the society the member belongs to. Before any
  //     rule, because a rule that reads ownership would otherwise be answering a
  //     question about a row in someone else's tenant. Defensive on the way in:
  //     the value may arrive from an untyped boundary, and a resource whose tenant
  //     cannot be established is refused rather than assumed to match.
  if (
    !isResourceKind(resource.kind) ||
    resource.societyId !== member.societyId
  ) {
    return false;
  }

  // 3 · The matrix decides whether there is anything more to ask.
  if (!isAction(action)) {
    return false;
  }

  const grant = grantKind(member.role, action);
  if (grant === "none") {
    return false;
  }
  if (grant === "full") {
    return true;
  }

  // 4 · A 🟡 grant: the record decides. An action the matrix marks conditional
  //     with no rule registered fails closed — the alternative is a silent permit
  //     for every scoped cell somebody forgets.
  if (!SCOPED_ACTIONS.has(action)) {
    // Unreachable: `grantKind` returns `scoped` only for a cell built from
    // `scoped`. Kept because the two derive from the same table by different
    // routes and a future edit could decouple them.
    return false;
  }

  const rule = narrowingRuleFor(action);
  return rule === undefined ? false : rule.narrows(member, resource);
}
