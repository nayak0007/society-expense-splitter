/**
 * Injection tokens for the building module's dependencies.
 *
 * A token rather than the concrete `BuildingRepositoryPostgres` class, for the
 * reason the society module's tokens record in full: `BuildingRepository` is an
 * interface in `@ses/domain`, and injecting the adapter would make the application
 * layer depend on infrastructure — the direction SAD §3.1 exists to forbid — and
 * would leave the e2e suite no seam to substitute an in-memory repository, which
 * is the only way these routes can be tested without a database.
 *
 * The membership reader's token is **not** here. It is
 * `MEMBERSHIP_READER` in `common/authorization/`, because its provider is declared
 * in `SocietiesModule` and injected here — cross-module wiring belongs in shared
 * vocabulary rather than in one feature's internals.
 */
export const BUILDING_REPOSITORY = Symbol("BUILDING_REPOSITORY");

/**
 * The flat storage port, for the same reasons as the token above.
 *
 * A **second** token rather than one `STRUCTURE_REPOSITORY` holding both ports:
 * the two are separate interfaces in `@ses/domain` with separate adapters, and a
 * suite has to be able to substitute one while the other stays real. It is also
 * what keeps `StructureDeps` honest — a use case that only needs buildings never
 * receives a flats repository it could call by accident.
 */
export const APARTMENT_REPOSITORY = Symbol("APARTMENT_REPOSITORY");
