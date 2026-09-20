/**
 * The Society module's application layer.
 *
 * `createSociety` · `updateSociety` · `deleteSociety` · `joinSociety` ·
 * `leaveSociety`, plus the three read/rotation use cases a screen needs
 * (`regenerateJoinCode`, `getSocietyProfile`, `listSocietySummaries`).
 *
 * `use-cases/support.ts` carries what every one of them shares: the injected
 * dependencies (`SocietyDeps`), the load-and-authorise step
 * (`loadSocietyContext`) and the capability guard.
 */
export * from "./use-cases";
