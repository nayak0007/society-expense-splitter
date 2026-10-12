import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { DiscoveryService, MetadataScanner } from "@nestjs/core";
import { RequestMethod } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { AUDIT_ACTIONS, isAction, SCOPED_ACTIONS } from "@ses/domain";
import type { Action } from "@ses/domain";

import { IS_PUBLIC_KEY } from "../src/common/decorators/public.decorator";
import { REQUIRE_PERMISSION_KEY } from "../src/common/decorators/require-permission.decorator";
import { AUDITED_ACTIONS } from "../src/modules/audit/audited.decorator";
import { createTestApp } from "./utils/test-app";

/**
 * The route inventory SAD §17.3 asks for — the test T038 deferred.
 *
 * ## Why it was deferred, and why it is meaningful now
 *
 * T038's note says the test "becomes meaningful once the first header-scoped
 * module exists", because enforcing it earlier would have meant annotating the
 * path-scoped society routes, which are addressed by `:societyId` and have no
 * header for a membership to be resolved from. That is still true of those routes
 * — and it is exactly why the exemption list below is explicit rather than the
 * rule being weakened.
 *
 * What changed is the size of the surface that *is* header-scoped: structure,
 * members, roles, invitations and join requests all declare permissions now. A
 * route added to any of them without one is a hole that nothing else in the
 * project would report, which is the failure this file exists to make loud.
 *
 * ## What it reads, and why not a hand-written list
 *
 * The inventory comes from the running application's own container
 * (`DiscoveryService` over the controllers `AppModule` registered) and from the
 * framework's own handler metadata, not from a list in this file. A controller
 * nobody remembered to add to a list is precisely the controller this test has to
 * catch, so a hand-maintained inventory would be self-defeating.
 *
 * ## The four properties
 *
 * 1. **Every route is deliberately reachable.** It declares a permission, or it
 *    is `@Public()` with a documented reason, or it is one of the two path-scoped
 *    families listed below. Anything else fails.
 * 2. **Every declared permission exists.** A typo would otherwise be a permanent
 *    403 that reads like a role problem.
 * 3. **No route declares a conditional (🟡) action without a narrowing site.**
 *    The matrix's own docstring says passing `@RequirePermission` for a scoped
 *    action "is not authorisation on its own"; this is that sentence, executable.
 * 4. **The exemption list does not rot.** An exemption that matches no route fails
 *    the test, so removing a route removes its entry.
 */

type RouteEntry = {
  readonly controller: string;
  readonly handler: string;
  readonly method: string;
  readonly path: string;
  readonly permission: string | undefined;
  readonly isPublic: boolean;
  /** The actions this route declared with `@Audited()`, in declaration order. */
  readonly audited: readonly string[];
};

/** The verbs that change state — the ones an audit declaration is judged on. */
const WRITE_VERBS: ReadonlySet<string> = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

/**
 * Write-verb routes that must declare the audit actions they record — T050 Stage B.
 *
 * ## Why this shape, and not "the interceptor writes the row"
 *
 * An interceptor taps **after** the handler, so a write there could only be
 * best-effort — the business transaction has already committed (ADR-0014 D7). The
 * row is therefore written by the operation itself, through `UnitOfWork`'s audit
 * seam. What a static test *can* pin is that no mutation route ships without
 * saying which actions it records, and that the actions it names are the ones the
 * manifest expects — so a new route, or a route whose integration is dropped,
 * fails here rather than silently producing an empty log.
 *
 * The durable-row half of the claim is the integration suite's
 * (`test/integration/audit-logs.integration-spec.ts`), which asserts the persisted
 * rows in real SQL. This file asserts the *declaration*, which is the half a unit
 * test can see.
 */
