/**
 * Injection token for the members module's repository port.
 *
 * A token rather than the concrete `MemberRepositoryPostgres` class, for the reason the
 * structure module's tokens record in full: `MemberRepository` is an interface in
 * `@ses/domain`, and injecting the adapter would make the application layer depend on
 * infrastructure — the direction SAD §3.1 exists to forbid — and would leave the e2e suite no
 * seam to substitute an in-memory repository, which is the only way these routes can be tested
 * without a database.
 *
 * Unlike the structure module this file has exactly **one** token: the member module owns the
 * table it reads, so there is no second port and no cross-module membership reader to wire.
 */
export const MEMBER_REPOSITORY = Symbol("MEMBER_REPOSITORY");
