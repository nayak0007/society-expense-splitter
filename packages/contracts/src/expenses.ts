import {
  APARTMENT_BASES,
  CATEGORY_COLOR_MAX_LENGTH,
  CATEGORY_DISPLAY_ORDER_MAX,
  CATEGORY_DISPLAY_ORDER_MIN,
  CATEGORY_ICON_MAX_LENGTH,
  CATEGORY_NAME_MAX_LENGTH,
  EXPENSE_COMMENT_BODY_MAX_LENGTH,
  EXPENSE_DESCRIPTION_MAX_LENGTH,
  EXPENSE_REJECTION_REASON_MIN_LENGTH,
  EXPENSE_STATUSES,
  EXPENSE_TITLE_MAX_LENGTH,
  EXPENSE_VENDOR_NAME_MAX_LENGTH,
  FLOOR_MAX,
  FLOOR_MIN,
  GST_HSN_SAC_MAX_LENGTH,
  GST_INVOICE_NUMBER_MAX_LENGTH,
  GST_PLACE_OF_SUPPLY_MAX_LENGTH,
  GST_WARNING_CODES,
  GSTIN_LENGTH,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  OCCUPANCY_STATUSES,
  PARTICIPANT_SCOPES,
  PAYMENT_SOURCES,
  SELECTOR_MAX_TERMS,
  SPLIT_STRATEGIES,
  SPLIT_WARNING_CODES,
  UNASSIGNED_REASONS,
  VOID_REASON_MIN_LENGTH,
  WING_NAME_MAX_LENGTH,
  isValidGstin,
} from "@ses/domain";
import { z } from "zod";

/**
 * Expense-category wire contract (SAD §7: DTOs are Zod schemas in
 * `packages/contracts`, validated identically by the client and the API — a rule can
 * never drift between the two, PRD §18.1).
 *
 * ## The enumerated fields are the *stored* vocabularies, imported rather than re-spelled
 *
 * `defaultSplitStrategy` is `z.enum(SPLIT_STRATEGIES)` and `defaultApartmentBasis` is
 * `z.enum(APARTMENT_BASES)`, both from `@ses/domain`'s
 * `shared/split-vocabulary.ts` — the same lists the split engine implements and the
 * Postgres enums declare. A literal `z.enum(["equal", …])` here would be a third
 * spelling of a five-value vocabulary, and its failure mode is silent: a strategy
 * the database has and the contract does not is simply unsettable from any client,
 * which reads as a product limitation rather than as a typo. This is exactly what
 * `z.enum(MEMBER_STATUSES)` does for a member's status and for the same reason.
 *
 * ## Every bound comes from `@ses/domain`
 *
 * The name, icon, colour and display-order limits are all imported, so the three
 * `varchar` widths, the `CHECK (display_order >= 0)` and this file cannot disagree
 * about where a limit is. The colour's *format* — that it is a hex literal and not
 * the word `red` — is not re-checked here at all: it belongs to
 * `createCategoryColor`, which is where the value object that stores it lives, and a
 * regex in this file as well would be a second copy to keep in step.
 *
 * Request bodies are strict and response schemas are not, for the reason
 * `structure.ts` records in full (SAD §7.8 stage 1): an unknown inbound field is a
 * caller mistake worth reporting, while an added outbound field must not break a
 * client that has not been rebuilt.
 */

/**
 * `POST /expense-categories`.
 *
 * ## Which fields are absent, and why
 *
 * `societyId` comes from the `X-Society-Id` header, never from the body — the same
 * rule every header-scoped route follows (SAD §1.1: scope comes from the token and
 * the membership, never from the request). `createdBy`, `updatedBy`, `deletedAt`,
 * `deletedBy` and `version` are the table's own audit and lifecycle columns and are
 * deliberately not `INSERT`-granted (`20261001120000_expense_schema.sql`), so
 * exposing them would be a field the database refuses.
 */
export const createExpenseCategorySchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1, "Enter a category name")
    .max(CATEGORY_NAME_MAX_LENGTH),
  /**
   * `.nullable().optional()` on both, matching `UpdateApartmentInput`'s shape: a
   * client that posts a whole category object sends `null` for "none", and refusing
   * that spelling would fail a request that means the obvious thing.
   */
  icon: z.string().trim().max(CATEGORY_ICON_MAX_LENGTH).nullable().optional(),
  color: z.string().trim().max(CATEGORY_COLOR_MAX_LENGTH).nullable().optional(),
  defaultSplitStrategy: z.enum(SPLIT_STRATEGIES).optional(),
  defaultApartmentBasis: z.enum(APARTMENT_BASES).nullable().optional(),
  isOwnerOnly: z.boolean().optional(),
  isCapital: z.boolean().optional(),
  gstApplicable: z.boolean().optional(),
  /** Settable on a create because the column is granted for `INSERT`. */
  isActive: z.boolean().optional(),
  displayOrder: z
    .number()
    .int()
    .min(CATEGORY_DISPLAY_ORDER_MIN)
    .max(CATEGORY_DISPLAY_ORDER_MAX)
    .optional(),
});
export type CreateExpenseCategoryPayload = z.infer<
  typeof createExpenseCategorySchema
>;

/**
 * `PATCH /expense-categories/:categoryId` — create with every field optional, never
 * an empty patch.
 *
 * The `refine` is the same rule `updateBuildingSchema` carries and it is load bearing
 * rather than tidy: an empty body would otherwise reach the use case, which would
 * reject it as `validation` — the right answer arriving as a 422 no form field can
 * be attached to, when what the caller actually did was send a request with nothing
 * in it.
 *
 * Note that `null` survives `.partial()` on `icon`, `color` and
 * `defaultApartmentBasis`. That is the point of the `.nullable()` above: on a patch it
 * is the only way to *clear* one of the three nullable columns, since an absent key
 * means "leave unchanged" (see `UpdateExpenseCategoryInput`).
 */
export const updateExpenseCategorySchema = createExpenseCategorySchema
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "Nothing to update",
  });
export type UpdateExpenseCategoryPayload = z.infer<
  typeof updateExpenseCategorySchema
>;

/**
 * One category on the wire.
 *
 * A permissive `z.object` and not a `strictObject`, because this is a *response*:
 * adding a field to it must not break a client that has not been rebuilt. The field
 * names mirror the entity and the columns, so a rename is a rename in three places
 * rather than a mapping table in one.
 */
export const expenseCategorySchema = z.object({
  id: z.string(),
  societyId: z.string(),
  name: z.string(),
  /** `null` = the society chose none. Never `""`. */
  icon: z.string().nullable(),
  /** `#rrggbb` or `#rrggbbaa`, lower-cased. `null` = the society chose none. */
  color: z.string().nullable(),
  defaultSplitStrategy: z.enum(SPLIT_STRATEGIES),
  /** `null` unless the strategy is `apartment`. */
  defaultApartmentBasis: z.enum(APARTMENT_BASES).nullable(),
  isOwnerOnly: z.boolean(),
  isCapital: z.boolean(),
  gstApplicable: z.boolean(),
  /** `false` = deactivated: readable and historically referenced, not offered anew. */
  isActive: z.boolean(),
  displayOrder: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
});
export type ExpenseCategoryDto = z.infer<typeof expenseCategorySchema>;

