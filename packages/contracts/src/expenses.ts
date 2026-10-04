import {
  APARTMENT_BASES,
  CATEGORY_COLOR_MAX_LENGTH,
  CATEGORY_DISPLAY_ORDER_MAX,
  CATEGORY_DISPLAY_ORDER_MIN,
  CATEGORY_ICON_MAX_LENGTH,
  CATEGORY_NAME_MAX_LENGTH,
  FLOOR_MAX,
  FLOOR_MIN,
  OCCUPANCY_STATUSES,
  PARTICIPANT_SCOPES,
  SELECTOR_MAX_TERMS,
  SPLIT_STRATEGIES,
  SPLIT_WARNING_CODES,
  UNASSIGNED_REASONS,
  WING_NAME_MAX_LENGTH,
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
  includeVacant: z.boolean().optional(),
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
