import { AsyncLocalStorage } from "node:async_hooks";

import type { MemberRole, MembershipStatus } from "@ses/domain";

/**
 * Per-request context, propagated without parameter threading.
 *
 * Implemented over `AsyncLocalStorage` because a request id has to be reachable
 * from a service five calls deep and from an exception filter, neither of which
 * receives the HTTP request.
 *
 * **Scope: the request id, the authenticated user, and — on a route that asked
 * for one — the society and the caller's membership in it** (T019's extension
 * once T038's guard chain existed). What is here is what the layers below
 * actually read: a correlation id for logging, a user id for the audit trail, and
 * a tenant scope for the repositories, so a repository never takes `societyId`
 * from a request body.
 *
 * It is still not called `ActorContext`, because a `UserId` alone is not an
 * actor: it says who called, not what they may do. `membership.role` is what they
 * may do, and it is derived from the database rather than from a token claim.
 *
 * The store is entered by `RequestContextInterceptor`, which runs *after* guards
 * and *before* pipes and handlers (Nest's documented lifecycle order), so
 * everything downstream of an interceptor can read it. Middleware and guards run
 * outside it; they receive the request object directly, as they always did —
 * which is why the actor and the society context are written onto the request by
 * the guards and copied in here, rather than written here by the guards.
 */

/** The membership facts a guard or a repository needs, without the whole object. */
export type MemberContext = {
  readonly membershipId: string;
  readonly societyId: string;
  readonly role: MemberRole;
  readonly status: MembershipStatus;
};

export type RequestContextStore = {
  readonly requestId: string;
  /** Absent on a `@Public()` route, or outside a request entirely. */
  readonly userId: string | undefined;
  /**
   * Absent on every route that declared no permission — which is most of them,
   * including anything a user reaches before they belong to a society.
   */
  readonly member: MemberContext | undefined;
};

const storage = new AsyncLocalStorage<RequestContextStore>();

export const RequestContext = {
  /** Runs `callback` with `store` visible to it and to everything it awaits. */
  run<T>(store: RequestContextStore, callback: () => T): T {
    return storage.run(store, callback);
  },

  /** Undefined outside a request (a worker job, a script, a unit test). */
  get(): RequestContextStore | undefined {
    return storage.getStore();
  },

  requestId(): string | undefined {
    return storage.getStore()?.requestId;
  },

  /** The authenticated caller, for audit logging. Never an authorisation input. */
  userId(): string | undefined {
    return storage.getStore()?.userId;
  },

  /** The membership resolved by `SocietyGuard`, when the route asked for one. */
  member(): MemberContext | undefined {
    return storage.getStore()?.member;
  },

  /** The tenant scope of this request, when it has one. */
  societyId(): string | undefined {
    return storage.getStore()?.member?.societyId;
  },
} as const;
