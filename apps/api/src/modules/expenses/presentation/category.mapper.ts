import {
  expenseCategoryListResponseSchema,
  expenseCategoryResponseSchema,
} from "@ses/contracts";
import type {
  ExpenseCategoryDto,
  ExpenseCategoryListResponseDto,
  ExpenseCategoryResponseDto,
} from "@ses/contracts";
import type { ExpenseCategory, ExpenseCategoryCapabilities } from "@ses/domain";

/**
 * Domain entity → wire DTO, per SAD §4.5's `presentation/*.mapper.ts`.
 *
 * ## Why every mapper *parses* rather than constructs
 *
 * The contract schemas in `@ses/contracts` are the client's parse target, so the
 * response has to satisfy them exactly. Mapping by hand and trusting it means a domain
 * rename — `defaultApartmentBasis` to `apartmentBasis`, a `null` becoming `undefined` —
 * ships as a silently wrong payload that the mobile client then fails to parse, in
 * production, on one screen. Parsing here turns that into a 500 with a stack trace at
 * the moment the field moves, and the cost is a Zod pass over one small object on the
 * response path.
 *
 * The mappers are deliberately explicit rather than spreads: a spread would forward any
 * field the domain grows, including ones the contract does not define, and the whole
 * point of the boundary is that it is enumerated.
 *
 * ## Why the strategy and the basis parse cleanly rather than needing a cast
 *
 * `default_split_strategy` and `default_apartment_basis` are `z.enum` over the domain's
 * own `SPLIT_STRATEGIES`/`APARTMENT_BASES`, and the entity's fields are typed with those
 * same unions — so the parse is a check rather than a transformation. That is the point
 * of the vocabulary living in `@ses/domain`: the contract, the entity and the Postgres
 * enum are one list, and a value that drifted between them would fail here rather than
 * on a client.
 *
 * `capabilities` is derived from the *membership* the use case already loaded, and is
 * shipped on the list for the reason `SocietyCapabilities` is: a management screen has
 * to decide whether to render "Add category" and whether each row's edit and delete are
 * available, and re-deriving that from a role string in the screen is exactly what SAD
 * §9.3 forbids.
 */
export function expenseCategoryToDto(
  category: ExpenseCategory,
): ExpenseCategoryDto {
  return expenseCategoryResponseSchema.shape.category.parse({
    id: category.id,
    societyId: category.societyId,
    name: category.name,
    icon: category.icon,
    color: category.color,
    defaultSplitStrategy: category.defaultSplitStrategy,
    defaultApartmentBasis: category.defaultApartmentBasis,
    isOwnerOnly: category.isOwnerOnly,
    isCapital: category.isCapital,
    gstApplicable: category.gstApplicable,
    isActive: category.isActive,
    displayOrder: category.displayOrder,
    createdAt: category.createdAt,
    updatedAt: category.updatedAt,
    deletedAt: category.deletedAt,
  });
}

function capabilitiesToDto(
  capabilities: ExpenseCategoryCapabilities,
): ExpenseCategoryListResponseDto["capabilities"] {
  return expenseCategoryListResponseSchema.shape.capabilities.parse({
    canManage: capabilities.canManage,
    canView: capabilities.canView,
  });
}

/**
 * `GET /expense-categories` — the vocabulary and what the caller may do with it.
 *
 * The capabilities are passed as their own argument rather than read off a membership:
 * the use case already evaluated them against the membership it loaded, and
 * re-evaluating here would be a second call to the matrix that could disagree with the
 * one the use case's own guard used.
 */
export function expenseCategoryListToDto(
  categories: readonly ExpenseCategory[],
  capabilities: ExpenseCategoryCapabilities,
): ExpenseCategoryListResponseDto {
  return expenseCategoryListResponseSchema.parse({
    categories: categories.map((category) => expenseCategoryToDto(category)),
    capabilities: capabilitiesToDto(capabilities),
  });
}

export function expenseCategoryResponseToDto(
  category: ExpenseCategory,
): ExpenseCategoryResponseDto {
  return expenseCategoryResponseSchema.parse({
    category: expenseCategoryToDto(category),
  });
}
