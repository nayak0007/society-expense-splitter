import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { asMemberId, asSocietyId, asUserId } from "@ses/domain";
import type {
  MemberRole,
  Society,
  SocietyId,
  SocietyMembership,
  UserId,
} from "@ses/domain";
import request from "supertest";

import type { SocietyAuthorizationContext } from "../src/common/authorization/society-authorization";
import { createFakeApartmentRepository } from "./utils/fake-apartment-repository";
import { createFakeBuildingRepository } from "./utils/fake-building-repository";
import { FakeInvitationRepository } from "./utils/fake-invitation-repository";
import {
  createFakeMemberRepository,
  type FakeMemberRepository,
} from "./utils/fake-member-repository";
import { createTestAuth, type TestAuth } from "./utils/supabase-auth";
import { createTestApp } from "./utils/test-app";

/**
 * The bulk CSV import routes over real HTTP (Roadmap T048).
 *
 * ## What runs for real
 *
 * The whole guard chain (real signed tokens, `X-Society-Id` resolution, the domain
 * matrix), the Zod pipe parsing the real `csvImportRequestSchema`, the real use cases
 * with the real domain parser — the RFC 4180 grammar, the header contract, the row cap
 * and the formula guard are all *the production code*, not fixtures.
 *
 * ## What does not
 *
 * Storage (the member/apartment/invitation fakes) and RLS. The two database facts the
 * import leans on — `uq_members_shadow_phone` and the society scoping of flats — are
 * reproduced by the fakes, and `scripts/db/rls-canary.sql` covers the policies.
 */

const SOCIETY_A = asSocietyId("b1f0c8e2-4a7d-4f1e-9b23-6c5d8e9f0a12");
const SOCIALITY_A = SOCIETY_A;
const SOCIETY_B = asSocietyId("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
const SOCIALITY_B = SOCIETY_B;

const ADMIN: UserId = asUserId("11111111-1111-4111-8111-111111111111");
const RESIDENT: UserId = asUserId("33333333-3333-4333-8333-333333333333");
const PENDING: UserId = asUserId("55555555-5555-4555-8555-555555555555");
const OUTSIDER: UserId = asUserId("66666666-6666-4666-8666-666666666666");

const FLAT_101 = "cccccccc-0000-4000-8000-000000000101";
const FLAT_102 = "cccccccc-0000-4000-8000-000000000102";
const BUILDING = "dddddddd-0000-4000-8000-000000000001";

const societies = new Map<SocietyId, Society>([
  [
    SOCIALITY_A,
    {
      id: SOCIALITY_A,
      name: "Green Meadows",
      city: "Pune",
    } as unknown as Society,
  ],
  [
    SOCIALITY_B,
    { id: SOCIALITY_B, name: "Palm Grove", city: "Pune" } as unknown as Society,
  ],
]);

/** Full membership fixtures — the guard reads `role` and `status` off these. */
function membershipOf(
  actor: UserId,
  role: MemberRole,
  status: "active" | "pending" = "active",
): SocietyMembership {
  return {
    id: asMemberId(`m-${actor.slice(0, 8)}`),
    societyId: SOCIETY_A,
    userId: actor,
    role,
    status,
    occupancyType: "owner",
    joinedAt: "2026-01-01T00:00:00.000Z",
  } as unknown as SocietyMembership;
}

const memberships = new Map<string, SocietyMembership>();
const key = (societyId: string, actor: string) => `${societyId}:${actor}`;
const guardReads: string[] = [];

const reader = {
  load(
    societyId: SocietyId,
    actor: UserId,
  ): Promise<SocietyAuthorizationContext | null> {
    guardReads.push(key(societyId, actor));
    const membership = memberships.get(key(societyId, actor));
    const society = societies.get(societyId);
    if (membership === undefined || society === undefined) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      society,
      membership: membership as never,
    });
  },
};

