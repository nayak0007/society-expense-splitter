/**
 * The storage adapter's injection token — Roadmap T071, ADR-0012.
 *
 * A token rather than the class, for the reason every other adapter in this
 * codebase uses one: the application layer binds to `StorageProvider` (a
 * `@ses/domain` interface) and never to the class that happens to satisfy it, so a
 * suite can substitute an in-memory store without a bucket, and swapping the S3
 * adapter for a different vendor is a binding change rather than a rewrite.
 *
 * One token, **not one per provider**. ADR-0012's central finding is that the
 * local store and the hosted provider are the same protocol with different
 * configuration, so a `MINIO_STORAGE_PROVIDER` and a `SUPABASE_STORAGE_PROVIDER`
 * would be exactly the two-code-paths mistake the measurement was taken to
 * prevent.
 */
export const STORAGE_PROVIDER = Symbol("STORAGE_PROVIDER");

/**
 * The bucket-provisioning seam, separate from `STORAGE_PROVIDER`.
 *
 * Two tokens because they are two capabilities with two lifetimes: `presignUpload`
 * and the rest serve every request, while `ensureBucket` runs at most once, at
 * boot, and only when `STORAGE_AUTO_CREATE_BUCKET` is on. Keeping it separate means
 * the boot-time bootstrap can be disabled without the adapter losing a method, and
 * a test that wants the storage seam faked does not have to answer a question about
 * bucket creation.
 */
export const STORAGE_BUCKET_BOOTSTRAP = Symbol("STORAGE_BUCKET_BOOTSTRAP");
