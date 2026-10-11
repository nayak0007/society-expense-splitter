import { SetMetadata } from "@nestjs/common";
import type { AuditAction } from "@ses/domain";

/**
 * The metadata key `@Audited()` writes and `AuditInterceptor` reads.
 *
 * Exported (rather than private to the decorator) so a test can read the metadata
 * with the same key the interceptor uses, instead of restating the string — the
 * classic way a metadata test passes while the interceptor looks at a different
 * key.
 */
export const AUDITED_ACTIONS = "ses:audited-actions";

/**
 * Marks a route as one that records the named audit actions — T050, ADR-0014 D7.
 *
 * ```ts
 * @Audited("member.role_assigned")
 * @Patch(":memberId/role")
 * assignRole(...) { … }
 * ```
 *
 * ## Declarative metadata, not the write mechanism
 *
 * In Stage A this decorator **declares intent**; it does not write a row. The row
 * is written by the operation itself, through `UnitOfWork`'s audit seam, so the
 * record and the change share a transaction and a rollback. An interceptor that
 * wrote after the handler could only ever be best-effort — the transaction has
 * already committed — which is exactly the shape T050's acceptance rules out
 * ("the audit write rolls back with a failed transaction").
 *
 * What the declaration buys now is the review surface (a reviewer can see which
 * routes claim to be audited) and the hook Stage B's enforcement needs: a declared
 * action that recorded nothing becomes a 500. Wiring that on today would break
 * every route that has not been integrated yet, so it lands with the remaining
 * coverage rather than with this one.
 *
 * The action names come from `@ses/domain`'s union, so a typo is a compile error
 * here and not an audit row nobody can find.
 */
export function Audited(
  ...actions: readonly AuditAction[]
): MethodDecorator & ClassDecorator {
  return SetMetadata(AUDITED_ACTIONS, actions);
}