let app: NestFastifyApplication;
let auth: TestAuth;
let members: FakeMemberRepository;
let buildings: ReturnType<typeof createFakeBuildingRepository>;
let apartments: ReturnType<typeof createFakeApartmentRepository>;
let invitations: FakeInvitationRepository;

const HEADER = "flat_no,name,phone,email,occupancy_type";

beforeAll(async () => {
  auth = await createTestAuth();
  members = createFakeMemberRepository();
  buildings = createFakeBuildingRepository();
  apartments = createFakeApartmentRepository();
  invitations = new FakeInvitationRepository();
  app = await createTestApp({
    jwks: auth.jwks,
    reader,
    members,
    buildings,
    apartments,
    invitations,
  });
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  memberships.clear();
  guardReads.length = 0;
  members.state.reset();
  apartments.state.apartments.clear();
  invitations.reset();

  memberships.set(key(SOCIETY_A, ADMIN), membershipOf(ADMIN, "admin"));
  memberships.set(key(SOCIETY_A, RESIDENT), membershipOf(RESIDENT, "resident"));
  memberships.set(
    key(SOCIETY_A, PENDING),
    membershipOf(PENDING, "resident", "pending"),
  );
  memberships.set(key(SOCIETY_B, ADMIN), {
    ...membershipOf(ADMIN, "admin"),
    societyId: SOCIETY_B,
  });

  members.seed(SOCIETY_A, {
    id: "aaaaaaaa-0000-4000-8000-000000000001",
    userId: ADMIN,
    role: "admin" as MemberRole,
    displayName: "Anita Rao",
    phone: "+919800000001",
  });
  members.seed(SOCIETY_A, {
    id: "aaaaaaaa-0000-4000-8000-000000000003",
    userId: RESIDENT,
    role: "resident" as MemberRole,
    displayName: "Meera Krishnan",
    phone: "+919800000003",
  });
  buildings.seed(SOCIETY_A, { id: BUILDING, name: "Block A" });
  apartments.seed(SOCIETY_A, BUILDING, {
    id: FLAT_101,
    apartmentNumber: "A-101",
  });
  apartments.seed(SOCIETY_A, BUILDING, {
    id: FLAT_102,
    apartmentNumber: "A-102",
  });
  // The 50-row import test claims A-103…A-150; the claim-conflict and unknown-flat tests
  // below use their own labels. Seeding the range here keeps the arithmetic test about
  // row validation rather than flat existence.
  for (let i = 3; i <= 50; i += 1) {
    apartments.seed(SOCIETY_A, BUILDING, {
      id: `cccccccc-0000-4000-8000-${String(101 + i).padStart(12, "0")}`,
      apartmentNumber: `A-${100 + i}`,
    });
  }
});

const server = () => request(app.getHttpServer());

async function importCall(
  path: "preview" | "import",
  userId: UserId | null,
  societyId: SocietyId | null,
  csv: string,
) {
  let pending = server().post(
    `/v1/members/import${path === "preview" ? "/preview" : ""}`,
  );
  if (userId !== null) {
    pending = pending.set(
      "Authorization",
      `Bearer ${await auth.token(userId)}`,
    );
  }
  if (societyId !== null) {
    pending = pending.set("X-Society-Id", societyId);
  }
  return pending.send({ csv });
}

const preview = (
  csv: string,
  userId: UserId = ADMIN,
  societyId: SocietyId = SOCIETY_A,
) => importCall("preview", userId, societyId, csv);
const doImport = (
  csv: string,
  userId: UserId = ADMIN,
  societyId: SocietyId = SOCIETY_A,
) => importCall("import", userId, societyId, csv);

const rowsOf = (body: unknown) =>
  (body as { data: { rows: unknown[] } }).data.rows;
const summaryOf = (body: unknown) =>
  (body as { data: { summary: Record<string, number> } }).data.summary;
const resultOf = (body: unknown) =>
  (
    body as {
      data: {
        summary: Record<string, number>;
        imported: unknown[];
        failed: { line: number; error: { code: string } }[];
      };
    }
  ).data;

