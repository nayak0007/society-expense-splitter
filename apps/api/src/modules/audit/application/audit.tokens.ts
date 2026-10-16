/**
 * DI token for the audit log's read port (`AuditLogReader`, `@ses/domain`).
 *
 * A string token rather than the class itself, following every other module: the
 * application layer binds to the *interface*, so the adapter can be swapped (the e2e
 * suite swaps it for an in-memory fake) without a file above `infrastructure/`
 * knowing. Importing the Postgres adapter from the application layer would compile
 * perfectly and would quietly make the domain depend on Drizzle — SAD §3.1's one rule,
 * broken invisibly.
 *
 * There is a *second* thing this module binds and does not token: `AuditService`,
 * which is this module's own injectable surface for the write seam. The read port is
 * tokenised because it reaches the database; the service is not, because it has one
 * implementation and no infrastructure behind it.
 */
export const AUDIT_LOG_READER = "AUDIT_LOG_READER";
