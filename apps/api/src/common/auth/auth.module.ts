import { Global, Module } from "@nestjs/common";

import { SUPABASE_JWKS_PROVIDER, SupabaseJwtVerifier } from "./supabase-jwt";

/**
 * Authentication primitives — T018.
 *
 * `@Global` for the same reason `AppConfigModule` is: the guard is registered
 * once in `AppModule` and dependency-injected into every route, so re-importing
 * this per feature module would add noise without adding isolation. There is
 * exactly one JWKS cache per process, which is the point — a second instance
 * would double the outbound fetches on key rotation.
 *
 * Only the verifier is exported. The raw `SUPABASE_JWKS` token stays private so
 * feature code cannot verify tokens itself: every caller goes through the
 * verifier's pinned issuer/audience/algorithm rules, and a module that wanted to
 * loosen one of them would have to do it here, in review.
 */
@Global()
@Module({
  providers: [SUPABASE_JWKS_PROVIDER, SupabaseJwtVerifier],
  exports: [SupabaseJwtVerifier],
})
export class AuthModule {}
