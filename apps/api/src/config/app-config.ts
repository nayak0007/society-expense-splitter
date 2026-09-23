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

  /** `debug` in development, `info` elsewhere, silent under test. */
  get logLevel(): string {
    const explicit = this.config.get<string>("LOG_LEVEL");
    if (explicit !== undefined) return explicit;
    if (this.isTest) return "silent";
    return this.isProduction ? "info" : "debug";
  }
}
