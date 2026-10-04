/**
 * The two vocabularies that describe why a split row's charge is not simply
 * "the flat's occupant": `assigned_reason` and the unassigned queue's reasons.
 *
 * ## Why this is its own module
 *
 * `participant-resolution.ts` is where these values are *produced*, but it imports
 * the read projections in `ports.ts` — so a port that needs to name
 * `AssignedReason` (T066's `PublishExpenseAllocation` does) cannot import it from
 * the resolver without drawing a cycle, and `lint:arch` refuses cycles outright.
 * The vocabulary is a leaf: it depends on nothing, both the resolver and the port
 * depend on it, and `participant-resolution.ts` re-exports both names so the
 * package's public surface is unchanged.
 */

/**
 * Why a participant was charged when it was not the flat's own occupant.
 *
 * `owner_only_category` is the PRD's own value (§3.5.4) and it is what
 * `expense_splits.assigned_reason varchar(40)` was added for — T060's column comment
 * says so in as many words ("T063 writes the value"). It is a closed union rather than
 * a `string` so a second value cannot appear from a typo.
 */
export const ASSIGNED_REASONS = ["owner_only_category"] as const;
export type AssignedReason = (typeof ASSIGNED_REASONS)[number];

/**
 * Why a flat could not be addressed to anybody.
 *
 * Two values, because the two are different jobs for the treasurer: `unassigned_no_owner`
 * is the PRD's owner-only case (the society records a tenant but no owner), and
 * `unassigned_no_member` is the flat with no accountable membership at all — a
 * `bill_vacant_flats` society billing a flat nobody has been linked to yet. The
 * database needs no new vocabulary for them: both are the member-less split row the
 * `chk_expense_splits_participant` constraint already allows, and both fit the same
 * `assigned_reason` column.
 */
export const UNASSIGNED_REASONS = [
  "unassigned_no_owner",
  "unassigned_no_member",
] as const;
export type UnassignedReason = (typeof UNASSIGNED_REASONS)[number];
