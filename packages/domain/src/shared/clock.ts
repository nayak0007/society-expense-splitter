/**
 * `Clock` — the domain's only source of "now" (Roadmap T011:
 * `packages/domain/src/shared/clock.ts`).
 *
 * Time-dependent rules (join-code expiry, "was this changed before the lease
 * ended?") are exactly where unit tests become flaky, because they read the
 * wall clock through `Date.now()`. Depending on an injected port instead keeps
 * every rule a total function of its arguments: a test constructs a society
 * whose code expired one second ago and asserts the refusal, with no fake timers
 * and no sleeping.
 */
export interface Clock {
  now(): Date;
  /** ISO-8601 instant — the format stored in every timestamp column. */
  nowIso(): string;
}

export const systemClock: Clock = {
  now: () => new Date(),
  nowIso: () => new Date().toISOString(),
};

/**
 * A clock frozen at one instant. Shipped in the domain (not in test helpers)
 * because it is tiny, has no test-runner dependency, and lets integration code
 * (fixtures, seeding scripts, demos) be deterministic too.
 */
export function fixedClock(instant: string | Date): Clock {
  const frozen = typeof instant === "string" ? new Date(instant) : instant;
  return {
    now: () => new Date(frozen.getTime()),
    nowIso: () => frozen.toISOString(),
  };
}

/** A clock that advances by a fixed step on every read — for ordering tests. */
export function steppingClock(start: string | Date, stepSeconds = 1): Clock {
  let current = typeof start === "string" ? new Date(start) : start;
  return {
    now: () => {
      const value = new Date(current.getTime());
      current = new Date(current.getTime() + stepSeconds * 1000);
      return value;
    },
    nowIso: () => {
      const value = new Date(current.getTime());
      current = new Date(current.getTime() + stepSeconds * 1000);
      return value.toISOString();
    },
  };
}
