/**
 * The plan → attachment-quota map — Roadmap T071, ADR-0012 D2.
 *
 * ## Why this is a local map and not an entitlement service
 *
 * There is no entitlement service, and no `PlanGuard` (SAD §9.4 stage 5; it is
 * listed as not built in `docs/guides/AUTHORIZATION.md` §7). T071 therefore owns a
 * small map rather than depending on infrastructure that does not exist, and the
 * ADR records the arrangement: "when it lands, T071's check becomes a caller of it
 * rather than its owner".
 *
 * It lives in the **config layer** rather than in the attachments module because it
 * is product configuration — a price-list table, in effect — and because the
 * eventual owner is the same place the entitlement service will read its plans
 * from. Nothing here knows what an attachment is.
 *
 * ## The values are PRD §13.1's, verbatim
 *
 * | Plan    | Attachment storage |
 * | ------- | ------------------ |
 * | Free    | 500 MB             |
 * | Premium | 5 GB               |
 *
 * ## Why the keys are the *stored* plan strings and not the domain's union
 *
 * The audit found a real, pre-existing divergence: `societies.subscription_plan` is
 * the SQL enum `free | premium | society_pro | enterprise`
 * (`20260920130000_society_core.sql`), while `@ses/domain`'s `SUBSCRIPTION_PLANS` is
 * `free | pro | enterprise` (`society.ts`). Those are two vocabularies for one
 * column, and this task's brief is explicit that it must not silently resolve the
 * mismatch. So the map is keyed by **what the database holds**, read verbatim by
 * `AttachmentRepository.readSocietySubscriptionPlan`, and the two values the PRD
 * actually prices are the two that appear.
 *
 * ## Fail closed
 *
 * An unrecognised plan has **no** entry and therefore no quota:
 * `attachmentQuotaBytesForPlan` returns `null`, and the presign use case refuses
 * rather than guessing. That is the deliberate choice, and the alternative is worth
 * stating because it is the tempting one: defaulting an unknown plan to Free's
 * 500 MB would under-grant silently, and defaulting it to Premium's 5 GB would
 * *over*-grant silently. Either way a society would be limited, or entitled, by an
 * accidental default rather than by a decision — so the map has no default, and a
 * new plan is added here deliberately, beside its price.
 *
 * `society_pro` and `enterprise` are consequently *refused* today. That is not an
 * oversight and it is not a silent 500: the refusal names the plan and the operator
 * adds it here with the entitlement the product decides, which is exactly the
 * "recorded rather than silently resolved" outcome the divergence requires. It is
 * reported as a known gap in the T071 report.
 */

const MEGABYTE = 1024 * 1024;
const GIGABYTE = 1024 * MEGABYTE;

/** Plan (as stored) → the society's total attachment quota in bytes. */
export const PLAN_ATTACHMENT_QUOTA_BYTES: Readonly<Record<string, number>> = {
  free: 500 * MEGABYTE,
  premium: 5 * GIGABYTE,
};

/**
 * The cap for a stored plan value, or `null` when the plan is not priced.
 *
 * `null` is a *refusal*, not a default — see the header. `undefined` (no society
 * row, which RLS should make impossible for a member) is the same answer as an
 * unpriced plan, because both mean "this module cannot state a cap".
 */
export function attachmentQuotaBytesForPlan(
  plan: string | null | undefined,
): number | null {
  if (typeof plan !== "string") return null;
  return PLAN_ATTACHMENT_QUOTA_BYTES[plan] ?? null;
}

/**
 * The plan values this map prices, for the refusal's `details` and for tests.
 *
 * Exported so the message a caller reads and the table an operator edits cannot
 * drift: the refusal lists what *is* priced, read from the table itself.
 */
export function pricedAttachmentPlans(): readonly string[] {
  return Object.keys(PLAN_ATTACHMENT_QUOTA_BYTES).sort();
}
