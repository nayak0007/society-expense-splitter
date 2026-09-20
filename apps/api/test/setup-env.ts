/**
 * Environment for integration suites.
 *
 * Values are assigned outright rather than with `??=`, because the suite must own
 * its environment. `@nestjs/config` (and dotenv) deliberately do not overwrite a
 * variable that already exists, so an ambient `PORT` or `DATABASE_URL` — a CI
 * runner, a platform, a developer's shell — would otherwise change what the test
 * exercises. `PORT=0` in particular is exported by some environments and is
 * rejected by the config schema, which would fail the suite for a reason that has
 * nothing to do with the code under test.
 *
 * The URLs point at nothing: the suite overrides the database and cache
 * indicators, so no connection is attempted. (Both services connect lazily, which
 * is what makes an integration suite runnable with no infrastructure.)
 */
process.env.NODE_ENV = "test";
process.env.PORT = "3000";
process.env.HOST = "127.0.0.1";

process.env.DATABASE_URL =
  "postgresql://authenticator:test@localhost:5432/ses_test";
process.env.MIGRATION_DATABASE_URL =
  "postgresql://postgres:test@localhost:5432/ses_test";
process.env.REDIS_URL = "redis://localhost:6379";

process.env.SUPABASE_URL = "https://test-project.supabase.co";
process.env.SUPABASE_JWT_ISSUER = "https://test-project.supabase.co/auth/v1";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  "test-service-role-key-placeholder-value";
