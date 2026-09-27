import { SetMetadata, type CustomDecorator } from "@nestjs/common";
import { isAction, type Action } from "@ses/domain";

/**
 * Declares the permission a route needs — T038, SAD §9.4.
 *
 * ```ts
 * @RequirePermission("society.edit")
 * @Patch(":societyId")
 * edit(…) { … }
 * ```
 *
 * Metadata only: it attaches an action and decides nothing. `PermissionGuard`
 * reads it and asks the domain's evaluator (`can(role, action)`), which is what
 * keeps the matrix in exactly one place (SAD §9.3). A controller must never
 * branch on a role string — PRD §2.1's implementation note says so outright, and
 * the reason is that a role check written at a call site is a second copy of a
 * rule the matrix already owns, in the one place no test can enumerate.
 *
 * ## Dotted actions, checked at decoration time
 *
 * The action is validated when the decorator is *applied*, not when the route is
 * called. A typo — `"expense:create"` for `"expense.create"` — therefore fails at
 * import (and in every test run) rather than on the one request that needed it,
 * and the failure says which action name is wrong. Silently accepting an unknown
 * action is the worse option available: the guard would resolve it to "nobody has
 * this permission" and the route would answer 403 forever, which reads like a
 * role problem and is actually a spelling mistake.
 *
 * The returned value is `undefined`-safe as a class decorator too, so a whole
 * controller can require one permission when every route in it shares it.
 */
export const REQUIRE_PERMISSION_KEY = "sesRequirePermission";

export function RequirePermission(action: Action): CustomDecorator<string> {
  if (!isAction(action)) {
    throw new Error(
      `RequirePermission("${String(action)}") is not a known action. ` +
        `Actions are dotted (for example "expense.create") and listed in ` +
        `@ses/domain's ACTIONS.`,
    );
  }
  return SetMetadata(REQUIRE_PERMISSION_KEY, action);
}