export const expenseCategoryListSchema = z.array(expenseCategorySchema);
export type ExpenseCategoryListDto = z.infer<typeof expenseCategoryListSchema>;

/**
 * `GET /expense-categories` — the whole vocabulary, plus what the caller may do with
 * it.
 *
 * The capabilities travel with the list because that is where they are *used*: a
 * management screen has to decide whether to render "Add category" and whether each
 * row's edit and delete are available, and computing that from a role string in the
 * screen is exactly what SAD §9.3 forbids. There is no capability block on a write —
 * a caller that just changed a category already received them with the read that put
 * the row on screen, and a failed write carries a status rather than a permission
 * summary.
 */
export const expenseCategoryListResponseSchema = z.object({
  categories: expenseCategoryListSchema,
  capabilities: z.object({
    canManage: z.boolean(),
    canView: z.boolean(),
  }),
});
export type ExpenseCategoryListResponseDto = z.infer<
  typeof expenseCategoryListResponseSchema
>;

/**
 * `POST /expense-categories` and `PATCH /expense-categories/:categoryId` — the
 * category alone.
 *
 * A single object rather than a list, unlike the read: the create and the patch both
 * act on exactly one row, and returning a list here would make a client search it for
 * the id it just sent.
 */
export const expenseCategoryResponseSchema = z.object({
  category: expenseCategorySchema,
});
export type ExpenseCategoryResponseDto = z.infer<
  typeof expenseCategoryResponseSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Split preview — Roadmap T064
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The PRD §3.5.4 participant selector on the wire — the eight dimensions the PRD's
 * example names, and nothing else.
 *
 * ## Why this schema exists at all, when the domain validates the same shape
 *
 * The domain's `createParticipantSelector` takes `unknown` and is the **rule** — it
 * runs on the wire path *and* on the replay path (a recalculation re-validates a
 * `jsonb` selector from a stored expense). This schema is the **boundary**: it gives
 * a bad request a `VALIDATION_ERROR` with the offending path before the use case
 * runs, and it is what the generated OpenAPI documents for the mobile client. Both
 * exist because they answer different questions; neither is allowed to drift, and
 * the enumerated values are imported from the same `@ses/domain` lists the domain
 * validator reads, never re-spelled.
 *
 * ## Strict, like every request in this package
 *
 * An unknown key is a caller mistake worth reporting (SAD §7.8 stage 1): a selector
 * that carries a dimension the API does not have is a *silently different billing
 * question* — dropped, it bills the whole society when the treasurer meant one
 * wing. The bounds (`SELECTOR_MAX_TERMS`, `FLOOR_MIN`/`FLOOR_MAX`, the wing label
 * width) are the domain's own exported constants, so the wire, the validator and
 * the column cannot disagree about where a limit is.
 */
export const participantSelectorSchema = z.strictObject({
  scope: z.enum(PARTICIPANT_SCOPES).optional(),
  buildings: z.array(z.uuid()).max(SELECTOR_MAX_TERMS).optional(),
  wings: z
    .array(z.string().trim().min(1).max(WING_NAME_MAX_LENGTH))
    .max(SELECTOR_MAX_TERMS)
    .optional(),
  floors: z
    .array(z.number().int().min(FLOOR_MIN).max(FLOOR_MAX))
    .max(SELECTOR_MAX_TERMS)
    .optional(),
  occupancy: z
    .array(z.enum(OCCUPANCY_STATUSES))
    .max(SELECTOR_MAX_TERMS)
    .optional(),
  excludeApartments: z.array(z.uuid()).max(SELECTOR_MAX_TERMS).optional(),
  /**
   * `null` and absent are one fact — "not stated", so the society's
   * `bill_vacant_flats` decides — which is why the schema admits both. The stored,
   * canonical selector spells the absence `null` (T063's `includeVacant` is
   * `boolean | null` deliberately), so a response carrying a stored selector through
   * this schema would otherwise fail to parse the product's own default.
   */
  includeVacant: z.boolean().nullable().optional(),
  ownerOnly: z.boolean().optional(),
});
export type ParticipantSelectorPayload = z.infer<
  typeof participantSelectorSchema
>;

/**
 * One floor band (PRD §3.5.4): an inclusive range and the multiplier a flat in it
 * is weighted by.
 *
 * `mult` is a decimal on the wire (`0`, `1`, `1.5`) and is read as exact thousandths
 * by the engine, never as a float (`exactUnits`). The *semantics* — ordered ranges,
 * no overlap, a whole floor inside `[-5, 200]` — are the engine's to refuse (T058),
 * with `details.field: "floorBands"`; this schema fixes only the shape, so the
 * refusal a client sees is the engine's own and there is one validation of one rule.
 */
export const floorBandSchema = z.strictObject({
  from: z.number().int(),
  to: z.number().int(),
  mult: z.number().nonnegative(),
});
export type FloorBandPayload = z.infer<typeof floorBandSchema>;

/**
 * The per-participant data a strategy reads, keyed by flat — the wire form of T059's
 * "the value lives on the participant".
 *
 * ## Why `apartmentId` and not `memberId`
 *
 * Participant resolution guarantees **one outcome per flat** (T063): a flat with an
 * owner *and* a tenant produces one billable participant, so the flat identifies the
 * participant unambiguously while the member it is addressed to is the resolver's
 * answer, not the client's to assert. A request keyed by member could name a member
 * the selector does not bill; keyed by flat, the worst a client can do is reference a
 * flat outside the resolution — which the use case refuses rather than silently
 * ignoring.
 */
export const percentageEntrySchema = z.strictObject({
  apartmentId: z.uuid(),
  /** Hundredths of a percent: `33.33%` is `3333`. The total is the engine's rule. */
  basisPoints: z.number().int().min(0),
});
export type PercentageEntryPayload = z.infer<typeof percentageEntrySchema>;

export const shareEntrySchema = z.strictObject({
  apartmentId: z.uuid(),
  /** Thousandths of a share: `1.5` shares is `1500`. */
  shareUnits: z.number().int().positive(),
});
export type ShareEntryPayload = z.infer<typeof shareEntrySchema>;

