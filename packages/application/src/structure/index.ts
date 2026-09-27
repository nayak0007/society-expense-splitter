/**
 * The Building module's application layer (Roadmap T042).
 *
 * `createBuilding` · `updateBuilding` · `deleteBuilding` · `getBuilding` ·
 * `listBuildings`.
 *
 * `use-cases/support.ts` carries what every one of them shares: the injected
 * dependencies (`StructureDeps`), the load-and-authorise steps
 * (`loadStructureContext`, `loadBuildingContext`) and the capability guard.
 *
 * Wings and apartments are deliberately absent — see the note on the `Building`
 * entity in `@ses/domain` for why they land together with the slice that can
 * populate them.
 */
export * from "./use-cases";
