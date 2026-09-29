import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The load-bearing clauses of the Redis scripts, pinned as text.
 *
 * ## Why this is not a behavioural test, and why it is here anyway
 *
 * The four scripts in `membership-cache.redis.ts` are the production path, and this
 * environment has no Redis to execute them against (no server binary, no Docker).
 * That is a real gap and §15 of this task's rules is explicit that it must be
 * reported rather than papered over — the report says the same thing, and the
 * in-memory adapter implements the identical protocol and *is* executed, which is
 * what makes the protocol itself verified.
 *
 * What this file adds is narrower and still worth having: each of these strings is
 * the line that makes a safety property hold, and every one of them can be deleted
 * by an edit that still looks like a simplification. `store` without its gate check
 * is a cache that repopulates during a mutation; `commit` without its version bump
 * is a revocation that only works if the delete succeeds; `begin` written as `SET`
 * rather than `INCR` is two concurrent writers clobbering each other's count.
 *
 * So the assertions are about *presence and order*, not about behaviour, and the
 * docstring says so rather than implying more.
 */

const SOURCE = readFileSync(
  join(__dirname, "..", "membership-cache.redis.ts"),
  "utf8",
);

function script(name: string): string {
  const start = SOURCE.indexOf(`const ${name} = \``);
  expect(start).toBeGreaterThan(-1);
  const end = SOURCE.indexOf("`;", start);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe("membership cache scripts", () => {
  it("lookup refuses to answer while the gate is up", () => {
    const lookup = script("LOOKUP_SCRIPT");
    expect(lookup).toContain("'bypass'");
    // The gate must be read before the entry, or a mutation starting mid-script
    // could be invisible to it.
    expect(lookup.indexOf("GET", lookup.indexOf("KEYS[1]"))).toBeLessThan(
      lookup.indexOf("KEYS[3]"),
    );
  });

  it("lookup treats an entry stored under another version as a miss", () => {
    expect(script("LOOKUP_SCRIPT")).toContain("tostring(decoded.v) ~= ver");
  });

  it("store refuses to write during a mutation or after a version bump", () => {
    const store = script("STORE_SCRIPT");
    expect(store).toContain("tonumber(gate) > 0");
    expect(store).toContain("if ver ~= ARGV[1] then return 0 end");
  });

  it("begin raises the gate with INCR and sets a TTL only when it is raised", () => {
    const begin = script("BEGIN_SCRIPT");
    expect(begin).toContain("redis.call('INCR', KEYS[1])");
    // `SET` would reset a count another in-flight writer is relying on, and an
    // unconditional `EXPIRE` would let a leaked gate be kept alive forever.
    expect(begin).not.toContain("redis.call('SET'");
    expect(begin).toContain("if n == 1 then");
  });

  it("commit bumps the version before it lowers the gate", () => {
    const commit = script("COMMIT_SCRIPT");
    expect(commit).toContain("INCR', KEYS[2]");
    expect(commit).toContain("lowerGate");
    // The invalidation must precede the gate coming down: the other order leaves a
    // window in which a reader is allowed to answer and the entry is still there.
    expect(commit.indexOf("INCR', KEYS[2]")).toBeLessThan(
      commit.indexOf("lowerGate"),
    );
  });

  it("holds the gate only while it is non-zero, deleting rather than leaving a 0", () => {
    const lower = SOURCE.slice(SOURCE.indexOf("const LOWER_GATE_FUNCTION"));
    expect(lower).toContain("if n <= 0 then");
    expect(lower).toContain("redis.call('DEL', gateKey)");
  });
});