export const customAmountEntrySchema = z.strictObject({
  apartmentId: z.uuid(),
  amountPaise: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
export type CustomAmountEntryPayload = z.infer<typeof customAmountEntrySchema>;

/**
 * `splitConfig` — the strategy-specific configuration, in one strict object.
 *
 * The name and the slot are the PRD's (`expenses.split_config jsonb`, and the create
 * expense example's `"splitConfig": { "floorBands": [...] }`), so the preview
 * request and the stored expense describe a split the same way. Each key belongs to
 * exactly one strategy: `percentages` to `percentage`, `shares` to `shares`,
 * `customAmounts` to `custom`, `floorBands` to `apartment`/`per_floor_band`. A key
 * the effective strategy never reads is ignored — the convention T062's category
 * route records ("drops a basis supplied beside a strategy that never reads one") —
 * while a key the strategy *does* read is validated against the resolved
 * participants.
 */
export const splitConfigSchema = z.strictObject({
  percentages: z
    .array(percentageEntrySchema)
    .max(SELECTOR_MAX_TERMS)
    .optional(),
  shares: z.array(shareEntrySchema).max(SELECTOR_MAX_TERMS).optional(),
  customAmounts: z
    .array(customAmountEntrySchema)
    .max(SELECTOR_MAX_TERMS)
    .optional(),
  floorBands: z.array(floorBandSchema).max(SELECTOR_MAX_TERMS).optional(),
});
export type SplitConfigPayload = z.infer<typeof splitConfigSchema>;

/**
 * `POST /expenses/preview-split` — the stateless preview that drives the mobile
 * split configurator (PRD §API, Roadmap T064).
 *
 * ## What it carries, and what it deliberately does not
 *
 * The PRD's own example is `{ amountPaise, splitStrategy, apartmentBasis,
 * participantSelector }`; the request adds `categoryId` and `splitConfig`, because
 * the preview has to reproduce the expense form's defaults (a category's
 * `default_split_strategy` and `default_apartment_basis` are what a new expense in
 * that category starts as) and the strategies' per-participant data, which the PRD's
 * sketch kept inside the engine's `config` slot (T057/T058 moved it onto the
 * participant; on the wire it is `splitConfig`).
 *
 * Absent means different things by field, and each is the product's own default:
 * `splitStrategy` absent → the category's default, or `equal` when no category is
 * named; `apartmentBasis` absent with the `apartment` strategy → the category's
 * default, or a field error; `splitConfig` absent → the strategy's own defaults (all
 * zero percentages, the flats' stored `share_units` for shares, no participants for
 * custom).
 *
 * Deliberately absent: `societyId` (the `X-Society-Id` header is the scope, SAD
 * §1.1), any member identity (resolution decides who each charge is addressed to),
 * and every persisted flag of the category (`isOwnerOnly`, `isCapital`) — the
 * category is read server-side, never trusted from the request.
 *
 * ## Money is integer paise, at the wire's own bound
 *
 * `amountPaise` is a positive safe integer: JSON has no `bigint`, so the contract's
 * bound is `Number.MAX_SAFE_INTEGER` and the domain's `paise()` guard would refuse a
 * larger value anyway. Zero and negative are refused *here* with a field name, which
 * is where the PRD puts the refusal (`expenses.amount_paise CHECK (amount_paise > 0)`),
 * rather than reaching the engine's own `validation`.
 */
export const previewSplitRequestSchema = z.strictObject({
  amountPaise: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  /** `null` and absent are one fact: no category defaults are consulted. */
  categoryId: z.uuid().nullable().optional(),
  splitStrategy: z.enum(SPLIT_STRATEGIES).optional(),
  apartmentBasis: z.enum(APARTMENT_BASES).nullable().optional(),
  splitConfig: splitConfigSchema.optional(),
  participantSelector: participantSelectorSchema,
});
export type PreviewSplitRequestPayload = z.infer<
  typeof previewSplitRequestSchema
>;

/**
 * One warning on the wire — T058's shape, verbatim from the PRD's example
 * (`{ "code": "MISSING_AREA", "message": "…", "apartmentIds": ["ap-58"] }`).
 *
 * The code is `z.enum(SPLIT_WARNING_CODES)` rather than a free string: the
 * vocabulary is closed and ordered, it is what a client switches on, and the list
 * lives in `@ses/domain` precisely so this schema can pin it without importing the
 * engine. The `message` travels too, because a client with nothing better to say
 * should not have to re-render the sentence from the code.
 */
export const splitWarningSchema = z.object({
  code: z.enum(SPLIT_WARNING_CODES),
  message: z.string(),
  apartmentIds: z.array(z.string()),
});
export type SplitWarningDto = z.infer<typeof splitWarningSchema>;

/**
 * One allocation on the wire — the PRD's own fields, and the SAD §8.3 facts
 * (`expense_splits` is member, flat, amount, weight; `apartmentNumber` is the label
 * the row is snapshotted with at publish).
 *
 * `weight` is the basis that produced the amount — `1` per flat in an equal split,
 * the basis points in a percentage split, hundredths of a sqft in a carpet-area
 * split — in the column's own scale, so the row a publish writes and the number a
 * resident reads are the same fact. `memberId` is never null: resolution addresses
 * every computed allocation to a member, and a flat it could not address is reported
 * in `unassigned` instead (see the response schema).
 */
export const previewSplitAllocationSchema = z.object({
  memberId: z.string(),
  apartmentId: z.string(),
  apartmentNumber: z.string(),
  weight: z.number().int(),
  amountPaise: z.number().int(),
});
export type PreviewSplitAllocationDto = z.infer<
  typeof previewSplitAllocationSchema
>;

/**
 * A billable flat the selector chose but no charge could be addressed to — T063's
 * flagged case, `unassigned_no_owner` or `unassigned_no_member`.
 *
 * Carried as its own list rather than as a null-member allocation, for two reasons:
 * there is no amount to carry (the engine cannot allocate to a member-less
 * participant — see the preview use case's note), and the two lists answer two
 * different questions — `allocations` is the bill, `unassigned` is the treasurer's
 * follow-up queue (PRD §3.5.4: "the due attaches to the apartment and shows as
 * 'unassigned' in the Treasurer's queue").
 */
export const previewSplitUnassignedSchema = z.object({
  apartmentId: z.string(),
  apartmentNumber: z.string(),
  reason: z.enum(UNASSIGNED_REASONS),
});
export type PreviewSplitUnassignedDto = z.infer<
  typeof previewSplitUnassignedSchema
>;

/**
 * `POST /expenses/preview-split` — the PRD's response fields, plus the flagged
 * unassigned list T063 introduced.
 *
 * Field for field the PRD's example: `totalPaise`, `participantCount`, `allocations`
 * (member, flat, label, weight, amount), `residualPaise` and `warnings`. The
 * additions are `unassigned` (a case the example predates) — additive fields are
 * allowed on a response by this package's own convention, an inbound one is not.
 *
 * `participantCount` counts the **allocations** — the flats that took a share — and
 * equals `allocations.length`. A flagged flat is deliberately not counted as a
 * participant: it is not part of the split, and reporting it as one would make the
 * count disagree with the list a client sums. `residualPaise` is the engine's own
 * measure and is always `0` after distribution; it is carried rather than assumed,
 * because the whole ledger rests on it being measured (T059).
 */
export const previewSplitResponseSchema = z.object({
  totalPaise: z.number().int(),
  participantCount: z.number().int(),
  allocations: z.array(previewSplitAllocationSchema),
  residualPaise: z.number().int(),
  warnings: z.array(splitWarningSchema),
  unassigned: z.array(previewSplitUnassignedSchema),
});
export type PreviewSplitResponseDto = z.infer<
  typeof previewSplitResponseSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Expense draft lifecycle — Roadmap T065
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `YYYY-MM-DD` — the stored `date` column's own shape.
 *
 * Only the shape. The *calendar* round-trip (`2026-02-30` is not a date) and the
 * 30-day future bound are `createExpenseDate`'s, and they run in the use case for the
 * reason every cross-field rule does: a rule expressed twice drifts once. A malformed
 * string is refused here with the offending field, before any row is read.
 */
const expenseDateSchema = z.iso.date();

/** The PRD's `changeNote`, bounded like every other free-text field. */
export const EXPENSE_CHANGE_NOTE_MAX_LENGTH = 500;

/**
 * The form fields T061 handed to the create/update use cases (PRD §3.4).
 *
 * `null` and absent are different facts on a **patch** and the same one on a create:
 * an absent key means "leave unchanged", an explicit `null` clears a nullable column
 * (the convention `updateExpenseCategorySchema` records). `paidByMemberId` is
 * nullable because the column is; the PRD's "required" is the form's and the publish
 * path's business, and a draft is allowed to be incomplete.
 */
const expenseDraftFieldsShape = {
  /** PRD §3.4's notes field; the column is `description`. */
  description: z
    .string()
    .trim()
    .max(EXPENSE_DESCRIPTION_MAX_LENGTH)
    .nullable()
    .optional(),
  vendorName: z
    .string()
    .trim()
    .max(EXPENSE_VENDOR_NAME_MAX_LENGTH)
    .nullable()
    .optional(),
  paymentSource: z.enum(PAYMENT_SOURCES).optional(),
  paidByMemberId: z.uuid().nullable().optional(),
};

/**
 * `POST /expenses` — Roadmap T065.
 *
 * ## What is absent, and why
 *
 * `societyId` comes from `X-Society-Id` and `createdBy` from the caller's membership
 * (SAD §1.1: scope comes from the token and the membership, never from the request),
 * and `status` is **not a client field at all**: a new expense starts `draft` and is
 * moved to `pending_approval` by the server's threshold rule, so accepting a status
 * would be accepting an authorisation decision from the caller (T061's lifecycle is
 * the only place a state lives).
 *
 * `splitStrategy` and `apartmentBasis` are optional because a category carries
 * defaults for both and the preview already established the resolution order (the
 * same `resolveSplitPlan` both doors call); `apartmentBasis` with no basis anywhere is
 * a field error, exactly as it is in a preview.
 *
 * `currency`, `isRecurring` and `dueDate` are not exposed: the first is a server
 * default for a single-market product, and the other two have no product path until
 * the cycles/recurring modules exist (T060 withheld their columns' companions).
 */
export const createExpenseSchema = z.strictObject({
  title: z.string().trim().min(1).max(EXPENSE_TITLE_MAX_LENGTH),
  amountPaise: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  expenseDate: expenseDateSchema,
  categoryId: z.uuid(),
  ...expenseDraftFieldsShape,
  splitStrategy: z.enum(SPLIT_STRATEGIES).optional(),
  apartmentBasis: z.enum(APARTMENT_BASES).nullable().optional(),
  splitConfig: splitConfigSchema.optional(),
  participantSelector: participantSelectorSchema.optional(),
});
export type CreateExpensePayload = z.infer<typeof createExpenseSchema>;

/**
 * `PATCH /expenses/:expenseId` — create with every field optional, plus the version
 * the caller read (PRD's PATCH example carries `expectedVersion`).
 *
 * `expectedVersion` is **required**, not defaulted: an optimistic lock the caller can
 * omit is not a lock, and every write here (T065's acceptance: "version incremented on
 * every write") must state what it believed it was editing. The `refine` refuses a
 * body that carries only the version — an empty patch reaches the use case as a
 * no-op write otherwise, which would bump the version for nothing.
 *
 * `splitConfig` and `participantSelector` are nullable on a patch so an editor can
 * reset them to the product's defaults (`{}`); every other nullable field clears its
 * column.
 */
export const updateExpenseSchema = createExpenseSchema
  .extend({
    splitConfig: splitConfigSchema.nullable().optional(),
    participantSelector: participantSelectorSchema.nullable().optional(),
    /**
     * T068's operator note for a published revision (PRD's PATCH example carries
     * `changeNote`). Stored on the `expense_revisions` row and never on the
     * expense itself; optional, and only meaningful on a published edit.
     */
    changeNote: z
      .string()
      .trim()
      .min(1)
      .max(EXPENSE_CHANGE_NOTE_MAX_LENGTH)
      .optional(),
  })
  .partial()
  .extend({ expectedVersion: z.number().int().min(1) })
  .refine(
    (patch) => Object.keys(patch).some((key) => key !== "expectedVersion"),
    { message: "Nothing to update" },
  );
export type UpdateExpensePayload = z.infer<typeof updateExpenseSchema>;

/**
 * One expense on the wire — the fields every T065 route returns.
 *
 * The names mirror the entity and the columns, so a rename is a rename in three
 * places rather than a mapping table in one. Money is integer paise (SAD §7.9) and
 * `expenseDate` is the stored date, not an instant.
 *
 * `splitConfig` and `participantSelector` travel as their own strict schemas rather
 * than as opaque objects: the mappers *parse* responses (T064's convention), and a
 * stored selector that this build cannot represent is a drift bug worth surfacing as
 * a 500 at the boundary instead of on a client. A draft's selector is stored
 * canonically by `createParticipantSelector`, which is why the response schema has to
 * admit `includeVacant: null` — "not stated" is a real stored fact.
 *
 * Deliberately absent: `currency` (single-market server default) and the
 * publish-time `splitSummary` — no T065 route publishes anything. The workflow
 * stamps **are** here since T070: an Admin (and the expense list) needs to see
 * whether an awaiting-approval expense has been approved, and by whom, without a
 * second request.
 */
export const expenseSchema = z.object({
  id: z.string(),
  societyId: z.string(),
  categoryId: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  amountPaise: z.number().int(),
  expenseDate: z.string(),
  vendorName: z.string().nullable(),
  paymentSource: z.enum(PAYMENT_SOURCES),
  paidByMemberId: z.string().nullable(),
  splitStrategy: z.enum(SPLIT_STRATEGIES),
  apartmentBasis: z.enum(APARTMENT_BASES).nullable(),
  splitConfig: splitConfigSchema,
  participantSelector: participantSelectorSchema,
  status: z.enum(EXPENSE_STATUSES),
  version: z.number().int(),
  createdBy: z.string(),
  publishedAt: z.string().nullable(),
  voidedAt: z.string().nullable(),
  voidedBy: z.string().nullable(),
  voidReason: z.string().nullable(),
  /**
   * The approval stamps (T070, ADR-0011): the Admin membership and instant an
   * approval was recorded for *this* version, or `null`. Both are set together.
   */
  approvedBy: z.string().nullable(),
  approvedAt: z.string().nullable(),
  /** The rejection stamps, or `null`; all three are set together or not at all. */
  rejectedBy: z.string().nullable(),
  rejectedAt: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ExpenseDto = z.infer<typeof expenseSchema>;

/** `POST /expenses` and `PATCH /expenses/:expenseId` — the expense alone. */
export const expenseResponseSchema = z.object({ expense: expenseSchema });
export type ExpenseResponseDto = z.infer<typeof expenseResponseSchema>;

/**
 * `GET /expenses` — SAD §7.5's named filters, SAD §7.4's cursor.
 *
 * Every parameter is declared and a field outside this schema is refused rather than
 * ignored, which is what makes the two filters the schema does **not** have
 * deliberately loud: `hasAttachments` and `cycleId` are the SAD's but have no column
 * or table yet (T060 withheld `cycle_id`; `hasAttachments` is a join T073 did not
 * need).
 *
 * ## `buildingId` is T073's, and it names the selector's building scope
 *
 * An expense has no `building_id` column: its building scope is stored inside
 * `participant_selector.buildings` (PRD §3.4's "building_id / wing — scope the expense
 * to a subset", resolved by T063). `buildingId` therefore matches an expense **whose
 * selector is scoped to that building**, which is the only building relationship the
 * data model states unambiguously. A society-wide expense names no building and so
 * matches no building filter; a wing is *not* used to infer a building, because a wing
 * name is unique only per building (`uq_wings_building_name`), so the inference would
 * be one-name-to-many-buildings and wrong for at least one of them. The full reasoning
 * and the recorded limitation are on `ExpenseListQuery` in `@ses/domain`.
 *
 * `limit` clamps silently at 100, as SAD §7.4 requires ("Exceeding the max clamps
 * silently rather than erroring"); a non-numeric or non-positive one is still a
 * validation failure. `dateFrom`/`dateTo` are a range, and the refinement pins the
 * one cross-field rule the document states (`dateTo >= dateFrom`).
 */
export const listExpensesQuerySchema = z
  .strictObject({
    categoryId: z.uuid().optional(),
    status: z.enum(EXPENSE_STATUSES).optional(),
    dateFrom: expenseDateSchema.optional(),
    dateTo: expenseDateSchema.optional(),
    amountPaiseMin: z.coerce.number().int().min(0).optional(),
    amountPaiseMax: z.coerce.number().int().min(0).optional(),
    /** Building scope of the expense's participant selector (T073). */
    buildingId: z.uuid().optional(),
    createdBy: z.uuid().optional(),
    /** Full-text search over title, description and vendor. */
    q: z.string().trim().min(1).max(200).optional(),
    /** Base64 of `{ expenseDate, id }` — SAD §7.4's sort tuple. */
    cursor: z.string().min(1).optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .transform((value) => Math.min(value, 100))
      .optional(),
  })
  .refine(
    (query) =>
      query.dateFrom === undefined ||
      query.dateTo === undefined ||
      query.dateFrom <= query.dateTo,
    { message: "dateTo must not be before dateFrom.", path: ["dateTo"] },
  );
export type ListExpensesQueryPayload = z.infer<typeof listExpensesQuerySchema>;

/**
 * One page of expenses plus the cursor for the next page.
 *
 * `nextCursor` is `null` on the last page and `hasMore` says whether another request
 * would return anything — the pair SAD §7.4's envelope defines (its `total` is
 * explicitly optional and deliberately not computed here: a second count query on
 * every list is not cheap once the table is the society's whole ledger).
 */
export const expenseListResponseSchema = z.object({
  expenses: z.array(expenseSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});
export type ExpenseListResponseDto = z.infer<typeof expenseListResponseSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Publishing — Roadmap T066
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The `Idempotency-Key` header on the wire — SAD §7.7's mandatory key.
 *
 * The bounds are `@ses/domain`'s (`IDEMPOTENCY_KEY_MIN_LENGTH`/`_MAX_LENGTH`), the
 * same constants the use case checks, so the pipe and the use case cannot disagree
 * about what a usable key is. It is used as a **header** schema —
 * `@HeaderParam("idempotency-key", new ZodPipe(idempotencyKeySchema))`, the
 * piped-header decorator at `common/decorators/header-param.decorator.ts` (Nest's own
 * `@Headers` takes no pipe) — which is why it is a bare string schema rather than a
 * field of the body: an absent header reaches the pipe as `undefined` and is refused
 * as syntactic (`400`), exactly like an absent body key, while a present-but-unusable
 * one is a value failure (`422`). The reported `field` is the wire header name,
 * `idempotency-key`, matching how `SocietyGuard` reports `x-society-id`.
 */
export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(IDEMPOTENCY_KEY_MIN_LENGTH)
  .max(IDEMPOTENCY_KEY_MAX_LENGTH);
export type IdempotencyKeyPayload = z.infer<typeof idempotencyKeySchema>;

/**
 * `POST /expenses/:expenseId/publish` — the request is one number.
 *
 * ## Why there is nothing else in it
 *
 * Publishing is an *authoritative* recomputation, not a submission of the values a
 * client computed. The expense's amount, category, split strategy/basis, split
 * config and participant selector are read from the persisted row; the participants
 * are resolved from current society state; the allocation is the split engine's. So
 * the only facts the request can carry are the ones the server cannot derive:
 * **which version of the row the caller believed it was publishing**. That is
 * T065's optimistic lock, and it is required rather than defaulted for the reason
 * `updateExpenseSchema` records — a lock a caller may omit is not a lock.
 *
 * Deliberately absent, `strictObject` so they are refused rather than ignored:
 * computed allocations (the stale-preview problem — T064's output is information,
 * never an authorisation), `societyId` (the `X-Society-Id` header is the scope),
 * `createdBy` (the caller's membership), `status` (the lifecycle is the server's),
 * `publishedAt` (the database's clock), and `splitConfig`/`participantSelector`
 * (editing is T065's door; publishing re-reads what is stored).
 */
export const publishExpenseSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
});
export type PublishExpensePayload = z.infer<typeof publishExpenseSchema>;

/**
 * The PRD §8.3 `splitSummary` — what the publish actually wrote.
 *
 * Measured over the **persisted** `expense_splits` rows rather than over the
 * computed allocations, which is the difference between reporting an intention and
 * reporting a bill. `totalPaise` is the conservation fact the acceptance criteria
 * assert (`SUM(splits) = amount`); `minPaise`/`maxPaise` are the PRD's own
 * "cheapest and dearest flat" facts; `participantCount` is the number of rows.
 */
export const expenseSplitSummarySchema = z.object({
  participantCount: z.number().int(),
  totalPaise: z.number().int(),
  minPaise: z.number().int(),
  maxPaise: z.number().int(),
});
export type ExpenseSplitSummaryDto = z.infer<typeof expenseSplitSummarySchema>;

/**
 * `POST /expenses/:expenseId/publish` — the published expense and its split summary.
 *
 * The expense is the same `expenseSchema` every other route returns, read back from
 * the row the transition wrote (`status: "published"`, `publishedAt` and `version`
 * the database's own), so a caller never reconstructs published state from what it
 * hoped to write. `splitSummary` is the PRD's response shape; `duesCreated` is
 * deliberately absent — dues are T067's write, and reporting a count here would be
 * reporting a write that did not happen.
 *
 * The replay signal is a **header** (`Idempotency-Replayed: true`, SAD §7.7) rather
 * than a field, and it is meaningful because the body is byte-identical either way:
 * a retry after a lost response must parse as the original success.
 */
export const publishExpenseResponseSchema = z.object({
  expense: expenseSchema,
  splitSummary: expenseSplitSummarySchema,
});
export type PublishExpenseResponseDto = z.infer<
  typeof publishExpenseResponseSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Published recalculation and revision history — Roadmap T068, ADR-0009
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The diff a committed recalculation reports — PRD §8's `recalculation` object.
 *
 * `duesUpdated` counts retained dues whose amount actually changed (a title-only
 * edit reports zero), `duesSuperseded` and `duesCreated` the other two lifecycle
 * moves, and `totalDeltaPaise` is **signed**: positive when members owe more,
 * negative when less. `blockedByPaidSplits` is the PRD's field and is always `0`
 * on a successful commit — a revision that would put an obligation below a
 * verified payment raises `409 CONFLICT` with
 * `DUE_PAID_EXCEEDS_NEW_AMOUNT` instead of returning.
 *
 * All amounts are integer paise, like every money field on this wire.
 */
export const expenseRecalculationSchema = z.object({
  duesUpdated: z.number().int().nonnegative(),
  duesSuperseded: z.number().int().nonnegative(),
  duesCreated: z.number().int().nonnegative(),
  totalDeltaPaise: z.number().int(),
  affectedMembers: z.number().int().nonnegative(),
  blockedByPaidSplits: z.number().int().nonnegative(),
});
export type ExpenseRecalculationDto = z.infer<
  typeof expenseRecalculationSchema
>;

/**
 * `PATCH /expenses/:expenseId` on a published row — the expense plus its diff.
 *
 * The expense is the same `expenseSchema` every other route returns (the row the
 * revision wrote, `version` bumped by the database's own trigger), so a client
 * that already renders an expense needs no second shape. A draft or
 * pending_approval edit still answers `expenseResponseSchema` unchanged; the
 * diff is only meaningful where something was recalculated.
 */
export const recalculateExpenseResponseSchema = z.object({
  expense: expenseSchema,
  recalculation: expenseRecalculationSchema,
});
export type RecalculateExpenseResponseDto = z.infer<
  typeof recalculateExpenseResponseSchema
>;

/**
 * One `expense_revisions` row — PRD §3.5.3's "edited" chip and its tap-through
 * history.
 *
 * `version` is the **pre-edit** version: the revision describes the state that
 * existed as expense version V before the edit that produced V+1. `snapshot` is
 * that state — the allocation-driving configuration and the authoritative splits
 * — and is deliberately typed as opaque records rather than re-modelled here:
 * the history is what the row says, and a client rendering it reads the same
 * fields the live expense carries (`amount_paise` as a digit string, per the
 * money convention). Rows are append-only; there is no update or delete route.
 */
export const expenseRevisionSchema = z.object({
  id: z.string(),
  expenseId: z.string(),
  version: z.number().int(),
  snapshot: z.object({
    expense: z.record(z.string(), z.unknown()),
    splits: z.array(z.record(z.string(), z.unknown())),
  }),
  changedBy: z.string(),
  changeNote: z.string().nullable(),
  createdAt: z.string(),
});
export type ExpenseRevisionDto = z.infer<typeof expenseRevisionSchema>;

/** `GET /expenses/:expenseId/revisions` — oldest first, so the history reads forward. */
export const expenseRevisionsResponseSchema = z.object({
  revisions: z.array(expenseRevisionSchema),
});
export type ExpenseRevisionsResponseDto = z.infer<
  typeof expenseRevisionsResponseSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Voiding — Roadmap T069, ADR-0010
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `POST /expenses/:expenseId/void` — the lock and the reason, and nothing else.
 *
 * ## Why the request carries no financial input
 *
 * Voiding is an authoritative server-side reversal: which dues exist, what was
 * paid against them and what credit that becomes are all read from the persisted
 * rows inside the definer transaction. A client cannot send an amount, a credit,
 * a member or an allocation — accepting one would be accepting an accounting
 * decision from the caller (the same rule `publishExpenseSchema` records).
 *
 * ## `reason`
 *
 * Trimmed, at least `VOID_REASON_MIN_LENGTH` characters, no control characters —
 * exactly the rule `createVoidReason` applies in the domain, and the same
 * constant, so the wire and the entity cannot disagree about what a usable reason
 * is. The length is checked on the *trimmed* value: ten spaces is not a reason.
 * No maximum is imposed here because the column is `text` and the domain sets
 * none; inventing one would be a bound with nothing behind it.
 *
 * `expectedVersion` is required rather than defaulted, for the reason
 * `updateExpenseSchema` and `publishExpenseSchema` both record — a lock a caller
 * may omit is not a lock. There is deliberately **no** `Idempotency-Key`: a void
 * is not a retryable money-moving POST, and a second attempt meets a terminal
 * void expense with `409 INVALID_TRANSITION` instead of being replayed.
 */
export const voidExpenseSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
  reason: z
    .string()
    .trim()
    .min(VOID_REASON_MIN_LENGTH)
    // eslint-disable-next-line no-control-regex
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
      message: "The void reason contains characters that are not allowed.",
    }),
});
export type VoidExpensePayload = z.infer<typeof voidExpenseSchema>;

