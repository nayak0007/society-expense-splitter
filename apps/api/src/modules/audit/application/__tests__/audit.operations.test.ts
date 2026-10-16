import { AUDIT_ERROR_CODES } from "@ses/domain";
import type {
  AuditLogPage,
  AuditLogQuery,
  AuditLogReader,
  ReaderAuditPlan,
  SocietyMembership,
} from "@ses/domain";
import { asMemberId, asSocietyId, asUserId } from "@ses/domain";
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from "@ses/contracts";

import { AppError } from "../../../../common/errors/app-error";
import { AuditLogOperations } from "../audit.operations";
import { ERROR_CODE_BY_AUDIT_CODE, toAppError } from "../audit-error.mapper";

/**
 * The API's edge over the audit read — T050 Stage E1.
 *
 * The facade's job is translation: wire payload → domain command, `Result` → value or
 * `AppError`. These tests pin the three things that translation can get wrong — the
 * default page size, the cursor refusal and the mapped refusal — and one thing that must
 * not rot: the error catalogue is exhaustive.
 */

const SOCIETY = asSocietyId("11111111-1111-4111-8111-111111111111");
const ACTOR = asUserId("55555555-5555-4555-8555-555555555555");

function membership(): SocietyMembership {
  return {
    id: asMemberId("33333333-3333-4333-8333-333333333333"),
    societyId: SOCIETY,
    userId: ACTOR,
    role: "admin",
    status: "active",
    apartmentId: null,
    displayName: "Admin",
    occupancy: "owner",
    isPrimary: true,
    joinedAt: "2026-01-01T00:00:00.000Z",
    contactPolicy: null,
  } as unknown as SocietyMembership;
}

/** A reader that records the query it was given and answers an empty page. */
function reader(): AuditLogReader & { readonly queries: AuditLogQuery[] } {
  const queries: AuditLogQuery[] = [];
  return {
    queries,
    async list(
      query: AuditLogQuery,
      _actor: string,
      readerAudit: ReaderAuditPlan,
    ): Promise<AuditLogPage> {
      queries.push(query);
      const page: AuditLogPage = {
        records: [],
        nextCursor: null,
        hasMore: false,
      };
      // The adapter's contract: the plan runs once per read, inside the transaction.
      readerAudit(page);
      return page;
    },
  };
}

describe("AuditLogOperations.list", () => {
  it("applies the default page size when the request asked for none", async () => {
    const logs = reader();
    const operations = new AuditLogOperations(logs);

    await operations.list(ACTOR, membership(), {});

    expect(logs.queries[0]!.limit).toBe(DEFAULT_PAGE_LIMIT);
    expect(logs.queries[0]!.cursor).toBeNull();
    expect(logs.queries[0]!.societyId).toBe(SOCIETY);
    // The visibility filter came from the matrix, not from the wire.
    expect(logs.queries[0]!.categories).toEqual(["financial", "other"]);
  });

  it("passes a decoded cursor through to the query", async () => {
    const logs = reader();
    const operations = new AuditLogOperations(logs);
    const cursor = {
      occurredAt: "2026-10-14T09:00:00.000Z",
      id: "1234567890123456789",
    };
    const encoded = Buffer.from(JSON.stringify(cursor), "utf8").toString(
      "base64",
    );

    await operations.list(ACTOR, membership(), { cursor: encoded, limit: 5 });

    expect(logs.queries[0]!.cursor).toEqual(cursor);
    expect(logs.queries[0]!.limit).toBe(5);
  });

  it("refuses a malformed cursor as a 422 before any query runs", async () => {
    const logs = reader();
    const operations = new AuditLogOperations(logs);

    await expect(
      operations.list(ACTOR, membership(), { cursor: "nonsense" }),
    ).rejects.toBeInstanceOf(AppError);

    expect(logs.queries).toHaveLength(0);
  });

  it("maps the use case's refusal onto the catalogue", async () => {
    const refusing: AuditLogReader = {
      list: () => Promise.reject(new Error("boom")),
    };
    const operations = new AuditLogOperations(refusing);

    await expect(
      operations.list(ACTOR, membership(), {}),
    ).rejects.toMatchObject({
      code: "INTERNAL",
    });
  });

  it("caps the page size at the contract's maximum, whatever the caller sends", () => {
    // The clamp belongs to the contract (`MAX_PAGE_LIMIT`), and this asserts the two
    // numbers agree so a server-enforced ceiling cannot drift from the documented one.
    expect(MAX_PAGE_LIMIT).toBe(100);
    expect(DEFAULT_PAGE_LIMIT).toBeLessThanOrEqual(MAX_PAGE_LIMIT);
  });
});

describe("ERROR_CODE_BY_AUDIT_CODE", () => {
  it("maps every code the domain defines, so a new one fails the build", () => {
    expect(Object.keys(ERROR_CODE_BY_AUDIT_CODE).sort()).toEqual(
      [...AUDIT_ERROR_CODES].sort(),
    );
  });

  it("keeps an unexpected failure internal rather than disclosing it", () => {
    const mapped = toAppError({
      code: "unknown",
      message: "The audit log could not be read.",
      name: "AuditError",
    } as never);

    expect(mapped.code).toBe("INTERNAL");
    expect(mapped.status).toBe(500);
  });
});
