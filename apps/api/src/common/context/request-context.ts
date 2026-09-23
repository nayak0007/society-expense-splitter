import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request context, propagated without parameter threading.
 *
 * Implemented over `AsyncLocalStorage` because a request id has to be reachable
 * from a service five calls deep and from an exception filter, neither of which
 * receives the HTTP request.
 *
 * **Scope is deliberately narrow: the request id and the authenticated user.**
 * T019 extends this same store with the member, the society and the role once
 * the guard chain exists; what is here now is what the layers below actually
 * read — a correlation id for logging and a user id for the audit trail. It is
 * still not called `ActorContext`, because a `UserId` alone is not an actor: it
 * says who called, not what they may do.
 *
 * The store is entered by `RequestContextInterceptor`, which runs *after* guards
 * and *before* pipes and handlers (Nest's documented lifecycle order), so
 * everything downstream of an interceptor can read it. Middleware and guards run
 * outside it; they receive the request object directly, as they always did —
 * which is why the actor is written onto the request by the guard and copied in
 * here, rather than written here by the guard.
 */

export type RequestContextStore = {
  readonly requestId: string;
  /** Absent on a `@Public()` route, or outside a request entirely. */
  readonly userId: string | undefined;
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
} as const;