/**
 * What one committed void reversed — PRD §8's void summary.
 *
 * `creditsIssuedPaise` is the total `paid_paise` the void converted into
 * `advance_paise` on the members' balances (ADR-0010 Decision 2): the payments
 * were already made, so the money did not arrive — it changed classification
 * from *applied* to *available credit*, and this figure is what the office
 * needs to reconcile. `affectedMembers` counts every member whose balance moved,
 * including one whose due was unpaid (whose `total_due` fell with no credit).
 *
 * All amounts are integer paise, like every money field on this wire.
 */
export const expenseVoidSummarySchema = z.object({
  duesSuperseded: z.number().int().nonnegative(),
  creditsIssuedPaise: z.number().int().nonnegative(),
  affectedMembers: z.number().int().nonnegative(),
});
export type ExpenseVoidSummaryDto = z.infer<typeof expenseVoidSummarySchema>;

/**
 * `POST /expenses/:expenseId/void` — the voided expense and what it reversed.
 *
 * The expense is the same `expenseSchema` every other route returns, read back
 * from the row the transition wrote (`status: "void"`, `voidedAt`, `voidedBy`,
 * `voidReason` and the version the trigger bumped), so a client never
 * reconstructs the voided state from what it hoped to write. The bill's splits
 * and its historical dues are **not** deleted (ADR-0010 Decision 1) and are read
 * through the existing routes; the summary is what avoiding cannot be read from
 * the expense row alone.
 */
