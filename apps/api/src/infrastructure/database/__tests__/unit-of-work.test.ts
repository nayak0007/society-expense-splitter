import { sql } from "drizzle-orm";
import type { AuditEntry } from "@ses/domain";

import type { DatabaseService } from "../database.service";
import { UnitOfWork, type TransactionContext } from "../unit-of-work";

/**
 * `UnitOfWork.transaction`'s identity ordering, asserted on the statements
 * themselves — T050 Stage B, ADR-0014 D5/D7.
 *
 * The real-PostgreSQL suite proves the *effect* (an acceptance records its row as
 * the accepting user); these tests pin the *order* the effect depends on, which no
 * integration assertion can see: the identity is applied from the transaction's
 * actor before `work`, restored from that same actor after `work`, and small
 * enough that nothing runs after the writer. The three properties interact — a
 * restoration placed after the flush would be a no-op, and one using anything but
 * the actor argument would be a tenancy bug with no other symptom.
 *
 * The statements are read back by rendering Drizzle's `SQL` chunks, which is a
 * deliberate coupling to the driver's own structure: there is no seam in which to
 * observe the SQL otherwise, and a change to that structure should fail this test
 * loudly rather than let the ordering drift.
 */

/** Renders a Drizzle `SQL` statement (nested `SQL`/param chunks included) to text. */
function render(statement: unknown): string {
  const chunks = (statement as { queryChunks?: readonly unknown[] })
    .queryChunks;
  if (chunks === undefined) return String(statement);
  return chunks
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      const value = (chunk as { value?: unknown }).value;
      if (Array.isArray(value)) return value.join("");
      if (value !== undefined && value !== null && typeof value !== "object") {
        return String(value);
      }
      if ((chunk as { queryChunks?: unknown }).queryChunks !== undefined) {
        return render(chunk);
      }
      return "";
    })
    .join("");
}

/** A transaction stub that records every statement it is asked to run, in order. */
class RecordingTx {
  readonly statements: string[] = [];

  async execute(statement: unknown): Promise<unknown> {
    this.statements.push(render(statement));
    return [];
  }

  /** Drizzle's savepoint nesting; the inner transaction shares the outer's log. */
  async transaction<T>(
    work: (tx: TransactionContext) => Promise<T>,
  ): Promise<T> {
    return work(this as unknown as TransactionContext);
  }
}

function unitOfWorkOver(tx: RecordingTx): UnitOfWork {
  const database = {
    db: {
      transaction: (work: (inner: TransactionContext) => Promise<unknown>) =>
        work(tx as unknown as TransactionContext),
    },
  } as unknown as DatabaseService;
  return new UnitOfWork(database);
}

/** A valid entry whose actor is deliberately wrong, so a stamp is observable. */
function entry(): AuditEntry {
  return {
    operationId: "op-1",
    societyId: "soc-1",
    actorUserId: "somebody-else",
    actorRole: null,
    category: "other",
    action: "society.updated",
    entityType: "society",
    entityId: "soc-1",
    before: null,
    after: { name: "X" },
    metadata: {},
  };
}

const USER = { kind: "user", userId: "user-1" } as const;

/** Index of the last statement containing `fragment`, or -1. */
function lastIndexOf(statements: readonly string[], fragment: string): number {
  let found = -1;
  statements.forEach((statement, index) => {
    if (statement.includes(fragment)) found = index;
  });
  return found;
}

describe("UnitOfWork.transaction — identity ordering (T050)", () => {
  it("restores the actor's identity after work and before the audit flush", async () => {
    const tx = new RecordingTx();

    await unitOfWorkOver(tx).transaction(
      USER,
      async (context) => {
        await context.execute(sql`select 1 as business`);
        // Exactly what `invitation_accept()` does to the transaction: blanks the
        // transaction-local settings so the invitee's own row is out of the
        // self-service guards' way.
        await context.execute(
          sql`select set_config('request.jwt.claim.sub', '', true)`,
        );
        await context.execute(
          sql`select set_config('request.jwt.claims', '', true)`,
        );
      },
      () => [entry()],
    );

    const statements = tx.statements;

    // Applied up front, from the actor argument.
    expect(statements[0]).toBe("set local role authenticated");
    expect(statements[1]).toContain("app.user_id");
    expect(statements[1]).toContain("user-1");

    const writer = statements.findIndex((statement) =>
      statement.startsWith("select public.write_audit_logs"),
    );
    expect(writer).toBeGreaterThan(-1);

    // Restored after `work` and before the writer, from the actor again — so the
    // blank the work left behind is not what the writer compares against.
    const restored = lastIndexOf(statements, "request.jwt.claim.sub");
    expect(restored).toBeLessThan(writer);
    expect(statements[restored]).toContain("user-1");

    // And the flushed entry carries that same actor, not the one it arrived with.
    expect(statements[writer]).toContain('"actorUserId":"user-1"');
    expect(statements[writer]).not.toContain("somebody-else");
  });

  it("runs nothing after the audit writer", async () => {
    const tx = new RecordingTx();

    await unitOfWorkOver(tx).transaction(
      USER,
      async (context) => {
        await context.execute(sql`select 1 as business`);
      },
      () => [entry()],
    );

    const writer = tx.statements.findIndex((statement) =>
      statement.startsWith("select public.write_audit_logs"),
    );
    expect(writer).toBeGreaterThan(-1);
    // No business statement survives the writer; the flush is the last thing the
    // transaction does.
    expect(tx.statements.slice(writer + 1)).toEqual([]);
    expect(tx.statements[writer - 2]).toBe("reset role");
    expect(tx.statements[writer - 1]).toBe("set local role ses_api");
  });

  it("does nothing beyond the up-front identity when the batch is empty", async () => {
    const tx = new RecordingTx();

    await unitOfWorkOver(tx).transaction(
      USER,
      async (context) => {
        await context.execute(sql`select 1 as business`);
      },
      [],
    );

    expect(
      tx.statements.some((statement) => statement.includes("write_audit_logs")),
    ).toBe(false);
    expect(tx.statements).not.toContain("reset role");
    // The identity is applied once and never re-applied on a read path.
    expect(
      tx.statements.filter((statement) =>
        statement.includes("request.jwt.claim.sub"),
      ),
    ).toHaveLength(1);
  });

  it("leaves a system transaction without a role switch, and records a null actor", async () => {
    const tx = new RecordingTx();

    await unitOfWorkOver(tx).transaction(
      null,
      async (context) => {
        await context.execute(sql`select 1 as business`);
      },
      () => [entry()],
    );

    expect(tx.statements).not.toContain("set local role authenticated");
    expect(
      tx.statements.some((statement) => statement.includes("app.user_id")),
    ).toBe(false);
    const writer = tx.statements.findIndex((statement) =>
      statement.startsWith("select public.write_audit_logs"),
    );
    // A null actor is not an error: the row is recorded as the system's.
    expect(tx.statements[writer]).toContain('"actorUserId":null');
  });
});
