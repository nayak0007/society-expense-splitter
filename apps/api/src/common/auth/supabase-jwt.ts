import { Inject, Injectable, type Provider } from "@nestjs/common";
import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";

import { AppConfig } from "../../config/app-config";

import type { VerifiedActor } from "./actor";

/**
 * Supabase access-token verification — Roadmap T018.
 *
 * ## Why the token, and not the database
 *
 * RLS is the tenancy boundary in this system (SAD §1.2, ADR-0007), and every
 * policy resolves the caller through `auth.uid()`. `UnitOfWork` satisfies that
 * from the `app.user_id` setting it applies per transaction — so the value it
 * writes must be something the *caller could not have chosen*. A verified JWT's
 * `sub` is that value; a header or a body field is not. Getting this wrong
 * downgrades every policy to decoration, which is why it is verified here rather
 * than trusted anywhere downstream.
 *
 * ## What is checked, and why each check exists
 *
 * - **Signature, against the project's JWKS.** Fetched from
 *   `auth/v1/.well-known/jwks.json` and cached by `jose`, which also refetches
 *   when a `kid` it has never seen arrives — the key-rotation path.
 * - **`alg: RS256`, pinned.** Without pinning, a token whose header says `none`
 *   or `HS256` could be presented and the *public* JWKS material reused as an
 *   HMAC secret — the classic JWT algorithm-confusion attack.
 * - **`iss` equals `SUPABASE_JWT_ISSUER`.** A token minted for a *different*
 *   Supabase project must not authenticate here. Both projects' keys verify
 *   against their own JWKS, so the issuer is the only thing separating them.
 * - **`aud` equals `authenticated`.** Supabase signs more than user tokens with
 *   the same project key: the `anon` and `service_role` keys are JWTs too. A
 *   `service_role` token bypasses RLS completely, so accepting one here would
 *   hand a full-database credential to anyone holding a client-embedded key —
 *   the audience check is what makes that impossible.
 * - **`sub` present**, because it becomes the RLS identity. A token without one
 *   cannot be attributed to a tenant member.
 * - **`exp`/`nbf`, with 60 s of clock tolerance** (T018). The tolerance is
 *   deliberate: the API and Supabase do not share a clock, and rejecting a
 *   token that expired four seconds ago mid-request produces a spurious 401.
 *
 * ## Failure is typed, never thrown raw
 *
 * `jose` throws a dozen error classes; the guard needs exactly two outcomes
 * (`TOKEN_EXPIRED`, `UNAUTHENTICATED`), so this maps them once. The message is
 * deliberately not echoed to the client — a verification failure that says *why*
 * it failed tells an attacker which half of the token to work on.
 */

/** The injectable JWKS resolver. Overridden in tests with a local key set. */
export const SUPABASE_JWKS = Symbol("SUPABASE_JWKS");

/** Supabase's audience for a logged-in user's access token. */
const EXPECTED_AUDIENCE = "authenticated";

/** The only algorithm this project is configured to sign with. */
const EXPECTED_ALGORITHM = "RS256";

/** T018: "60-second clock-skew tolerance". */
const CLOCK_TOLERANCE_SECONDS = 60;

/**
 * How long a `kid` miss may retry the JWKS endpoint.
 *
 * `jose` refetches on an unknown `kid`, but only after this cooldown has passed.
 * T018 asks for an "immediate refetch"; unbounded immediacy would let anyone
 * bypass the cache indefinitely by presenting tokens with random `kid` headers
 * and turning every request into an outbound fetch against Supabase. Five
 * seconds keeps key rotation effectively instantaneous for real traffic (the
 * first miss after a rotation waits at most that long) while capping the abuse
 * to a handful of fetches per minute.
 *
 * `cacheMaxAge` is T018's "cached 24 h" and is the *positive* path — a known
 * `kid` never triggers a network call at all.
 */
const JWKS_COOLDOWN_MS = 5_000;
const JWKS_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const JWKS_TIMEOUT_MS = 5_000;

export function supabaseJwksUrl(supabaseUrl: string): string {
  return `${supabaseUrl.replace(/\/+$/, "")}/auth/v1/.well-known/jwks.json`;
}

/**
 * Builds the remote key set from validated configuration.
 *
 * Exported as a provider so the guard never constructs it: a `createRemoteJWKSet`
 * per request would defeat the cache entirely, and a per-test key set has to be
 * substitutable without touching the guard.
 */