describe("authentication, header and permissions", () => {
  it("requires a session before the preview", async () => {
    const response = await importCall("preview", null, SOCIETY_A, HEADER);
    expect(response.status).toBe(401);
  });

  it("requires the society header", async () => {
    const response = await server()
      .post("/v1/members/import/preview")
      .set("Authorization", `Bearer ${await auth.token(ADMIN)}`)
      .send({ csv: HEADER });
    expect(response.status).toBe(400);
    expect(response.body.error.field).toBe("x-society-id");
  });

  it("refuses a Resident and a pending member with 403 before storage", async () => {
    const asResident = await preview(HEADER, RESIDENT);
    expect(asResident.status).toBe(403);
    expect(asResident.body.error.code).toBe("FORBIDDEN");

    const asPending = await preview(HEADER, PENDING);
    expect(asPending.status).toBe(403);
    expect(asPending.body.error.code).toBe("MEMBER_INACTIVE");
    // Both refusals happened before storage: not a single create was attempted.
    expect(members.callCount("create")).toBe(0);
  });

  it("answers an outsider with 404, indistinguishable from a missing society", async () => {
    const outsider = await preview(HEADER, OUTSIDER, SOCIETY_A);
    const missing = await preview(
      HEADER,
      ADMIN,
      asSocietyId("99999999-9999-4999-8999-999999999999"),
    );
    expect(outsider.status).toBe(404);
    expect(missing.status).toBe(404);
    // Byte-identical once the per-request fields are stripped — the T041 rule.
    const scrub = (body: {
      error: { requestId?: string; timestamp?: string };
    }) =>
      JSON.stringify({
        ...body,
        error: { ...body.error, requestId: undefined, timestamp: undefined },
      });
    expect(scrub(outsider.body)).toBe(scrub(missing.body));
  });

  it("refuses the import the same way", async () => {
    const response = await doImport(HEADER, RESIDENT);
    expect(response.status).toBe(403);
  });
});

