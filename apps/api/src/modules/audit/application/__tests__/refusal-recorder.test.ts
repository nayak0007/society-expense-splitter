import { Logger } from "@nestjs/common";
import type { AuditEntry } from "@ses/domain";

import type { PermissionRefusal } from "../../../../common/authorization/security-event-recorder";
import {
  UnitOfWork,
  type TransactionActor,
} from "../../../../infrastructure/database/unit-of-work";
import { RefusalRecorderService } from "../refusal-recorder.service";

/**
 * The refusal recorder's own boundary — T050 Stage E2, ADR-0014 D14.
 *
 * What the guard hands over is the guard suite's business; what this file owns is the
 * other half: the entry's shape, the *derived* idempotency key that bounds the write, and
 * the two failure behaviours — a duplicate is the dedup working, and anything else is
 * logged and swallowed so a `403` never becomes a `500`.
 *
 * The writer itself is stubbed here rather than mocked at the SQL level, because the real
 * one is asserted against PostgreSQL in the integration suite; this is the unit-level
 * question of what gets handed to it.
 */

const SOCIETY = "b1f0c8e2-4a7d-4f1e-9b23-6c5d8e9f0a12";
const ACTOR = "9f8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

interface Captured {
  readonly actor: TransactionActor;
  readonly entries: readonly AuditEntry[];
}

/** A `UnitOfWork` stand-in that records the flush and can fail it on demand. */
function stubUnitOfWork(options: { readonly failWith?: unknown } = {}): {
  readonly unitOfWork: UnitOfWork;
  readonly captured: Captured[];
} {
  const captured: Captured[] = [];
  const unitOfWork = {
    transaction: async <T>(
      actor: TransactionActor,
      work: (tx: never) => Promise<T>,
      audit?: readonly AuditEntry[] | ((result: T) => readonly AuditEntry[]),
    ): Promise<T> => {
      const result = await work(undefined as never);
      const entries =
        typeof audit === "function" ? audit(result) : (audit ?? []);
      if (options.failWith !== undefined) {
        throw options.failWith;
      }
      captured.push({ actor, entries });
      return result;
    },
  } as unknown as UnitOfWork;
  return { unitOfWork, captured };
}

function refusalOf(
  overrides: Partial<PermissionRefusal> = {},
): PermissionRefusal {
  return {
    societyId: SOCIETY,
    actorUserId: ACTOR,
    actorRole: "resident",
    reason: "role_denied",
    action: "expense.publish",
    controller: "ExpensesController",
    handler: "publish",
    requestId: "req-refusal-1",
    ip: "203.0.113.9",
    userAgent: "stage-e2-suite/1.0",
    ...overrides,
  };
}

/** Postgres's shape for a unique violation, as `asErrorLike` unwraps it. */
function uniqueViolation(): unknown {
  return {
    code: "23505",
    message:
      'duplicate key value violates unique constraint "uq_audit_logs_operation_id"',
    constraint_name: "uq_audit_logs_operation_id",
  };
}

describe("RefusalRecorderService", () => {
  it("writes one refusal entry in its own transaction, as the refuser", async () => {
    const { unitOfWork, captured } = stubUnitOfWork();
    const recorder = new RefusalRecorderService(unitOfWork);

    await recorder.recordRefusal(refusalOf());

    expect(captured).toHaveLength(1);
    expect(captured[0]?.actor).toEqual({ kind: "user", userId: ACTOR });

    const entry = captured[0]?.entries[0];
    expect(entry).toMatchObject({
      societyId: SOCIETY,
      actorUserId: ACTOR,
      actorRole: "resident",
      // `other`: a refusal is an access event, not financial state — so it stays out of a
      // Treasurer's narrowed view, exactly like `audit.viewed` (D13/D14).
      category: "other",
      action: "security.permission_denied",
      entityType: "permission",
      // A refusal addresses no row, and the guard runs before any record exists.
      entityId: null,
      // Nothing changed and nothing rolled back.
      before: null,
      after: null,
    });
  });

  it("carries the reason, the refused action and the trusted request facts", async () => {
    const { unitOfWork, captured } = stubUnitOfWork();
    const recorder = new RefusalRecorderService(unitOfWork);

    await recorder.recordRefusal(
      refusalOf({ reason: "member_inactive", action: "cycle.publish" }),
    );

    expect(captured[0]?.entries[0]?.metadata).toMatchObject({
      reason: "member_inactive",
      permission: "cycle.publish",
      controller: "ExpensesController",
      handler: "publish",
      requestId: "req-refusal-1",
      ip: "203.0.113.9",
      userAgent: "stage-e2-suite/1.0",
    });
  });

  it("bounds the write with a key derived from the member, action, reason and hour", async () => {
    const first = stubUnitOfWork();
    const second = stubUnitOfWork();
    const at = new Date("2026-10-16T09:15:00.000Z");

    jest.useFakeTimers().setSystemTime(at);
    await new RefusalRecorderService(first.unitOfWork).recordRefusal(
      refusalOf(),
    );
    // A second refusal in the same hour is *the same* key — the unique constraint is the
    // dedup mechanism, and it needs no shared state to work.
    jest.setSystemTime(new Date("2026-10-16T09:59:59.000Z"));
    await new RefusalRecorderService(second.unitOfWork).recordRefusal(
      refusalOf(),
    );

    const nextHour = stubUnitOfWork();
    jest.setSystemTime(new Date("2026-10-16T10:00:00.000Z"));
    await new RefusalRecorderService(nextHour.unitOfWork).recordRefusal(
      refusalOf(),
    );

    const other = stubUnitOfWork();
    jest.setSystemTime(at);
    await new RefusalRecorderService(other.unitOfWork).recordRefusal(
      refusalOf({ action: "society.delete" }),
    );
    jest.useRealTimers();

    const keyOf = (captured: Captured[]): string =>
      captured[0]!.entries[0]!.operationId;

    expect(keyOf(first.captured)).toBe(keyOf(second.captured));
    expect(keyOf(first.captured)).not.toBe(keyOf(nextHour.captured));
    expect(keyOf(first.captured)).not.toBe(keyOf(other.captured));
    // A well-formed uuid, because the column is one and the writer takes it as such.
    expect(keyOf(first.captured)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("treats a duplicate operation id as the dedup working, not as a failure", async () => {
    const error = jest.spyOn(Logger.prototype, "error").mockImplementation();
    const { unitOfWork } = stubUnitOfWork({ failWith: uniqueViolation() });
    const recorder = new RefusalRecorderService(unitOfWork);

    await expect(recorder.recordRefusal(refusalOf())).resolves.toBeUndefined();
    expect(error).not.toHaveBeenCalled();

    error.mockRestore();
  });

  it("swallows any other failure, and says so on the logger", async () => {
    const logged = jest.spyOn(Logger.prototype, "error").mockImplementation();
    const { unitOfWork } = stubUnitOfWork({
      failWith: new Error("the writer is unreachable"),
    });
    const recorder = new RefusalRecorderService(unitOfWork);

    // Fail-open: the guard is about to answer 403 either way, and turning that into a 500
    // would misreport a correct refusal without restoring the missing row (D14).
    await expect(recorder.recordRefusal(refusalOf())).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0]?.[0])).toContain("expense.publish");

    logged.mockRestore();
  });
});