export const SUPABASE_JWKS_PROVIDER: Provider = {
  provide: SUPABASE_JWKS,
  inject: [AppConfig],
  useFactory: (config: AppConfig): JWTVerifyGetKey =>
    createRemoteJWKSet(new URL(supabaseJwksUrl(config.supabaseUrl)), {
      timeoutDuration: JWKS_TIMEOUT_MS,
      cooldownDuration: JWKS_COOLDOWN_MS,
      cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
    }),
};

/**
 * A verification failure, narrowed to the three catalogue codes that can
 * describe one, so the guard stays a one-liner.
 *
 * `DEPENDENCY_UNAVAILABLE` is in the union on purpose and is the interesting
 * member: a JWKS fetch that times out or a `kid` that is not (yet) in the key
 * set is *our* infrastructure failing, not the caller's token being wrong.
 * Reporting 401 there would tell a signed-in user to sign in again — advice that
 * cannot help — and would hide an outage behind a normal-looking rejection.
 */
export type TokenFailureCode =
  "TOKEN_EXPIRED" | "UNAUTHENTICATED" | "DEPENDENCY_UNAVAILABLE";

export class TokenVerificationError extends Error {
  constructor(
    readonly code: TokenFailureCode,
    message: string,
    // `override` because `Error` declares a `cause` of its own; without it a
    // future `Error` change would silently shadow rather than extend.
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "TokenVerificationError";
  }
}

/**
 * True when the failure is about *obtaining key material* rather than about the
 * token presented.
 *
 * `JWKSNoMatchingKey` is the rotation window: the token names a `kid` the cached
 * set does not have yet (jose refetches, subject to the cooldown above).
 * `JWKSTimeout` is the fetch itself failing. Anything that is not a `JOSEError`
 * at all is a transport-level failure — `fetch` throws a bare `TypeError` when
 * the network is unreachable, which reaches here unchanged.
 *
 * The distinction matters because these are the only cases where retrying can
 * succeed while the presented token stays the same.
 */
function isKeyMaterialFailure(error: unknown): boolean {
  if (
    error instanceof errors.JWKSNoMatchingKey ||
    error instanceof errors.JWKSTimeout ||
    error instanceof errors.JWKSInvalid
  ) {
    return true;
  }
  return !(error instanceof errors.JOSEError);
}

@Injectable()
export class SupabaseJwtVerifier {
  constructor(
    @Inject(SUPABASE_JWKS) private readonly jwks: JWTVerifyGetKey,
    private readonly config: AppConfig,
  ) {}

  /** Verifies signature and claims, or throws `TokenVerificationError`. */
  async verify(token: string): Promise<VerifiedActor> {
    let payload: Record<string, unknown>;

    try {
      const verified = await jwtVerify(token, this.jwks, {
        issuer: this.config.supabaseJwtIssuer,
        audience: EXPECTED_AUDIENCE,
        algorithms: [EXPECTED_ALGORITHM],
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
      });
      payload = verified.payload;
    } catch (error: unknown) {
      // Expiry is the one failure worth telling apart: the client's refresh
      // path branches on `TOKEN_EXPIRED` and retries, while every other failure
      // means "sign in again".
      if (error instanceof errors.JWTExpired) {
        throw new TokenVerificationError(
          "TOKEN_EXPIRED",
          "Your session has expired.",
          error,
        );
      }
      if (isKeyMaterialFailure(error)) {
        throw new TokenVerificationError(
          "DEPENDENCY_UNAVAILABLE",
          "Sign-in could not be verified right now.",
          error,
        );
      }
      throw new TokenVerificationError(
        "UNAUTHENTICATED",
        "Your session could not be verified.",
        error,
      );
    }

    const sub = payload.sub;
    if (typeof sub !== "string" || sub === "") {
      throw new TokenVerificationError(
        "UNAUTHENTICATED",
        "Your session could not be verified.",
      );
    }

    // Defence in depth behind the audience check: `service_role` bypasses RLS
    // entirely, so it must never be accepted as a caller identity even if a
    // future project configuration widened the accepted audiences.
    if (payload.role === "service_role") {
      throw new TokenVerificationError(
        "UNAUTHENTICATED",
        "Your session could not be verified.",
      );
    }

    return {
      userId: sub,
      email: typeof payload.email === "string" ? payload.email : null,
      role: typeof payload.role === "string" ? payload.role : null,
    };
  }
}