export const voidExpenseResponseSchema = z.object({
  expense: expenseSchema,
  summary: expenseVoidSummarySchema,
});
export type VoidExpenseResponseDto = z.infer<typeof voidExpenseResponseSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Approving and rejecting — Roadmap T070, ADR-0011
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `POST /expenses/:expenseId/approve` — the lock, and nothing else.
 *
 * ## Why the request carries no financial input
 *
 * Approving is a *decision*, not a computation and not a publication: no split is
 * priced, no due is created and no balance moves. The whole payload is therefore the
 * version the Admin believed it was approving — T065's optimistic lock, and required
 * rather than defaulted for the reason `updateExpenseSchema` records: a lock a caller
 * may omit is not a lock.
 *
 * Deliberately absent, `strictObject` so they are refused rather than ignored:
 * `approvedBy` (the caller's own membership is the approver — accepting one would be
 * accepting an authorisation decision from the request), `approvedAt` (the database's
 * clock), `status` (approval does not move the lifecycle), and any allocation or
 * amount (approval does not publish — `POST /publish` does that, and it re-reads the
 * row).
 *
 * An Admin may approve their own expense (ADR-0011 D5): no field exists that would
 * let a client express "not me", and the server adds no such rule, because a
 * single-Admin society must not deadlock its own high-value expenses.
 */
