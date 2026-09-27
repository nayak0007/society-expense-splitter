import { Injectable } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import type { InvitationTokenPort, IssuedInvitationToken } from "@ses/domain";

/**
 * `InvitationTokenPort` over `node:crypto` — the module's only secret handling, in one file.
 *
 * ## Why 32 random bytes, and why base64url
 *
 * 256 bits from the CSPRNG is not guessable at any rate a network can deliver, which is what makes
 * a public preview endpoint safe: the token *is* the credential, and the only defence it needs is
 * that it cannot be found. `base64url` rather than hex because the token travels in a URL — 43
 * characters instead of 64, no `+`, `/` or `=`, so no client ever percent-encodes it and no two
 * clients encode it differently.
 *
 * ## Why the digest is sha256 without a salt, deliberately
 *
 * A password hash needs a salt and a work factor because passwords are guessable; this input is
 * 256 random bits, so a salt buys nothing and a KDF would only add latency to every acceptance. A
 * plain digest is the right primitive here, and the digest is what the database stores
 * (`chk_invitations_token_hash` insists on 64 lowercase hex characters).
 *
 * ## The token is un-hashed exactly once, by design
 *
 * `issue()` returns both halves because the caller has to hand the raw token to the person who
 * created the invitation — that is the delivery model (the manager sends the link) — and then the
 * repository only ever receives `tokenHash`. There is no `log`, no `console` and no cache in this
 * class: the credential exists in one return value and in the one response body that carries it,
 * and nowhere else.
 */
@Injectable()
export class InvitationTokensService implements InvitationTokenPort {
  issue(): IssuedInvitationToken {
    const token = randomBytes(32).toString("base64url");
    return { token, tokenHash: this.hash(token) };
  }

  hash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }
}
