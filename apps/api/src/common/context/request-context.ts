import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request context, propagated without parameter threading.
 *
 * Implemented over `AsyncLocalStorage` because a request id has to be reachable
 * from a service five calls deep and from an exception filter, neither of which
 * receives the HTTP request.
 *
 * **Scope for this slice is deliberately narrow: the request id only.** T019
 * extends this same store with the authenticated actor (`userId`, `member`,
 * `societyId`) and populates it from a guard. It is intentionally not called
 * `ActorContext` yet, because there is no actor to put in it — the store exists
 * because logging needs correlation, not because authorisation does.
 *
 * The store is entered by `RequestContextInterceptor`, which runs *after* guards
 * and *before* pipes and handlers (Nest's documented lifecycle order), so
 * everything downstream of an interceptor can read it. Middleware and guards run
 * outside it; they receive the request object directly, as they always did.
 */

export type RequestContextStore = {
  readonly requestId: string;
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
} as const;