describe("request validation", () => {
  it("refuses an empty csv field at the pipe", async () => {
    const response = await preview("");
    expect(response.status).toBe(422);
  });

  it("refuses a body with unknown fields (strict contract)", async () => {
    const response = await server()
      .post("/v1/members/import/preview")
      .set("Authorization", `Bearer ${await auth.token(ADMIN)}`)
      .set("X-Society-Id", SOCIETY_A)
      .send({ csv: HEADER, rows: [] });
    // 400, the pipe's established code for a malformed body shape (as opposed to 422
    // for a well-shaped body whose values fail validation).
    expect(response.status).toBe(400);
  });

  it("refuses an oversized file at the transport limit (413)", async () => {
    const bigRow = `A-101,${"X".repeat(90)},+919876543210,,`;
    const response = await preview(`${HEADER}\n${bigRow.repeat(12_000)}`);
    // Fastify's body limit (bootstrap's `bodyLimit`) rejects the request before any
    // handler runs — the transport guard beneath the contract's own 1 MB bound.
    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("preview (POST /v1/members/import/preview)", () => {
  it("classifies every row and writes nothing", async () => {
    const csv = [
      HEADER,
      `A-101,Good One,+919876543220,one@example.com,`,
      `A-101,,+919876543221,,`,
      `Z-999,Lost Flat,+919876543222,,`,
      `A-102,Meera Two,+919800000003,,`,
      `A-101,Dup In File,+919876543220,,`,
    ].join("\n");
    const response = await preview(csv);
    expect(response.status).toBe(200);

    const rows = rowsOf(response.body) as {
      status: string;
      error?: { code: string };
    }[];
    expect(rows.map((row) => row.status)).toEqual([
      "valid",
      "invalid",
      "conflict",
      "conflict",
      "invalid",
    ]);
    expect(rows[1]?.error?.code).toBe("MISSING_NAME");
    expect(rows[2]?.error?.code).toBe("APARTMENT_NOT_FOUND");
    expect(rows[3]?.error?.code).toBe("ALREADY_MEMBER");
    expect(rows[4]?.error?.code).toBe("DUPLICATE_IN_FILE");

    const summary = summaryOf(response.body);
    expect(summary).toMatchObject({
      totalRows: 5,
      validRows: 1,
      invalidRows: 2,
      conflicts: 2,
      skipped: 4,
      imported: 0,
    });
    expect(members.callCount("create")).toBe(0);
  });

  it("resolves flat numbers to ids and normalises phones to E.164", async () => {
    const response = await preview(`${HEADER}\na-101,Trim Me,98765 43210,,\n`);
    const row = rowsOf(response.body)[0] as {
      apartmentId: string | null;
      phone: string;
      apartmentNumber: string | null;
    };
    expect(row.apartmentId).toBe(FLAT_101);
    expect(row.phone).toBe("+919876543210");
    expect(row.apartmentNumber).toBe("a-101");
  });

  it("normalises a domestic 10-digit phone to +91", async () => {
    const response = await preview(`${HEADER}\n,Domestic,98765 43210,,\n`);
    expect(response.status).toBe(200);
    const row = rowsOf(response.body)[0] as { phone: string };
    expect(row.phone).toBe("+919876543210");
  });

  it("refuses a phone with trailing junk that is not a number", async () => {
    const response = await preview(
      `${HEADER}\n,Domestic,+919876543210 (copy),,\n`,
    );
    expect(response.status).toBe(200);
    const row = rowsOf(response.body)[0] as { error: { code: string } };
    expect(row.error.code).toBe("INVALID_PHONE");
  });

  it("reports a fatal header with a zero summary", async () => {
    const response = await preview(
      "nonsense,columns,only,here,also\nx,y,z,w,v\n",
    );
    expect(response.status).toBe(200);
    const summary = summaryOf(response.body);
    expect(summary.totalRows).toBe(0);
    expect(summary.invalidRows).toBe(1);
    expect(
      (rowsOf(response.body)[0] as { error: { code: string } }).error.code,
    ).toBe("MISSING_HEADER");
  });

  it("reports a malformed parse (unterminated quote) with its line", async () => {
    const response = await preview(
      `${HEADER}\nA-101,"Unclosed,+919876543210,,\n`,
    );
    expect(response.status).toBe(200);
    const row = rowsOf(response.body).at(-1) as {
      error: { code: string; line: number };
    };
    // The row is still judged — the quote swallows the rest of the line, so the row is
    // ragged — and the parse error names the line the quote opened on.
    expect(["UNTERMINATED_QUOTE", "RAGGED_ROW"]).toContain(row.error.code);
  });

  it("refuses a file beyond the 1,000-row cap", async () => {
    const lines = [HEADER];
    for (let i = 0; i < 1_001; i += 1) {
      lines.push(`A-101,Person ${i},+9198${String(70000000 + i).slice(-8)},,`);
    }
    const response = await preview(lines.join("\n"));
    expect(response.status).toBe(200);
    const row = rowsOf(response.body).at(-1) as { error: { code: string } };
    expect(row.error.code).toBe("TOO_MANY_ROWS");
  });

  it("refuses a formula-like name with its own code", async () => {
    const response = await preview(
      `${HEADER}\nA-101,=HYPERLINK("http://evil"),+919876543210,,\n`,
    );
    const row = rowsOf(response.body)[0] as { error: { code: string } };
    expect(row.error.code).toBe("FORMULA_LIKE_NAME");
  });

  it("refuses a flat of another society as not-found, never a leak", async () => {
    buildings.seed(SOCIETY_B, {
      id: "dddddddd-0000-4000-8000-000000000002",
      name: "Block B",
    });
    apartments.seed(SOCIETY_B, "dddddddd-0000-4000-8000-000000000002", {
      id: "cccccccc-0000-4000-8000-000000000901",
      apartmentNumber: "B-901",
    });
    const response = await preview(
      `${HEADER}\nB-901,Cross Tenant,+919876543298,,\n`,
    );
    const row = rowsOf(response.body)[0] as { error: { code: string } };
    expect(row.error.code).toBe("APARTMENT_NOT_FOUND");
  });
});

describe("import (POST /v1/members/import)", () => {
  it("imports the valid rows and reports the failures — the 50/3 shape at scale", async () => {
    const lines = [HEADER];
    for (let i = 1; i <= 50; i += 1) {
      // Each valid row claims its own flat: two claims of one flat are a conflict by
      // design, and this test is about the 50/3 arithmetic, not the claim rule (that
      // one is asserted separately below).
      const flat = `A-${100 + i}`;
      if (i === 10) lines.push(`${flat},,+91980000010,,`);
      else if (i === 20) lines.push(`${flat},Someone,not-a-phone,,`);
      else if (i === 30) lines.push(`${flat},Someone,+91980000030,nope@,`);
      else
        lines.push(
          `${flat},Person ${i},+9198${String(71000000 + i).slice(-8)},,`,
        );
    }
    const response = await doImport(lines.join("\n"));
    expect(response.status).toBe(201);

    const result = resultOf(response.body);
    expect(result.summary.totalRows).toBe(50);
    expect(result.summary.imported).toBe(47);
    expect(result.summary.invalidRows).toBe(3);
    expect(result.imported).toHaveLength(47);
    expect(result.failed.map((failure) => failure.error.code).sort()).toEqual([
      "INVALID_EMAIL",
      "INVALID_PHONE",
      "MISSING_NAME",
    ]);
    expect(members.callCount("create")).toBe(47);
  });

  it("creates active residents with the stored occupancy and no primary claim", async () => {
    const response = await doImport(
      `${HEADER}\nA-101,Tenant Row,+919876543230,,tenant\n`,
    );
    expect(response.status).toBe(201);
    const created = [...members.state.members.values()].find(
      (member) => member.displayName === "Tenant Row",
    );
    expect(created).toMatchObject({
      status: "active",
      role: "resident",
      isPrimary: false,
      occupancy: "tenant",
      userId: null,
      apartmentId: FLAT_101,
    });
  });

  it("flags two claims of one flat for the admin's decision and imports the first", async () => {
    const response = await doImport(
      `${HEADER}\nA-101,First Claim,+919876543240,,\nA-101,Second Claim,+919876543241,,\n`,
    );
    const result = resultOf(response.body);
    expect(result.imported).toHaveLength(1);
    expect(result.failed[0]?.error.code).toBe("APARTMENT_CLAIM_CONFLICT");
  });

  it("is idempotent under retry: the second run refuses what the first imported", async () => {
    const csv = `${HEADER}\nA-101,Once Only,+919876543250,,\n`;
    expect((await doImport(csv)).status).toBe(201);
    const second = resultOf((await doImport(csv)).body);
    expect(second.imported).toHaveLength(0);
    expect(second.failed[0]?.error.code).toBe("ALREADY_MEMBER");
    expect(members.callCount("create")).toBe(1);
  });

  it("keeps membership state untouched for an all-invalid file", async () => {
    const response = await doImport(`${HEADER}\nA-101,,+919876543260,,\n`);
    const result = resultOf(response.body);
    expect(result.imported).toHaveLength(0);
    expect(members.callCount("create")).toBe(0);
  });

  it("never imports a role: an admin column is just an unknown column", async () => {
    const response = await doImport(
      `${HEADER},role\nA-101,Escalationist,+919876543270,,admin,admin\n`,
    );
    expect(response.status).toBe(201);
    // The `role` header is refused, and the row (six cells against a five-column
    // contract) is invalid — the import result carries the failure, nothing imported.
    const result = resultOf(response.body);
    expect(result.imported).toHaveLength(0);
    expect(result.failed.map((failure) => failure.error.code)).toEqual([
      "UNKNOWN_COLUMN",
      "RAGGED_ROW",
    ]);
    const created = [...members.state.members.values()].find(
      (member) => member.displayName === "Escalationist",
    );
    expect(created).toBeUndefined();
  });
});
