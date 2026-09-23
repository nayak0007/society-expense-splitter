/**
 * The authenticated caller, as established by `SupabaseAuthGuard`.
 *
 * Deliberately minimal: identity only. T019 extends this with the member, the
 * society and the role once the guard chain exists; nothing in this slice needs
 * more than the user id, because every committed RLS policy keys on
 * `auth.uid()` and every society use case takes nothing else.
 *
 * `email` and `role` are carried because they are already in the verified token
 * and are what an audit trail wants to record (SAD §17.4) — never because
 * authorisation depends on them. A role in a token is a claim the *issuer* made;
 * membership and permissions are read from the database.
 */
export interface VerifiedActor {
  readonly userId: string;
  readonly email: string | null;
  /** The `role` claim — Supabase's `authenticated` for a user token. */
  readonly role: string | null;
}

/** Where the guard leaves the actor for the rest of the request. */
export const REQUEST_ACTOR_KEY = "sesActor";
