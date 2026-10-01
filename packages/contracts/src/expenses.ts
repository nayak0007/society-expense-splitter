import {
  APARTMENT_BASES,
  CATEGORY_COLOR_MAX_LENGTH,
  CATEGORY_DISPLAY_ORDER_MAX,
  CATEGORY_DISPLAY_ORDER_MIN,
  CATEGORY_ICON_MAX_LENGTH,
  CATEGORY_NAME_MAX_LENGTH,
  SPLIT_STRATEGIES,
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
