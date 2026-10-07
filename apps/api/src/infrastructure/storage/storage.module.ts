import { Injectable, Logger, Module, OnModuleInit } from "@nestjs/common";
import type { StorageProvider } from "@ses/domain";

import { AppConfig } from "../../config/app-config";
import { S3StorageProvider } from "./s3-storage.provider";
import { STORAGE_BUCKET_BOOTSTRAP, STORAGE_PROVIDER } from "./storage.tokens";

/**
 * The bucket-provisioning seam's shape.
 *
 * A one-method interface rather than the whole adapter, so a test or a script can
 * satisfy "the bucket exists" without standing up a store, and so the boot-time
 * behaviour has a name that is not `S3StorageProvider.ensureBucket` — the
 * capability is "the bucket exists", not "S3 created it".
 */
export interface BucketBootstrap {
  ensureBucket(): Promise<void>;
}

/**
 * Creates the bucket at boot when the deployment asks for it.
 *
 * Separate from the adapter because it is a *lifetime*, not a capability: the
 * adapter serves every request, this runs at most once and then never again. It is
 * a provider rather than a line in `main.ts` so that the boot order is Nest's
 * (configuration validated, then providers initialised) and so a test that boots
 * the real `AppModule` gets the same behaviour production gets — the argument
 * `app.module.ts` makes for registering the guard chain with `APP_GUARD`.
 *
 * ## Why a boot-time bootstrap at all
 *
 * The local bucket used to be created by a `createbuckets` compose service running
 * `minio/mc`. Both that command's images are gone (`docker.io/minio/mc` answers
 * `object not found`), so the smallest maintainable replacement is the SDK the
 * adapter already ships — no second image, no second service, no shell loop waiting
 * on a health endpoint. It is off by default and turned on only in local `.env`
 * and in the integration harness, so a deployed process never rearranges a
 * production bucket.
 *
 * ## A failure here is not fatal, and that is deliberate
 *
 * The bucket may already exist and be owned by another account, or the store may be
 * briefly down at pod start. Killing the process over either would turn a
 * transient into an outage and a redundant bootstrap into a crash loop. The failure
 * is logged loudly and the API starts: the first presign that needs a bucket that
 * truly is missing fails with `503 DEPENDENCY_UNAVAILABLE`, which is the honest
 * report, and the log says why before that happens.
 */
@Injectable()
export class StorageBootstrapService implements BucketBootstrap, OnModuleInit {
  private readonly logger = new Logger(StorageBootstrapService.name);

  constructor(
    private readonly config: AppConfig,
    private readonly storage: S3StorageProvider,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.config.storageAutoCreateBucket) return;
    await this.ensureBucket();
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.storage.ensureBucket();
    } catch (error: unknown) {
      this.logger.error(
        `Could not ensure the storage bucket "${this.config.storageBucket}" exists ` +
          `(STORAGE_AUTO_CREATE_BUCKET=true). The API will start; uploads will fail ` +
          `until the bucket exists. Cause: ${
            error instanceof Error ? error.message : String(error)
          }`,
      );
    }
  }
}

/**
 * Object storage as an infrastructure module — Roadmap T071, ADR-0012.
 *
 * Imported by the two modules that need it rather than made `@Global()`. The
 * pattern in this repository is that configuration is global and everything else is
 * declared where it is used (`DatabaseModule` and `CacheModule` are imported
 * explicitly by each feature module), and storage is not configuration: it is a
 * capability with one implementation and a real dependency behind it, so the reader
 * of a feature module should be able to see that the module writes bytes.
 *
 * ## Why both tokens are `useExisting` and not separate providers
 *
 * `STORAGE_PROVIDER` is bound to the instance `S3StorageProvider` already is, and
 * `STORAGE_BUCKET_BOOTSTRAP` to the same bootstrap service, so there is exactly one
 * `S3Client` per process. A second provider instance would mean a second connection
 * pool per request path — invisible, and the kind of thing that only shows up as a
 * socket-exhaustion incident.
 *
 * `STORAGE_BUCKET_BOOTSTRAP` is exported because a script or a test may want to
 * provision the bucket without booting a request path; `STORAGE_PROVIDER` is
 * exported because that is the whole reason this module exists.
 */
@Module({
  providers: [
    S3StorageProvider,
    { provide: STORAGE_PROVIDER, useExisting: S3StorageProvider },
    StorageBootstrapService,
    { provide: STORAGE_BUCKET_BOOTSTRAP, useExisting: StorageBootstrapService },
  ],
  exports: [STORAGE_PROVIDER, STORAGE_BUCKET_BOOTSTRAP],
})
export class StorageModule {}

/** Re-exported so feature modules can type their injection without a second import. */
export type { StorageProvider };
