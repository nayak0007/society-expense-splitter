import type { MemberError, Result } from "@ses/domain";

/**
 * Narrowing helpers for asserting on `Result` in the member module's tests.
 *
 * Typed to `MemberError` rather than importing the society module's copy: the two are the
 * same three lines, and coupling the member suite to another module's test support is how a
 * package's tests come to depend on a module they have nothing to do with.
 */
export function expectOk<TValue>(result: Result<TValue, MemberError>): TValue {
  if (!result.ok) {
    throw new Error(
      `Expected the operation to succeed, but it failed with "${result.error.code}": ${result.error.message}`,
    );
  }
  return result.value;
}

export function expectErr<TValue>(
  result: Result<TValue, MemberError>,
): MemberError {
  if (result.ok) {
    throw new Error("Expected the operation to fail, but it succeeded.");
  }
  return result.error;
}
