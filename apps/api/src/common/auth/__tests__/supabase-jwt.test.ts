import { ConfigService } from "@nestjs/config";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  exportSPKI,
  generateKeyPair,
} from "jose";
// `CryptoKey` comes from jose rather than the global scope: the global one is a
// value, and the host may not expose the Web Crypto type at all.
import type { CryptoKey, JWTVerifyGetKey } from "jose";

import { AppConfig } from "../../../config/app-config";
import type { Env } from "../../../config/validation.schema";
import {
  SUPABASE_JWKS,
  SUPABASE_JWKS_PROVIDER,
  SupabaseJwtVerifier,
  TokenVerificationError,
  supabaseJwksUrl,
} from "../supabase-jwt";

/**
 * Access-token verification (T018).
 *
 * Every case here is a way to authenticate as somebody else, or to be told to
 * sign in again when the fault is ours. They use real signatures and a real
 * local key set rather than a mocked `jose`, because the properties at stake —
 * that a token minted for another project does not verify, that the service-role
 * key cannot be presented as a caller identity — are properties of the
 * verification call, not of our code around it.
 */

const ISSUER = "https://project.supabase.co/auth/v1";
const OTHER_ISSUER = "https://other-project.supabase.co/auth/v1";
const USER_ID = "9f8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

async function makeKeySet() {
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const jwk = await exportJWK(publicKey);
  return {
    privateKey,
    publicKey,
    jwks: createLocalJWKSet({ keys: [{ ...jwk, alg: "RS256", kid: "key-1" }] }),
  };
}

/** Signs an otherwise-valid token, with whatever the test wants changed. */
async function sign(
  privateKey: CryptoKey,
  overrides: {
    issuer?: string;
    audience?: string;
    subject?: string | null;
    role?: string;
    expiresIn?: string;
    alg?: string;
    key?: CryptoKey | Uint8Array;
    kid?: string;
  } = {},
) {
  const builder = new SignJWT({
    role: overrides.role ?? "authenticated",
    email: "member@example.com",
  })
    .setProtectedHeader({
      alg: overrides.alg ?? "RS256",
      kid: overrides.kid ?? "key-1",
    })
    .setIssuedAt()
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? "authenticated");

  if (overrides.subject !== null) {
    builder.setSubject(overrides.subject ?? USER_ID);
  }

  return builder
    .setExpirationTime(overrides.expiresIn ?? "1h")
    .sign((overrides.key ?? privateKey) as CryptoKey);
}

const SUPABASE_URL = "https://project.supabase.co";

function configWith(values: Record<string, string | number> = {}): AppConfig {
  return new AppConfig(
    new ConfigService<Env, true>({
      SUPABASE_URL,
      SUPABASE_JWT_ISSUER: ISSUER,
      ...values,
    }),
  );
}

function verifierWith(jwks: JWTVerifyGetKey): SupabaseJwtVerifier {
  return new SupabaseJwtVerifier(jwks, configWith());
}

describe("supabaseJwksUrl", () => {
  it("targets the project's published key set", () => {
    expect(supabaseJwksUrl("https://x.supabase.co")).toBe(
      "https://x.supabase.co/auth/v1/.well-known/jwks.json",
    );
  });

  it("tolerates a trailing slash, which a copied dashboard URL often has", () => {
    expect(supabaseJwksUrl("https://x.supabase.co/")).toBe(
      "https://x.supabase.co/auth/v1/.well-known/jwks.json",
    );
  });
});