const MANDATED_AUDIT: ReadonlyMap<string, readonly string[]> = new Map([
  // ── expenses: the financial lifecycle (Stage B group 1) ──────────────────
  ["ExpensesController POST /expenses", ["expense.created"]],
  // One route, two actions: a PATCH of a draft is an edit, and of a published
  // row is a recalculation (T068).
  [
    "ExpensesController PATCH /expenses/:expenseId",
    ["expense.updated", "expense.recalculated"],
  ],
  ["ExpensesController DELETE /expenses/:expenseId", ["expense.deleted"]],
  [
    "ExpensesController POST /expenses/:expenseId/publish",
    ["expense.published"],
  ],
  ["ExpensesController POST /expenses/:expenseId/void", ["expense.voided"]],
  [
    "ExpensesController POST /expenses/:expenseId/approve",
    ["expense.approved"],
  ],
  ["ExpensesController POST /expenses/:expenseId/reject", ["expense.rejected"]],

  // ── members (Stage B group 2) ───────────────────────────────────────────
  ["MembersController POST /members", ["member.created"]],
  ["MembersController POST /members/import", ["member.created"]],
  [
    "MembersController POST /members/join-requests/:memberId/approve",
    ["member.join_approved"],
  ],
  [
    "MembersController POST /members/join-requests/:memberId/reject",
    ["member.join_rejected"],
  ],
  ["MembersController PATCH /members/:memberId", ["member.updated"]],
  ["MembersController POST /members/:memberId/suspend", ["member.suspended"]],
  [
    "MembersController POST /members/:memberId/reactivate",
    ["member.reactivated"],
  ],
  ["MembersController PATCH /members/:memberId/role", ["member.role_assigned"]],
  ["MembersController DELETE /members/:memberId/role", ["member.role_revoked"]],
  ["MembersController DELETE /members/:memberId", ["member.removed"]],

  // ── invitations (Stage B group 3) ───────────────────────────────────────
  ["InvitationsController POST /invitations", ["invitation.created"]],
  [
    "InvitationsController POST /invitations/:invitationId/revoke",
    ["invitation.revoked"],
  ],
  // The acceptance RPC clears the transaction's identity; `UnitOfWork` re-establishes
  // the actor for the audit phase, so the row is written as the accepting user and
  // keyed to the membership the function produced (ADR-0014 D5/D10).
  [
    "InvitationsController POST /invitations/accept/:token",
    ["invitation.accepted"],
  ],

  // ── structure (Stage B group 4a) ────────────────────────────────────────
  ["BuildingsController POST /buildings", ["building.created"]],
  ["BuildingsController PATCH /buildings/:buildingId", ["building.updated"]],
  ["BuildingsController DELETE /buildings/:buildingId", ["building.deleted"]],
  [
    "BuildingApartmentsController POST /buildings/:buildingId/apartments",
    ["apartment.created"],
  ],
  [
    "BuildingApartmentsController POST /buildings/:buildingId/apartments/generate",
    ["apartment.created"],
  ],
  [
    "BuildingApartmentsController POST /buildings/:buildingId/apartments/bulk",
    ["apartment.created"],
  ],
  [
    "ApartmentsController PATCH /apartments/:apartmentId",
    ["apartment.updated"],
  ],
  [
    "ApartmentsController DELETE /apartments/:apartmentId",
    ["apartment.deleted"],
  ],
]);

/**
 * Write-verb routes that record no audit row **yet**, each with the reason.
 *
 * Two different reasons live here, and keeping them distinguishable is the point:
 *
 *  - **not a mutation** — the route only computes or validates (`preview-split`,
 *    `import/preview`), so there is no business change for an audit row to sit
 *    beside;
 *  - **Stage B coverage still outstanding** — the module's adapters have not been
 *    integrated yet. These are the remaining groups named by T050's own status
 *    block, and this list is the machine-readable form of that gap: the entry
 *    disappears in the same change that wires the module up.
 */