export const approveExpenseSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
});
export type ApproveExpensePayload = z.infer<typeof approveExpenseSchema>;

/**
 * `POST /expenses/:expenseId/reject` — the lock and the reason.
 *
 * ## Rejection is `pending_approval → draft`
 *
 * There is no `rejected` status (ADR-0011 D1): the expense goes back to being a
 * draft its creator may correct and submit again, and the Admin's decision is
 * recorded in the stamps. The reason is what the creator reads, so it is required.
 *
 * ## `reason`
 *
 * Trimmed, at least `EXPENSE_REJECTION_REASON_MIN_LENGTH` characters, no control
 * characters — the same shape `voidExpenseSchema.reason` has, and the same constant
 * `createExpenseRejectionReason` applies in the domain, so the wire and the entity
 * cannot disagree about what a usable reason is. The length is checked on the
 * *trimmed* value: ten spaces is not a reason.
 *
 * `expectedVersion` is required for the same reason as on the approve route, and
 * there is deliberately no `Idempotency-Key`: a rejection is not a money-moving POST,
 * and a second attempt meets a row that is no longer `pending_approval` with
 * `409 INVALID_TRANSITION` rather than being replayed as a success.
 */
export const rejectExpenseSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
  reason: z
    .string()
    .trim()
    .min(EXPENSE_REJECTION_REASON_MIN_LENGTH)
    // eslint-disable-next-line no-control-regex
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
      message: "The rejection reason contains characters that are not allowed.",
    }),
});
export type RejectExpensePayload = z.infer<typeof rejectExpenseSchema>;

