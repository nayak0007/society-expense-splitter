/**
 * Injection tokens for the attachment module — Roadmap T071, ADR-0012.
 *
 * Tokens rather than class references, for the reason `expense.tokens.ts` records:
 * `AttachmentRepository` is a `@ses/domain` port, and injecting the concrete
 * Postgres adapter would put infrastructure under the application layer (SAD §3.1)
 * and leave the suites no seam to substitute a fake.
 *
 * ```text
 * ATTACHMENT_REPOSITORY ──▶ AttachmentRepositoryPostgres   (this module)
 * STORAGE_PROVIDER      ──▶ S3StorageProvider              (infrastructure/storage)
 * MEMBERSHIP_READER     ──▶ SocietyRepositoryPostgres      (SocietiesModule, exported)
 * ```
 *
 * There is no `attachment.*` permission token because there is no `attachment.*`
 * action: T071 reuses the expense cells with `canOnResource` narrowing (ADR-0012
 * D5), so the guard chain needs nothing new here.
 */
export const ATTACHMENT_REPOSITORY = Symbol("ATTACHMENT_REPOSITORY");
