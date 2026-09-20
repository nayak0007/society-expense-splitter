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

/** Boundary helpers — the only place a raw string becomes a branded id. */
export const asUserId = (value: string): UserId => value as UserId;
export const asSocietyId = (value: string): SocietyId => value as SocietyId;
export const asMemberId = (value: string): MemberId => value as MemberId;