/**
 * `POST /expenses/:expenseId/approve` — the authoritative expense, after commit.
 *
 * The same `expenseSchema` every other route returns, read back from the row the
 * definer transaction stamped: `status` is still `pending_approval`, `approvedBy` /
 * `approvedAt` are set, any stale rejection metadata is cleared, and `version` is
 * the one the trigger bumped. A client never reconstructs the approved state from
 * what it hoped to write.
 */
export const approveExpenseResponseSchema = z.object({
  expense: expenseSchema,
});
export type ApproveExpenseResponseDto = z.infer<
  typeof approveExpenseResponseSchema
>;

/**
 * `POST /expenses/:expenseId/reject` — the authoritative expense, after commit.
 *
 * `status` is `draft`, `approvedBy` / `approvedAt` are cleared, `rejectedBy` /
 * `rejectedAt` / `rejectionReason` are set, and the version is the trigger's. The
 * creator's next move is an ordinary draft edit followed by a resubmission.
 */
export const rejectExpenseResponseSchema = z.object({
  expense: expenseSchema,
});
export type RejectExpenseResponseDto = z.infer<
  typeof rejectExpenseResponseSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// GST details — Roadmap T072, PRD §3.5.3
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A GSTIN on an input field: optional, clearable, and **checksum-validated**.
 *
 * The check runs through `isValidGstin` — the domain's own value object, not a
 * regex copied here — so the wire and the entity cannot disagree about what a
 * usable GSTIN is. A structurally well-formed value with a wrong check digit (the
 * transcription typo the PRD's task 29 exists to catch) is refused here, at the
 * boundary, with the field named.
 */
const gstinInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(GSTIN_LENGTH)
  .refine((value) => isValidGstin(value), {
    message:
      "That GSTIN is not valid. Check the fifteen characters and its check digit on the invoice.",
  })
  .nullable();

const gstPaiseSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

/**
 * `PUT /expenses/:expenseId/gst` — the whole GST record (D6).
 *
 * A `PUT` **replaces** the row: every field is a full statement of what the GST
 * details now are, and an omitted optional field is written as its empty value
 * (`null`, or `0` for an amount) rather than left untouched. That is what makes
 * the route idempotent — sending the same body twice leaves the same row — and it
 * is why a client edits the whole GST form rather than patching one field.
 *
 * ## The regime rule is checked here as well as in the database
 *
 * `taxable_value + taxes` is **not** validated: PRD §3.5.3 says warn, don't block,
 * because real invoices round, so a mismatch is a warning on a successful response
 * rather than a refusal. The *regime* rule — an invoice is intra-state
 * (`CGST + SGST`) or inter-state (`IGST`), never both — is a real invariant the
 * table enforces with `gst_single_regime`; refusing it here turns a 500-class
 * constraint violation into a field error on `igstPaise`.
 *
 * Deliberately absent: `societyId` and `expenseId` (the URL and the header), and
 * any derived or audit column.
 */
export const upsertExpenseGstSchema = z
  .strictObject({
    gstin: gstinInputSchema.optional(),
    invoiceNumber: z
      .string()
      .trim()
      .min(1)
      .max(GST_INVOICE_NUMBER_MAX_LENGTH)
      .nullable()
      .optional(),
    invoiceDate: expenseDateSchema.nullable().optional(),
    taxableValuePaise: gstPaiseSchema.optional(),
    cgstPaise: gstPaiseSchema.optional(),
    sgstPaise: gstPaiseSchema.optional(),
    igstPaise: gstPaiseSchema.optional(),
    cessPaise: gstPaiseSchema.optional(),
    hsnSac: z
      .string()
      .trim()
      .min(1)
      .max(GST_HSN_SAC_MAX_LENGTH)
      .nullable()
      .optional(),
    placeOfSupply: z
      .string()
      .trim()
      .min(1)
      .max(GST_PLACE_OF_SUPPLY_MAX_LENGTH)
      .nullable()
      .optional(),
    isReverseCharge: z.boolean().optional(),
    itcEligible: z.boolean().optional(),
  })
  .refine(
    (gst) =>
      (gst.igstPaise ?? 0) === 0 ||
      ((gst.cgstPaise ?? 0) === 0 && (gst.sgstPaise ?? 0) === 0),
    {
      message:
        "A tax invoice is either inter-state (IGST) or intra-state (CGST + SGST), never both.",
      path: ["igstPaise"],
    },
  );
export type UpsertExpenseGstPayload = z.infer<typeof upsertExpenseGstSchema>;

/**
 * The stored GST record on the wire.
 *
 * The names mirror the entity, not the columns: money is integer paise (SAD §7.9),
 * `invoiceDate` is the stored date, and the five components are the same five the
 * PRD lists. A client never sees the database representation.
 */
export const expenseGstSchema = z.object({
  expenseId: z.string(),
  gstin: z.string().nullable(),
  invoiceNumber: z.string().nullable(),
  invoiceDate: z.string().nullable(),
  taxableValuePaise: z.number().int(),
  cgstPaise: z.number().int(),
  sgstPaise: z.number().int(),
  igstPaise: z.number().int(),
  cessPaise: z.number().int(),
  hsnSac: z.string().nullable(),
  placeOfSupply: z.string().nullable(),
  isReverseCharge: z.boolean(),
  itcEligible: z.boolean(),
});
export type ExpenseGstDto = z.infer<typeof expenseGstSchema>;

/**
 * One non-blocking reconciliation warning (D7).
 *
 * `code` is the stable machine-readable discriminator and the only thing a client
 * should branch on; the four amounts let a screen show the arithmetic behind it
 * without recomputing it. `differencePaise` is `amount − (taxable + taxes)`.
 */
export const expenseGstWarningSchema = z.object({
  code: z.enum(GST_WARNING_CODES),
  taxableValuePaise: z.number().int(),
  taxesPaise: z.number().int(),
  amountPaise: z.number().int(),
  differencePaise: z.number().int(),
});
export type ExpenseGstWarningDto = z.infer<typeof expenseGstWarningSchema>;

/**
 * `PUT /expenses/:expenseId/gst` — the stored record plus any warnings.
 *
 * Warnings are **structurally separate from an error**: the request succeeded, the
 * row was written, and a `TAX_TOTAL_MISMATCH` here is the PRD's "warn, don't
 * block". `warnings` is always present (empty when nothing is wrong) so a client
 * never has to distinguish absent from empty.
 */
export const expenseGstResponseSchema = z.object({
  gst: expenseGstSchema,
  warnings: z.array(expenseGstWarningSchema),
});
export type ExpenseGstResponseDto = z.infer<typeof expenseGstResponseSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Comments — Roadmap T072, PRD §3.5.3 "Notes"
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `POST /expenses/:expenseId/comments` — the body, and nothing else (D1).
 *
 * The author is the caller's own membership (accepting one would be accepting an
 * attribution decision from the request), the sequence is the database's, and the
 * comment is append-only: there is no `id`, no `parentId` (the stream is flat,
 * D1) and no edit route. `expectedVersion` is deliberately absent — the stream is
 * commutative, not a versioned row, so there is no optimistic lock to state.
 *
 * `body` is trimmed and required; control characters other than tab, newline and
 * carriage return are refused, because a comment is prose and the others have no
 * legitimate use in it.
 */
