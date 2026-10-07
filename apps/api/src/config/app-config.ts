import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type { Env, NodeEnv } from "./validation.schema";

/**
 * Typed, named accessors over the validated environment.
 *
 * WHY THIS EXISTS rather than injecting `ConfigService` directly: feature code
 * that calls `config.get('DATABASE_URL')` is one typo away from a runtime
 * `undefined`, and the string key gives no completion or type. Named getters make
 * the configuration surface discoverable and refactorable, and they are the only
 * place a variable name appears as a string.
 *
 * `process.env` is read exactly once, in `validateEnv`, which is what the
 * `no-restricted-properties` lint rule enforces (SAD T008: "Config is injected
 * via a typed ConfigService, never `process.env` in feature code").
 */
@Injectable()
export class AppConfig {
  constructor(private readonly config: ConfigService<Env, true>) {}

  get environment(): NodeEnv {
    return this.config.getOrThrow<NodeEnv>("NODE_ENV");
  }

  get isProduction(): boolean {
    return this.environment === "production";
  }

  get isTest(): boolean {
    return this.environment === "test";
  }

  get port(): number {
    return this.config.getOrThrow<number>("PORT");
  }

  get host(): string {
    return this.config.getOrThrow<string>("HOST");
  }

  get databaseUrl(): string {
    return this.config.getOrThrow<string>("DATABASE_URL");
  }

  /**
   * Owner connection, for DDL only. Exposed here so tooling reads the same
   * validated configuration as the server; feature code must never use it,
   * because this role can bypass RLS.
   */
  get migrationDatabaseUrl(): string {
    return this.config.getOrThrow<string>("MIGRATION_DATABASE_URL");
  }

  get databasePoolMax(): number {
    return this.config.getOrThrow<number>("DB_POOL_MAX");
  }

  /**
   * Overrides where the migration history lives. `undefined` in every normal
   * checkout (the runner resolves `supabase/migrations` from the working
   * directory upward); set in the container image, which ships the SQL at
   * `/app/migrations`. The readiness probe must read the same directory the
   * deploy-time migrate step applied, so it goes through this accessor rather
   * than recomputing a path.
   */
  get migrationsDir(): string | undefined {
    return this.config.get<string>("MIGRATIONS_DIR");
  }

  get databaseStatementTimeoutMs(): number {
    return this.config.getOrThrow<number>("DB_STATEMENT_TIMEOUT_MS");
  }

  get redisUrl(): string {
    return this.config.getOrThrow<string>("REDIS_URL");
  }

  /** `redis` (default), `memory` (single process) or `off`. See the schema's note. */
  get membershipCacheStore(): "redis" | "memory" | "off" {
    return this.config.getOrThrow<"redis" | "memory" | "off">(
      "MEMBERSHIP_CACHE_STORE",
    );
  }

  get membershipCacheTtlSeconds(): number {
    return this.config.getOrThrow<number>("MEMBERSHIP_CACHE_TTL_SECONDS");
  }

  get supabaseUrl(): string {
    return this.config.getOrThrow<string>("SUPABASE_URL");
  }

  get supabaseJwtIssuer(): string {
    return this.config.getOrThrow<string>("SUPABASE_JWT_ISSUER");
  }

  /**
   * Validated loudly, exposed narrowly: nothing user-facing may inject this.
   * It bypasses RLS, so the only legitimate consumers are admin operations
   * (user provisioning, storage admin) which land with their modules.
   */
  get supabaseServiceRoleKey(): string {
    return this.config.getOrThrow<string>("SUPABASE_SERVICE_ROLE_KEY");
  }

  get storageBucket(): string {
    return this.config.getOrThrow<string>("STORAGE_BUCKET");
  }

  /**
   * Which S3-compatible store is in use. Never selects a code path (ADR-0012's one
   * adapter); it selects defaults and one production guard. See the schema.
   */
  get storageProvider(): "minio" | "supabase" | "r2" | "s3" {
    return this.config.getOrThrow<"minio" | "supabase" | "r2" | "s3">(
      "STORAGE_PROVIDER",
    );
  }

  /** The configured endpoint, or `undefined` when the adapter should default it. */
  get storageEndpoint(): string | undefined {
    return this.config.get<string>("STORAGE_ENDPOINT");
  }

  get storageRegion(): string {
    return this.config.getOrThrow<string>("STORAGE_REGION");
  }

  /**
   * The S3 access key pair. Read through a single accessor each so the two are
   * always read together, and so there is one place to audit: **no** other file
   * may reach for these, and nothing may put them in a response, a log line or the
   * OpenAPI document.
   */
  get storageCredentials(): {
    readonly accessKeyId: string | undefined;
    readonly secretAccessKey: string | undefined;
  } {
    const accessKeyId = this.config.get<string>("STORAGE_ACCESS_KEY_ID");
    const secretAccessKey = this.config.get<string>(
      "STORAGE_SECRET_ACCESS_KEY",
    );
    return {
      accessKeyId: accessKeyId === "" ? undefined : accessKeyId,
      secretAccessKey: secretAccessKey === "" ? undefined : secretAccessKey,
    };
  }

  get storageForcePathStyle(): boolean {
    return this.config.getOrThrow<boolean>("STORAGE_FORCE_PATH_STYLE");
  }

  get storageAutoCreateBucket(): boolean {
    return this.config.getOrThrow<boolean>("STORAGE_AUTO_CREATE_BUCKET");
  }

  /** SAD §10.1's 15 minutes. Also the window an outstanding presign reserves quota for. */
  get storagePresignTtlSeconds(): number {
    return this.config.getOrThrow<number>("STORAGE_PRESIGN_TTL_SECONDS");
  }

  /**
   * The Supabase project's own storage S3 endpoint, derived — `null` when
   * `SUPABASE_URL` is not a Supabase hostname, which is the honest answer for a
   * self-hosted Postgres in the test suite.
   *
   * Derived rather than configured for the reason `AppConfig` exists at all: the
   * project ref appears twice otherwise, and the second copy is the one that goes
   * stale. `https://<ref>.supabase.co` →
   * `https://<ref>.storage.supabase.co/storage/v1/s3`, which is the endpoint
   * ADR-0012's probes were measured against.
   */
  get supabaseStorageEndpoint(): string | null {
    try {
      const url = new URL(this.supabaseUrl);
      const host = url.hostname;
      if (!host.endsWith(".supabase.co")) return null;
      const ref = host.slice(0, -".supabase.co".length);
      return `https://${ref}.storage.supabase.co/storage/v1/s3`;
    } catch {
      return null;
    }
  }

  /** `debug` in development, `info` elsewhere, silent under test. */
  get logLevel(): string {
    const explicit = this.config.get<string>("LOG_LEVEL");
    if (explicit !== undefined) return explicit;
    if (this.isTest) return "silent";
    return this.isProduction ? "info" : "debug";
  }
}
