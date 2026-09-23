import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import type { JWTVerifyGetKey } from "jose";

/**
 * Real signed tokens, against a locally held key pair.
 *
 * The suite presents tokens through the same header a mobile client sends, and
 * the guard verifies them with `jose` exactly as it does in production — only the
 * key material is local. That matters for what these tests can prove: a mocked
 * verifier would let every society route pass while the issuer, audience or
 * algorithm pinning was wrong, which is the entire content of T018.
 *
 * The issuer is read from the environment the suite already set, so a token this
 * helper mints is accepted by the verifier under test and by nothing else.
 */

const ISSUER = process.env.SUPABASE_JWT_ISSUER ?? "";
const AUDIENCE = "authenticated";

export interface TestAuth {
  readonly jwks: JWTVerifyGetKey;
  /** A valid access token for `userId`. */
  token(
    userId: string,
    overrides?: {
      readonly issuer?: string;
      readonly audience?: string;
      readonly expiresIn?: string;
      readonly role?: string;
      readonly noSubject?: boolean;
    },
  ): Promise<string>;
}

export async function createTestAuth(): Promise<TestAuth> {
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const jwk = await exportJWK(publicKey);

  return {
    jwks: createLocalJWKSet({
      keys: [{ ...jwk, alg: "RS256", kid: "test-key" }],
    }),

    async token(userId, overrides = {}) {
      const builder = new SignJWT({
        role: overrides.role ?? "authenticated",
        email: "member@example.com",
      })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuedAt()
        .setIssuer(overrides.issuer ?? ISSUER)
        .setAudience(overrides.audience ?? AUDIENCE)
        .setExpirationTime(overrides.expiresIn ?? "1h");

      if (overrides.noSubject !== true) {
        builder.setSubject(userId);
      }
      return builder.sign(privateKey);
    },
  };
}