const AUDIT_DEFERRED: ReadonlyMap<string, string> = new Map([
  // ── not mutations ───────────────────────────────────────────────────────
  [
    "ExpensesController POST /expenses/preview-split",
    "Computes a preview from the persisted row and writes nothing (T064).",
  ],
  [
    "MembersController POST /members/import/preview",
    "Validates a CSV and reports per row; membership state is untouched (T048).",
  ],

  // ── Stage B coverage outstanding ────────────────────────────────────────
  [
    "ExpensesController POST /expenses/:expenseId/comments",
    "remaining Stage B group 5 (expense sub-resources)",
  ],
  [
    "ExpensesController DELETE /expenses/:expenseId/comments/:commentId",
    "remaining Stage B group 5 (expense sub-resources)",
  ],
  [
    "ExpensesController PUT /expenses/:expenseId/gst",
    "remaining Stage B group 5 (expense sub-resources)",
  ],
  [
    "ExpenseCategoriesController POST /expense-categories",
    "remaining Stage B group 5 (expense sub-resources)",
  ],
  [
    "ExpenseCategoriesController PATCH /expense-categories/:categoryId",
    "remaining Stage B group 5 (expense sub-resources)",
  ],
  [
    "ExpenseCategoriesController DELETE /expense-categories/:categoryId",
    "remaining Stage B group 5 (expense sub-resources)",
  ],
  [
    "AttachmentsController POST /expenses/:expenseId/attachments",
    "remaining Stage B group 5 (attachments)",
  ],
  [
    "AttachmentsController POST /attachments/:attachmentId/complete",
    "remaining Stage B group 5 (attachments)",
  ],
  [
    "AttachmentsController DELETE /attachments/:attachmentId",
    "remaining Stage B group 5 (attachments)",
  ],
  [
    "SocietiesController POST /societies",
    "remaining Stage B group 4b (society lifecycle)",
  ],
  [
    "SocietiesController POST /societies/join",
    "remaining Stage B group 4b (society lifecycle)",
  ],
  [
    "SocietiesController PATCH /societies/:societyId",
    "remaining Stage B group 4b (society lifecycle)",
  ],
  [
    "SocietiesController POST /societies/:societyId/join-code",
    "remaining Stage B group 4b (society lifecycle)",
  ],
  [
    "SocietiesController POST /societies/:societyId/leave",
    "remaining Stage B group 4b (society lifecycle)",
  ],
  [
    "SocietiesController DELETE /societies/:societyId",
    "remaining Stage B group 4b (society lifecycle)",
  ],
]);

/**
 * Routes that are deliberately **not** governed by a declared permission.
 *
 * Each is an address shape rather than an omission, and the distinction is the
 * one SAD §9.4 draws: the society guards are inert unless a route declares a
 * permission, because an action is a per-*membership* grant and a route that names
 * one is by definition header-scoped. These routes are addressed by
 * `:societyId` in the path, and they reach the database under RLS alone (stage 6)
 * with the use case's own membership resolution in between — the arrangement the
 * architecture records for them deliberately, not a gap.
 *
 * Keep this list short and justified. An entry here says "this route's
 * authorisation is enforced somewhere other than the guard chain", so adding one
 * is a design decision and should read like it.
 */
const PATH_SCOPED_EXEMPTIONS: readonly string[] = [
  // ── the society module, addressed by a path parameter ──────────────────────
  // Roadmap T040's routes. Their authorisation is the guard-bypassed 404-before-403
  // in the use cases plus RLS, and they predate the header convention: moving them
  // to `X-Society-Id` would change published addresses to buy a declaration that
  // would say the same thing. Their `/societies/lookup` sibling is not listed here
  // because it is `@Public()` — a different reason, and the decorator is where it
  // is recorded.
  "SocietiesController GET /societies",
  "SocietiesController GET /societies/:societyId",
  "SocietiesController PATCH /societies/:societyId",
  "SocietiesController DELETE /societies/:societyId",
  "SocietiesController POST /societies",
  "SocietiesController POST /societies/:societyId/join-code",
  "SocietiesController POST /societies/:societyId/leave",
  "SocietiesController POST /societies/join",
  "SocietiesController GET /societies/:societyId/members",

  // ── authenticated routes that resolve no society, so no permission applies ──
  // These are not omissions and not `@Public()`: the caller is verified, and there
  // is simply no membership for a permission to be a grant *on*. Declaring one
  // would require inventing a society context the call does not have.
  //
  // The caller's own memberships, across every society they belong to — the screen
  // a user with no society yet sees. There is no society to resolve.
  "SocietiesController GET /societies/memberships",
  // Resolved by a join *code*, for somebody who is not a member yet — the same
  // state the invite acceptance below is in. Deliberately not part of the public
  // lookup: the contract is "name, city and member count only", and listing a
  // society's flats publicly would let anyone with a shared code map the building.
  "SocietiesController GET /societies/join-options",
  // Acceptance: a verified JWT is required and there is no permission to declare,
  // because a permission is a grant on a membership the caller does not have yet —
  // that is the point of accepting one. The actor comes from the token and the
  // definer function compares it against `auth.uid()` itself.
  "InvitationsController POST /invitations/accept/:token",
];

/** Route shape → the string the lists above are keyed by. */
const keyOf = (entry: RouteEntry): string =>
  `${entry.controller} ${entry.method} /${entry.path}`;

