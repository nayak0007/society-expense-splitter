/**
 * Branded identifiers (SAD §4.1: "repositories require a `societyId` argument
 * typed as `SocietyId`"). A branded string is still a string at runtime — the
 * brand exists so a `SocietyId` can never be passed where a `UserId` is
 * expected, which is exactly the class of bug that leaks tenant data.
 *
 * Zero runtime dependencies: this package is shared by mobile and the API.
 */
declare const idBrand: unique symbol;

export type Brand<TValue, TBrand extends string> = TValue & {
  readonly [idBrand]: TBrand;
};

export type UserId = Brand<string, "UserId">;
export type SocietyId = Brand<string, "SocietyId">;
export type MemberId = Brand<string, "MemberId">;
export type BuildingId = Brand<string, "BuildingId">;
export type WingId = Brand<string, "WingId">;
export type ApartmentId = Brand<string, "ApartmentId">;
export type InvitationId = Brand<string, "InvitationId">;
export type ExpenseId = Brand<string, "ExpenseId">;
/**
 * A row of `expense_categories`, the per-society category list (PRD §3.5).
 *
 * Branded separately from `ExpenseId` for the same reason every id is branded:
 * a category id passed where an expense id belongs is the class of bug this file
 * exists to make uncompilable.
 */
export type ExpenseCategoryId = Brand<string, "ExpenseCategoryId">;
/**
 * A row of `expense_comments`, the flat discussion stream on an expense
 * (PRD §3.5.3 "Notes", Roadmap T072).
 *
 * Branded separately like every other id: a comment id passed where an expense id
 * belongs must be a compile error, not a cross-table write.
 */
export type ExpenseCommentId = Brand<string, "ExpenseCommentId">;

/** Boundary helpers — the only place a raw string becomes a branded id. */
export const asUserId = (value: string): UserId => value as UserId;
export const asSocietyId = (value: string): SocietyId => value as SocietyId;
export const asMemberId = (value: string): MemberId => value as MemberId;
export const asBuildingId = (value: string): BuildingId => value as BuildingId;
export const asWingId = (value: string): WingId => value as WingId;
export const asApartmentId = (value: string): ApartmentId =>
  value as ApartmentId;
export const asInvitationId = (value: string): InvitationId =>
  value as InvitationId;
export const asExpenseId = (value: string): ExpenseId => value as ExpenseId;
export const asExpenseCategoryId = (value: string): ExpenseCategoryId =>
  value as ExpenseCategoryId;
export const asExpenseCommentId = (value: string): ExpenseCommentId =>
  value as ExpenseCommentId;
