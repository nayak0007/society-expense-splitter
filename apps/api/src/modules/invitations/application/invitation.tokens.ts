/**
 * Injection tokens for the invitations module's ports.
 *
 * Two, and they are different *kinds* of dependency rather than two repositories: the token port is
 * pure computation (a digest and a random string) while the repository is I/O. Splitting them means
 * the e2e suite can substitute the storage fake and keep the **real** hashing — which is the
 * combination that tests the property that matters, that the digest the fake receives is the digest
 * of the token the caller was handed, and is not the token.
 *
 * Symbols rather than the concrete classes, for the reason `member.tokens.ts` records in full: the
 * application layer binds to `@ses/domain`'s interfaces, so the adapters stay swappable and the
 * dependency direction SAD §3.1 requires stays enforceable.
 */
export const INVITATION_REPOSITORY = Symbol("INVITATION_REPOSITORY");
export const INVITATION_TOKENS = Symbol("INVITATION_TOKENS");
