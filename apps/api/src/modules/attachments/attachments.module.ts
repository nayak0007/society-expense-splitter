import { Module } from "@nestjs/common";

import { DatabaseModule } from "../../infrastructure/database/database.module";
import { StorageModule } from "../../infrastructure/storage/storage.module";
import { SocietiesModule } from "../societies/societies.module";
import { ATTACHMENT_REPOSITORY } from "./application/attachment.tokens";
import { CompleteUploadUseCase } from "./application/use-cases/complete-upload.use-case";
import { DeleteAttachmentUseCase } from "./application/use-cases/delete-attachment.use-case";
import { PresignUploadUseCase } from "./application/use-cases/presign-upload.use-case";
import { AttachmentRepositoryPostgres } from "./infrastructure/attachment.repository";
import { AttachmentsController } from "./presentation/attachments.controller";

/**
 * The attachments feature module — Roadmap T071, ADR-0012.
 *
 * ```text
 * controller ──▶ PresignUploadUseCase ──▶ AttachmentRepository  (port, @ses/domain)
 *                    │                   ──▶ StorageProvider      (port, @ses/domain)
 *                    │                   ──▶ MEMBERSHIP_READER    (common/authorization)
 *                    └──▶ toAppError ──▶ AppError                 (common/errors)
 *
 *                CompleteUploadUseCase ──▶ the same three
 *                DeleteAttachmentUseCase ─▶ the same three
 *
 * AttachmentRepositoryPostgres ──▶ `attachments`, and two documented projections:
 *                                  `expenses` (the parent, four columns) and
 *                                  `societies` (the stored plan, one column)
 * S3StorageProvider ─────────────▶ the object store, one adapter for both providers
 * ```
 *
 * ## Why `SocietiesModule` is imported
 *
 * For exactly one provider: `MEMBERSHIP_READER`, the caller's role in the society —
 * which `canOnResource` needs and which is *not* an attachments concern. The
 * implementation stays in the society module because that is where a `members` row
 * becomes a `SocietyMembership`; a second translation here would be a third copy of
 * the role/status/occupancy navigation tables, and a drifted copy of that map is
 * silent. This is the sanctioned direction for a cross-module dependency (SAD §1.2):
 * the token is shared vocabulary in `common/authorization/`, and `SocietiesModule`
 * exports its provider.
 *
 * ## Why `StorageModule` is imported rather than global
 *
 * The infrastructure that is genuinely cross-cutting is configuration
 * (`AppConfigModule` is `@Global()`); `DatabaseModule` and `CacheModule` are imported
 * explicitly by each feature module, and storage follows that pattern. The reader of
 * this file should be able to see that this module writes bytes — and the module
 * itself owns no `S3Client`.
 *
 * ## Why `ExpensesModule` is **not** imported, though the module reads expenses
 *
 * Two reasons, and the first is a cycle. The expenses module's draft-delete path
 * needs this module's repository (to read a draft's storage keys) and the storage
 * provider (to remove the objects), so `ExpensesModule` imports `AttachmentsModule`.
 * If this module imported `ExpensesModule` in turn, Nest would have a module cycle —
 * and the two ports would be bound in the wrong order.
 *
 * The second reason is the one that makes the shape defensible rather than merely
 * necessary: the read this module needs is a **projection** — four columns of one
 * `expenses` row (id, society, status, created_by) — and the codebase already
 * sanctions a projection across a table boundary, exactly as
 * `ExpenseCategoryRepositoryPostgres` reads `expenses` and the module comment there
 * records ("reads `expenses` too, until T065/T066's adapter lands"). It writes
 * nothing, it reads no column any rule does not need, and the *permission* decision
 * still goes through `@ses/domain`'s `canOnResource` with an
 * `ExpenseResourceSnapshot`, so no expense rule is restated here.
 *
 * ## One token, one instance
 *
 * `ATTACHMENT_REPOSITORY` is bound with `useExisting` to the instance
 * `AttachmentRepositoryPostgres` already is, so a suite that substitutes a fake
 * cannot leave a second, real adapter in the graph — the same reason every other
 * module's tokens are bound this way. `STORAGE_PROVIDER` is bound in
 * `StorageModule`, not here, so both modules that need it share one `S3Client`.
 */
@Module({
  imports: [DatabaseModule, SocietiesModule, StorageModule],
  controllers: [AttachmentsController],
  providers: [
    AttachmentRepositoryPostgres,
    {
      provide: ATTACHMENT_REPOSITORY,
      useExisting: AttachmentRepositoryPostgres,
    },
    PresignUploadUseCase,
    CompleteUploadUseCase,
    DeleteAttachmentUseCase,
  ],
  /**
   * Exported for exactly one consumer: `ExpensesModule`, whose draft hard-delete
   * removes a draft's attachment keys' objects (ADR-0012 D6.5). It is exported as
   * the *port*, not as the class, so the consumer binds to the interface the rest of
   * the system sees and a suite can substitute one fake for both paths.
   */
  exports: [ATTACHMENT_REPOSITORY],
})
export class AttachmentsModule {}
