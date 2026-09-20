import type { Result, SocietyError } from "@ses/domain";

/**
 * Narrowing helpers for asserting on `Result`.
 *
 * A test that reaches into `result.value` without proving `ok` first would
 * compile only by casting, and a failure would surface as `undefined is not a
 * function` fifty lines later. These two make the assertion say what it means,
 * and give a readable message when the branch is the wrong one.
 */
export function expectOk<TValue>(result: Result<TValue, SocietyError>): TValue {
  if (!result.ok) {
    throw new Error(
      `Expected the operation to succeed, but it failed with "${result.error.code}": ${result.error.message}`,
    );
  }
  return result.value;
}

export function expectErr<TValue>(
  result: Result<TValue, SocietyError>,
): SocietyError {
  if (result.ok) {
    throw new Error("Expected the operation to fail, but it succeeded.");
  }
  return result.error;
}
