/**
 * Injection tokens for the society module's dependencies.
 *
 * Tokens rather than class references, because both dependencies are things the
 * *domain* declares and Nest cannot know about: `SocietyRepository` is an
 * interface in `@ses/domain`, and `Clock` is a plain object. Injecting the
 * concrete `SocietyRepositoryPostgres` class instead would make the application
 * layer depend on infrastructure — the direction SAD §3.1 exists to forbid — and
 * would leave the e2e suite no seam to substitute an in-memory repository, which
 * is the only way these routes can be tested without a database.
 *
 * `SOCIETY_REPOSITORY` in particular is what makes the ADR-0007 arrangement
 * testable: production binds it to the RLS-backed adapter, tests bind it to a
 * fake, and the controller cannot tell the difference.
 */
export const SOCIETY_REPOSITORY = Symbol("SOCIETY_REPOSITORY");
export const SOCIETY_CLOCK = Symbol("SOCIETY_CLOCK");
