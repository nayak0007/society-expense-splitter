/**
 * `Result` — the domain's answer to "this can fail in ways the caller must
 * handle" (Roadmap T011: `packages/domain/src/shared/result.ts`).
 *
 * Why not exceptions: a use case has a small, closed set of expected failures —
 * "the join code is expired", "only an Admin may do this" — and those are part
 * of its contract, not accidents. Returning them makes the union exhaustive
 * (`switch` with no `default` compiles), keeps the failure list visible at the
 * call site, and means no test has to assert on message text of a thrown error.
 *
 * Exceptions are still used for the genuinely exceptional: a broken invariant, a
 * bug, a transport failure the adapter could not classify.
 *
 * Zero dependencies, no runtime cost beyond the object literal.
 */

export interface Ok<TValue> {
  readonly ok: true;
  readonly value: TValue;
}

export interface Err<TError> {
  readonly ok: false;
  readonly error: TError;
}

export type Result<TValue, TError> = Ok<TValue> | Err<TError>;

export function ok<TValue>(value: TValue): Ok<TValue> {
  return { ok: true, value };
}

export function err<TError>(error: TError): Err<TError> {
  return { ok: false, error };
}

export function isOk<TValue, TError>(
  result: Result<TValue, TError>,
): result is Ok<TValue> {
  return result.ok;
}

export function isErr<TValue, TError>(
  result: Result<TValue, TError>,
): result is Err<TError> {
  return !result.ok;
}

/** Map the success branch, passing failures through untouched. */
export function mapResult<TValue, TNext, TError>(
  result: Result<TValue, TError>,
  project: (value: TValue) => TNext,
): Result<TNext, TError> {
  return result.ok ? ok(project(result.value)) : result;
}

/** Collapse a result to a plain value, falling back on failure. */
export function unwrapOr<TValue, TError>(
  result: Result<TValue, TError>,
  fallback: TValue,
): TValue {
  return result.ok ? result.value : fallback;
}

/**
 * Run several results in order, stopping at the first failure. Useful for
 * validating a command made of several value objects: the caller learns which
 * field failed without a validation library.
 */
export function allResults<TValue, TError>(
  results: readonly Result<TValue, TError>[],
): Result<readonly TValue[], TError> {
  const values: TValue[] = [];
  for (const result of results) {
    if (!result.ok) return result;
    values.push(result.value);
  }
  return ok(values);
}