/**
 * Routes whose declared action is conditional, with the site that narrows it.
 *
 * Each entry names a 🟡 route and the use case that calls `canOnResource` — so that
 * adding the route and adding the narrowing site are the same change, and a scoped
 * grant can never ship as a bare permission declaration.
 */
const NARROWED_ROUTES: readonly string[] = [
  // T064's preview. `expense.create` is Admin/Treasurer full and Committee Member
  // *draft only*; `PreviewSplitUseCase.preview` narrows it against the record the
  // caller is composing (`kind: "expense", published: false`) before resolving
  // anyone, which is exactly the draft the 🟡 cell is about.
  "ExpensesController POST /expenses/preview-split",
  // T065's create. The same 🟡 cell and the same narrowing: the record about to be
  // written is a draft (`CreateExpenseUseCase.create`), and the threshold rule — not
  // the caller — is the only thing that can move it to pending_approval.
  "ExpensesController POST /expenses",
  // T065's edit. `expense.void` is Admin/Treasurer full and Committee Member on
  // *their own drafts*; `UpdateExpenseUseCase.update` narrows against the stored row's
  // snapshot (`snapshotOf`), where `pending_approval` is deliberately not a draft.
  "ExpensesController PATCH /expenses/:expenseId",
  // T065's delete. The same 🟡 cell, narrowed the same way — and then narrowed again
  // to the creator, which is the Roadmap's own sentence ("hard-deletable by their
  // creator only").
  "ExpensesController DELETE /expenses/:expenseId",
  // T069's void. The same 🟡 cell, narrowed against the stored row's snapshot
  // (`snapshotOf`): `expense.void` is Admin/Treasurer full and Committee Member on
  // *their own drafts*, and `VoidExpenseUseCase` calls `canOnResource` with the
  // persisted row, whose `published` flag is what refuses the Committee Member — a
  // draft is not voidable at all, so their grant cannot reach a published bill.
  "ExpensesController POST /expenses/:expenseId/void",

  // T071's presign. Attachments introduce **no** permission of their own (ADR-0012
  // D5): the upload reuses `expense.create` — Admin/Treasurer full, Committee Member
  // *draft only* — and `PresignUploadUseCase.presign` narrows it with `canOnResource`
  // against the **stored** expense (`snapshotOf`, where a `pending_approval` or
  // `published` expense is not a draft), after the D6.1 lifecycle gate refuses a
  // `void` one for everybody.
  "AttachmentsController POST /expenses/:expenseId/attachments",
  // T071's completion. The same cell and the same narrowing, re-read from the row
  // rather than trusted from the URL: the parent expense is loaded again (it may have
  // been voided while the upload was in flight) and the same `canOnResource` site
  // decides, so a Committee Member cannot complete an upload against somebody else's
  // expense by holding the attachment id.
  "AttachmentsController POST /attachments/:attachmentId/complete",
  // T071's delete. `expense.void`'s cell — Admin/Treasurer full, Committee Member on
  // *their own drafts* — narrowed against the persisted expense, **plus** ADR-0012
  // D6.4's uploader branch, which is a narrower grant than the cell rather than a
  // wider one: the uploader may remove their own row whatever the role cell says.
  "AttachmentsController DELETE /attachments/:attachmentId",

  // T072's GST upsert. `expense.create`'s cell — Admin/Treasurer full, Committee
  // Member *draft only* — and `UpsertGstDetailsUseCase.upsert` narrows it with
  // `canOnResource` against the stored expense (`snapshotOf`, where a
  // `pending_approval` or `published` expense is not a draft) after refusing a
  // `void` one for everybody (D4). No `gst.*` permission exists (D3).
  "ExpensesController PUT /expenses/:expenseId/gst",
];