export const addExpenseCommentSchema = z.strictObject({
  body: z
    .string()
    .trim()
    .min(1)
    .max(EXPENSE_COMMENT_BODY_MAX_LENGTH)
    .refine(
      // eslint-disable-next-line no-control-regex
      (value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value),
      {
        message: "The comment contains characters that are not allowed.",
      },
    ),
});
export type AddExpenseCommentPayload = z.infer<typeof addExpenseCommentSchema>;

/**
 * One comment on the wire.
 *
 * `body` is `null` once the comment is soft-deleted: the record and its position
 * in the stream are preserved (a deleted comment does not silently close the gap
 * around it), the deletion is visible through `deleted`/`deletedAt`/`deletedBy`,
 * and the prose itself is not returned to clients. The stored body is never lost —
 * the row keeps it for audit — it is simply not the API's to publish.
 */
export const expenseCommentSchema = z.object({
  id: z.string(),
  expenseId: z.string(),
  authorId: z.string(),
  body: z.string().nullable(),
  sequence: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deleted: z.boolean(),
  deletedAt: z.string().nullable(),
  deletedBy: z.string().nullable(),
});
export type ExpenseCommentDto = z.infer<typeof expenseCommentSchema>;

/** `POST /expenses/:expenseId/comments` — the appended comment. */
export const expenseCommentResponseSchema = z.object({
  comment: expenseCommentSchema,
});
export type ExpenseCommentResponseDto = z.infer<
  typeof expenseCommentResponseSchema
>;

/**
 * `GET /expenses/:expenseId/comments` — the whole stream, oldest first.
 *
 * Deliberately **not** paginated: a comment stream on a single expense is bounded
 * by the number of people talking about one bill, and a cursor here would be
 * complexity the product does not have a screen for. The order is the database's
 * `sequence`, so a client renders the list as received.
 */
export const expenseCommentsResponseSchema = z.object({
  comments: z.array(expenseCommentSchema),
});
export type ExpenseCommentsResponseDto = z.infer<
  typeof expenseCommentsResponseSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Current splits — Roadmap T073, PRD §3.5.3
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One **current** `expense_splits` row — what a participating flat/member owes for
 * this expense right now.
 *
 * ## Current state, never a recomputation and never a revision snapshot
 *
 * The rows are the persisted `expense_splits` the publish/recalculation path wrote
 * (`expense_publish()`/`expense_recalculate()`), read verbatim. They are deliberately
 * **not** recomputed from the participant selector — a fresh calculation would be a
 * second split engine path and could disagree with the bill — and deliberately **not**
 * taken from `expense_revisions.snapshot`, which is *history*: the snapshot describes a
 * prior version's splits, not the live ones. For a `draft` or `pending_approval`
 * expense no splits have been written, so the array is empty; that is the honest answer
 * (the bill has no allocation yet), not an error.
 *
 * ## Money and weights keep the wire's exactness
 *
 * `amountPaise` is an integer, the SAD §7.9 money convention every other expense
 * amount uses. `weight` and `percent` are `numeric` columns, so they travel as strings
 * — the same reason `amount_paise` is read as text server-side — and a client renders
 * them without ever putting them through a float. Both are nullable in the schema
 * because the columns are: a `custom` allocation may carry an amount with no meaningful
 * weight.
 *
 * `snapshot` carries the participant's name and flat number *as they were when the row
 * was published* (PRD §7.3: a later rename must not rewrite history), typed permissively
 * because it is an opaque stored record rather than a re-modelled shape.
 */
export const expenseSplitSchema = z.object({
  id: z.string(),
  expenseId: z.string(),
  memberId: z.string().nullable(),
  apartmentId: z.string().nullable(),
  amountPaise: z.number().int(),
  weight: z.string().nullable(),
  percent: z.string().nullable(),
  assignedReason: z.string().nullable(),
  snapshot: z.object({
    memberName: z.string().nullable().optional(),
    apartmentNumber: z.string().nullable().optional(),
  }),
  createdAt: z.string(),
});
export type ExpenseSplitDto = z.infer<typeof expenseSplitSchema>;

/**
 * `GET /expenses/:expenseId/splits` — every current split row, oldest first.
 *
 * The whole set is returned in one response rather than paginated: an expense's splits
 * are bounded by the number of participating flats (hundreds at most), the split table
 * a treasurer reads is one screen, and the database's conservation trigger
 * (`chk_split_total()`) already guarantees the rows total the expense amount exactly.
 * No `nextCursor`/`hasMore` pair, because there is only ever one page.
 */
export const expenseSplitsResponseSchema = z.object({
  splits: z.array(expenseSplitSchema),
});
export type ExpenseSplitsResponseDto = z.infer<
  typeof expenseSplitsResponseSchema
>;