describe("SupabaseJwtVerifier", () => {
  it("accepts a well-formed token and returns the identity RLS keys on", async () => {
    const keys = await makeKeySet();
    const verifier = verifierWith(keys.jwks);

    const actor = await verifier.verify(await sign(keys.privateKey));

    // `sub` is the value that becomes `app.user_id` inside every policy. If this
    // were taken from a header or a body field instead, every policy would be
    // decoration.
    expect(actor.userId).toBe(USER_ID);
    expect(actor.email).toBe("member@example.com");
    expect(actor.role).toBe("authenticated");
  });

  it("reports an expired token as TOKEN_EXPIRED, because the client retries on it", async () => {
    const keys = await makeKeySet();

    await expect(
      verifierWith(keys.jwks).verify(
        await sign(keys.privateKey, { expiresIn: "-10m" }),
      ),
    ).rejects.toMatchObject({ code: "TOKEN_EXPIRED" });
  });

  it("rejects a token minted for a different Supabase project", async () => {
    // Both projects' keys verify against their own JWKS, so the issuer is the
    // only thing separating them.
    const keys = await makeKeySet();

    await expect(
      verifierWith(keys.jwks).verify(
        await sign(keys.privateKey, { issuer: OTHER_ISSUER }),
      ),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("rejects Supabase's own anon and service_role keys presented as a session", async () => {
    // These are signed with the project key and are JWTs too. A service_role
    // token bypasses RLS completely, so accepting one would hand a
    // full-database credential to anyone holding a client-embedded key.
    const keys = await makeKeySet();

    for (const audience of ["anon", "service_role"]) {
      await expect(
        verifierWith(keys.jwks).verify(
          await sign(keys.privateKey, { audience }),
        ),
      ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    }
  });

  it("refuses a service_role role claim even behind a valid audience", async () => {
    // Defence in depth: the audience check is the first line, and this is the
    // second, so a future project configuration that widened the accepted
    // audiences still could not promote its admin key to a caller.
    const keys = await makeKeySet();

    await expect(
      verifierWith(keys.jwks).verify(
        await sign(keys.privateKey, { role: "service_role" }),
      ),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("refuses a token with no sub, which cannot be attributed to a member", async () => {
    const keys = await makeKeySet();

    await expect(
      verifierWith(keys.jwks).verify(
        await sign(keys.privateKey, { subject: null }),
      ),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("refuses an HS256 token signed with the public key as an HMAC secret", async () => {
    // The classic algorithm-confusion attack: the header says HS256 and the
    // public JWKS material — which is public — is reused as the HMAC secret.
    // Pinning the algorithm is the only thing that stops it.
    const keys = await makeKeySet();
    const spki = await exportSPKI(keys.publicKey);
    // The public key's PEM bytes, used as if they were an HMAC secret.
    const forged = await sign(keys.privateKey, {
      alg: "HS256",
      key: new TextEncoder().encode(spki),
    });

    await expect(verifierWith(keys.jwks).verify(forged)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });

  it("refuses a token signed by a key the project does not publish", async () => {
    const keys = await makeKeySet();
    const attacker = await generateKeyPair("RS256", { extractable: true });

    await expect(
      verifierWith(keys.jwks).verify(await sign(attacker.privateKey)),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("reports an unknown kid as DEPENDENCY_UNAVAILABLE, not as a bad token", async () => {
    // This is the key-rotation window. Reporting 401 would tell a signed-in user
    // to sign in again — advice that cannot help during our own rotation.
    const keys = await makeKeySet();

    await expect(
      verifierWith(keys.jwks).verify(
        await sign(keys.privateKey, { kid: "key-2" }),
      ),
    ).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
  });

  it("reports an unreachable JWKS endpoint as DEPENDENCY_UNAVAILABLE", async () => {
    // `fetch` throws a bare TypeError when the network is unreachable, and it is
    // not a JOSEError — which is exactly how the verifier recognises a failure
    // that belongs to our infrastructure rather than to the caller's token. The
    // token has to be well formed for this path to be reached at all: a garbage
    // string fails parsing before any key is ever requested.
    const keys = await makeKeySet();
    const failingJwks = (() => {
      throw new TypeError("fetch failed");
    }) as unknown as JWTVerifyGetKey;

    await expect(
      verifierWith(failingJwks).verify(await sign(keys.privateKey)),
    ).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
  });

  it("never lets a raw jose error escape", async () => {
    // The guard has exactly two outcomes to render, so a leaking jose class
    // would arrive at the exception filter as an unhandled 500.
    const keys = await makeKeySet();

    await expect(
      verifierWith(keys.jwks).verify("garbage"),
    ).rejects.toBeInstanceOf(TokenVerificationError);
  });

  it("does not echo why verification failed", async () => {
    // Telling a caller which half of the token failed tells an attacker which
    // half to work on.
    const keys = await makeKeySet();

    try {
      await verifierWith(keys.jwks).verify(
        await sign(keys.privateKey, { issuer: OTHER_ISSUER }),
      );
      throw new Error("expected verification to fail");
    } catch (error: unknown) {
      expect((error as Error).message).toBe(
        "Your session could not be verified.",
      );
      expect((error as Error).message).not.toMatch(/iss|aud|signature/i);
    }
  });

  it("builds its key set lazily, so booting the API needs no reachability to Supabase", () => {
    // The JWKS endpoint is contacted on the first verification, not at
    // construction. If this ever moved to module load, the API would fail to
    // start during a Supabase outage — including the health probes an
    // orchestrator uses to decide whether to keep the pod.
    const declaration = SUPABASE_JWKS_PROVIDER as {
      provide: unknown;
      useFactory: (config: AppConfig) => JWTVerifyGetKey;
    };

    expect(declaration.provide).toBe(SUPABASE_JWKS);
    expect(typeof declaration.useFactory(configWith())).toBe("function");
  });
});