async function collectRoutes(
  app: NestFastifyApplication,
): Promise<readonly RouteEntry[]> {
  const discovery = app.get(DiscoveryService);
  const scanner = app.get(MetadataScanner);
  const entries: RouteEntry[] = [];

  for (const wrapper of discovery.getControllers()) {
    // `metatype` is nullable in Nest's own types (a controller can be registered as
    // an instance), so it is narrowed rather than asserted: a null here would make
    // every metadata read below a silent no-op, and this suite's whole job is to
    // notice a route whose metadata is missing.
    const metatype: object | undefined = wrapper.metatype ?? undefined;
    if (metatype === undefined) {
      continue;
    }

    const controllerPath: unknown = Reflect.getMetadata(
      PATH_METADATA,
      metatype,
    );
    const controllerIsPublic =
      Reflect.getMetadata(IS_PUBLIC_KEY, metatype) === true;
    const prototype: object = Object.getPrototypeOf(
      wrapper.instance ?? metatype,
    );

    for (const handler of scanner.getAllMethodNames(prototype)) {
      const fn: unknown = (prototype as Record<string, unknown>)[handler];
      if (typeof fn !== "function") {
        continue;
      }
      // `Reflect.getMetadata` reads off an object; a plain function is one.
      const target: object = fn;
      const requestMethod: unknown = Reflect.getMetadata(
        METHOD_METADATA,
        target,
      );
      if (requestMethod === undefined) {
        continue;
      }

      const handlerPath: unknown = Reflect.getMetadata(PATH_METADATA, target);
      const declared: unknown = Reflect.getMetadata(
        REQUIRE_PERMISSION_KEY,
        target,
      );
      const permission =
        typeof declared === "string"
          ? declared
          : typeof Reflect.getMetadata(REQUIRE_PERMISSION_KEY, metatype) ===
              "string"
            ? (Reflect.getMetadata(REQUIRE_PERMISSION_KEY, metatype) as string)
            : undefined;

      entries.push({
        controller: wrapper.name.replace(/Controller$/, "Controller"),
        handler,
        method: RequestMethod[requestMethod as RequestMethod] ?? "?",
        path: [controllerPath, handlerPath]
          .filter((part): part is string => typeof part === "string")
          .join("/")
          .replace(/\/+/g, "/")
          .replace(/^\//, "")
          .replace(/\/$/, ""),
        permission,
        isPublic:
          controllerIsPublic || Reflect.getMetadata(IS_PUBLIC_KEY, fn) === true,
        audited: auditedActions(Reflect.getMetadata(AUDITED_ACTIONS, target)),
      });
    }
  }

  return entries;
}

/** `@Audited()`'s metadata, narrowed — a non-array or a non-string is not a value. */
function auditedActions(raw: unknown): readonly string[] {
  return Array.isArray(raw)
    ? raw.filter((action): action is string => typeof action === "string")
    : [];
}

describe("route inventory", () => {
  let app: NestFastifyApplication;
  let routes: readonly RouteEntry[];

  beforeAll(async () => {
    app = await createTestApp();
    routes = await collectRoutes(app);
  });

  afterAll(async () => {
    await app?.close();
  });

  it("finds the routes rather than an empty inventory", () => {
    // A guard against the enumeration itself silently returning nothing — a test
    // that asserts over an empty list passes for the wrong reason.
    expect(routes.length).toBeGreaterThan(20);
    expect(
      routes.filter((route) => route.permission !== undefined).length,
    ).toBeGreaterThan(10);
  });

  it("makes every route deliberately reachable", () => {
    const undecided = routes
      .filter(
        (route) =>
          route.permission === undefined &&
          !route.isPublic &&
          !PATH_SCOPED_EXEMPTIONS.includes(keyOf(route)),
      )
      .map(keyOf);

    expect(undecided).toEqual([]);
  });

  it("keeps the exemption list free of stale entries", () => {
    // An exemption for a route that no longer exists hides the next route that
    // reuses its name.
    const present = new Set(routes.map(keyOf));
    expect(
      PATH_SCOPED_EXEMPTIONS.filter((entry) => !present.has(entry)),
    ).toEqual([]);
  });

  it("declares only permissions the matrix defines", () => {
    const unknown = routes
      .filter(
        (route) =>
          route.permission !== undefined && !isAction(route.permission),
      )
      .map((route) => `${keyOf(route)} → ${String(route.permission)}`);

    expect(unknown).toEqual([]);
  });

  it("declares no conditional action without a narrowing site", () => {
    // The matrix's own requirement, made executable: a 🟡 grant means "own or
    // assigned records only", so a route may not declare one unless the use case
    // behind it calls `canOnResource`.
    const unnarrowed = routes
      .filter(
        (route) =>
          route.permission !== undefined &&
          SCOPED_ACTIONS.has(route.permission as Action) &&
          !NARROWED_ROUTES.includes(keyOf(route)),
      )
      .map((route) => `${keyOf(route)} → ${String(route.permission)}`);

    expect(unnarrowed).toEqual([]);
  });

  it("declares an audit action on every mutation route it has integrated", () => {
    // The Stage B enforcement T050 asks for: a write route that records nothing
    // and is not a documented deferral fails here. A route that declares actions
    // but is missing from the manifest also fails, so the manifest cannot silently
    // fall behind the controllers.
    const undeclared = routes
      .filter((route) => WRITE_VERBS.has(route.method))
      .filter((route) => !AUDIT_DEFERRED.has(keyOf(route)))
      .filter(
        (route) =>
          route.audited.length === 0 || !MANDATED_AUDIT.has(keyOf(route)),
      )
      .map(keyOf);

    expect(undeclared).toEqual([]);
  });

  it("declares exactly the actions the manifest expects", () => {
    const mismatched = [...MANDATED_AUDIT].flatMap(([key, expected]) => {
      const route = routes.find((candidate) => keyOf(candidate) === key);
      if (route === undefined) {
        return [`${key} → no such route`];
      }
      const declared = [...route.audited].sort().join(", ");
      const wanted = [...expected].sort().join(", ");
      return declared === wanted
        ? []
        : [`${key} → declares ${declared || "nothing"}, expected ${wanted}`];
    });

    expect(mismatched).toEqual([]);
  });

  it("declares no audit action the domain vocabulary does not define", () => {
    // The union in `@ses/domain` is the developer-facing contract and the database
    // only checks the shape, so a name outside the union would persist happily and
    // be unfindable.
    const known = new Set<string>(AUDIT_ACTIONS);
    const unknown = routes.flatMap((route) =>
      route.audited
        .filter((action) => !known.has(action))
        .map((action) => `${keyOf(route)} → ${action}`),
    );

    expect(unknown).toEqual([]);
  });

  it("keeps the deferred list free of stale entries", () => {
    // Same reasoning as the permission exemption list: an entry for a route that
    // no longer exists would mask the next route that reuses its address.
    const present = new Set(
      routes.filter((route) => WRITE_VERBS.has(route.method)).map(keyOf),
    );
    expect(
      [...AUDIT_DEFERRED.keys()].filter((key) => !present.has(key)),
    ).toEqual([]);
  });

  it("mounts no participant-resolution route — T063's resolver is internal", () => {
    // T063's row names a service and a module, no controller: resolution is called by
    // T064's preview and T066's publish, so the API's route table must be exactly the
    // one T062 shipped. A controller added here would also fail the permission test
    // above — but only until somebody gave it a permission; this assertion names the
    // intent instead of relying on the accident.
    expect(routes.filter((route) => /participant/i.test(route.path))).toEqual(
      [],
    );
  });

  it("declares T070's two decisions against the Admin-only `expense.approve` cell", () => {
    // Both routes are ✅ cells (Admin full, no qualification), so neither may appear
    // in `NARROWED_ROUTES` — and there is deliberately no `/approval-queue` route:
    // the queue is `GET /expenses?status=pending_approval` (ADR-0011 D7).
    const decisions = routes.filter(
      (route) =>
        route.controller === "ExpensesController" &&
        /^(approve|reject)$/.test(route.path.replace(/.*\//, "")),
    );
    expect(decisions.map(keyOf).sort()).toEqual([
      "ExpensesController POST /expenses/:expenseId/approve",
      "ExpensesController POST /expenses/:expenseId/reject",
    ]);
    for (const route of decisions) {
      expect(route.permission).toBe("expense.approve");
      expect(NARROWED_ROUTES).not.toContain(keyOf(route));
    }

    expect(
      routes.filter((route) => /approval-queue/i.test(route.path)),
    ).toEqual([]);
  });

  it("inventories the guarded surface it claims to", () => {
    // A sanity check on coverage of the inventory's own claims: if the structure,
    // member, invitation and join-request surfaces are all header-scoped, their
    // routes must appear with permissions. This is what fails if a future
    // controller is registered in a way `DiscoveryService` cannot see.
    const byController = new Set(
      routes
        .filter((route) => route.permission !== undefined)
        .map((route) => route.controller),
    );

    for (const controller of [
      "BuildingsController",
      "ApartmentsController",
      "MembersController",
      "InvitationsController",
      "PermissionsController",
    ]) {
      expect([...byController]).toContain(controller);
    }
  });
});
