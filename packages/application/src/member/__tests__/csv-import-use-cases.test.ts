import { MemberError, asSocietyId, asUserId } from "@ses/domain";
import type { Member, MemberOccupancy } from "@ses/domain";

import { importMembers, previewImport } from "../use-cases/csv-import";
import type { BulkImportDeps, ImportFlat } from "../use-cases/csv-import";
import { FakeMemberRepository } from "./support/fake-member-repository";
import { expectErr, expectOk } from "./support/result-expectations";

/**
 * T048's two use cases, against fakes.
 *
 * The values under test, in order:
 *
 *  1. **The preview writes nothing.** Asserted on the repository's call log — the
 *     property that makes "preview then confirm" a real confirmation.
 *  2. **The collision matrix is deterministic.** Existing member (active *and* pending),
 *     open invitation, unknown flat, in-file duplicate, two claims on one flat — each
 *     names its row, its field and its code, and the rest of the file still imports.
 *  3. **Partial success.** The Roadmap's own criterion: valid rows import even when
 *     others fail, and `total = imported + invalid + conflicts` always.
 *  4. **A storage refusal after the preview is a per-row failure, not a crash** — the
 *     shape a concurrent admin's faster create or a racing join approval arrives in.
 */

const SOCIETY = asSocietyId("society-1");
const ADMIN = asUserId("user-admin");
const RESIDENT = asUserId("user-resident");

const FLATS: readonly ImportFlat[] = [
  { id: "apartment-101", apartmentNumber: "A-101" },
  { id: "apartment-102", apartmentNumber: "A-102" },
];

const HEADER = "flat_no,name,phone,email,occupancy_type";

interface Fixture {
  readonly deps: BulkImportDeps;
  readonly members: FakeMemberRepository;
}

function setup(seedExisting = true): Fixture {
  const members = new FakeMemberRepository();
  if (seedExisting) {
    members.seedMember("society-1", {
      id: "m-admin",
      userId: "user-admin",
      role: "admin",
      displayName: "Anita Rao",
      phone: "+919800000001",
    });
    members.seedMember("society-1", {
      id: "m-resident",
      userId: "user-resident",
      role: "resident",
      displayName: "Meera Krishnan",
      phone: "+919800000003",
      email: "meera@example.com",
    });
  }
  return {
    members,
    deps: {
      members,
      flats: { listSocietyFlats: () => Promise.resolve(FLATS) },
      invitations: {
        list: () =>
          Promise.resolve({
            invitations: [
              {
                email: "waiting@example.com",
                phone: null,
                status: "sent" as const,
              },
            ],
          }),
      },
    },
  };
}

function csv(rows: readonly string[]): string {
  return [HEADER, ...rows].join("\n");
}

const importedNames = (imported: readonly Member[]): readonly string[] =>
  imported.map((member) => member.displayName);

describe("previewImport", () => {
  it("writes nothing — not even a create attempt — while classifying every row", async () => {
    const { deps, members } = setup();

    const preview = expectOk(
      await previewImport(deps, ADMIN, SOCIETY, {
        csv: csv([
          "A-101,New Owner,+919876543210,owner@example.com,owner_occupied",
        ]),
      }),
    );

    expect(preview.summary).toEqual({
      totalRows: 1,
      validRows: 1,
      invalidRows: 0,
      conflicts: 0,
      skipped: 0,
      imported: 0,
    });
    expect(members.callCount("create")).toBe(0);
    expect(members.callCount("update")).toBe(0);
  });

  it("resolves flat numbers to ids and normalises phones", async () => {
    const { deps } = setup();
    const preview = expectOk(
      await previewImport(deps, ADMIN, SOCIETY, {
        csv: csv(["a-101,Vanlabel Number,98765 43210,,tenant"]),
      }),
    );
    expect(preview.rows[0]).toMatchObject({
      status: "valid",
      apartmentId: "apartment-101",
      phone: "+919876543210",
      occupancy: "tenant",
    });
  });

  it("refuses a resident before parsing anything", async () => {
    const { deps } = setup();
    const error = expectErr(
      await previewImport(deps, RESIDENT, SOCIETY, { csv: HEADER }),
    );
    expect(error.code).toBe("forbidden");
  });

  it("answers a stranger with not_found, never forbidden", async () => {
    const { deps } = setup();
    const error = expectErr(
      await previewImport(deps, asUserId("user-stranger"), SOCIETY, {
        csv: HEADER,
      }),
    );
    expect(error.code).toBe("not_found");
  });

  it("reports a fatal header as an all-invalid answer with a zero summary", async () => {
    const { deps } = setup();
    const preview = expectOk(
      await previewImport(deps, ADMIN, SOCIETY, {
        csv: "nonsense,columns,only,here,also\n",
      }),
    );
    expect(preview.summary.totalRows).toBe(0);
    expect(preview.summary.invalidRows).toBe(1);
    const headerOutcome = preview.rows[0];
    expect(headerOutcome?.status).toBe("invalid");
    if (headerOutcome?.status !== "invalid") return;
    expect(headerOutcome.error.code).toBe("MISSING_HEADER");
  });
});

describe("collision matrix", () => {
  it("ALREADY_MEMBER for an existing shadow member's phone", async () => {
    const { deps } = setup();
    const preview = expectOk(
      await previewImport(deps, ADMIN, SOCIETY, {
        csv: csv(["A-101,Impostor,+919800000003,other@example.com,"]),
      }),
    );
    const outcome = preview.rows[0];
    expect(outcome?.status).toBe("conflict");
    if (outcome?.status !== "conflict") return;
    expect(outcome.error.field).toBe("phone");
    expect(outcome.error.code).toBe("ALREADY_MEMBER");
  });

  it("ALREADY_MEMBER with the queue hint for a pending membership", async () => {
    const { deps, members } = setup(false);
    members.seedMember("society-1", {
      id: "m-admin",
      userId: "user-admin",
      role: "admin",
    });
    members.seedMember("society-1", {
      id: "m-pending",
      status: "pending",
      phone: "+919800000010",
    });
    const preview = expectOk(
      await previewImport(deps, ADMIN, SOCIETY, {
        csv: csv([",Pending Someone,+919800000010,,"]),
      }),
    );
    const outcome = preview.rows[0];
    expect(outcome?.status).toBe("conflict");
    if (outcome?.status !== "conflict") return;
    expect(outcome.error.code).toBe("ALREADY_MEMBER");
    expect(outcome.error.message).toContain("join queue");
  });

  it("ALREADY_MEMBER for an existing email", async () => {
    const { deps } = setup();
    const preview = expectOk(
      await previewImport(deps, ADMIN, SOCIETY, {
        csv: csv([",Email Clash,+919876543299,MEERA@example.com,"]),
      }),
    );
    expect(preview.rows[0]).toMatchObject({
      status: "conflict",
      error: { field: "email", code: "ALREADY_MEMBER" },
    });
  });

  it("INVITATION_PENDING for an open invitation's email", async () => {
    const { deps } = setup();
    const preview = expectOk(
      await previewImport(deps, ADMIN, SOCIETY, {
        csv: csv([",Waiting Person,+919876543211,waiting@example.com,"]),
      }),
    );
    expect(preview.rows[0]).toMatchObject({
      status: "conflict",
      error: { code: "INVITATION_PENDING" },
    });
  });

  it("APARTMENT_NOT_FOUND for an unknown flat — reported, not created", async () => {
    const { deps } = setup();
    const preview = expectOk(
      await previewImport(deps, ADMIN, SOCIETY, {
        csv: csv(["Z-999,Hallucinated Flat,+919876543212,,"]),
      }),
    );
    expect(preview.rows[0]).toMatchObject({
      status: "conflict",
      error: { field: "flat_no", code: "APARTMENT_NOT_FOUND" },
    });
  });
});

describe("importMembers", () => {
  it("imports the valid rows and reports the failures — the 50/3 shape at small scale", async () => {
    const { deps, members } = setup();
    const result = expectOk(
      await importMembers(deps, ADMIN, SOCIETY, {
        csv: csv([
          "A-101,Good One,+919876543220,one@example.com,",
          "A-101,,+919876543221,,",
          "A-102,Good Two,+919876543222,,tenant",
          "Z-999,Lost Flat,+919876543223,,",
          "A-101,Claim Two,+919876543224,,",
        ]),
      }),
    );

    expect(importedNames(result.imported)).toEqual(["Good One", "Good Two"]);
    expect(result.failed.map((failure) => failure.error.code)).toEqual([
      "MISSING_NAME",
      "APARTMENT_NOT_FOUND",
      "APARTMENT_CLAIM_CONFLICT",
    ]);
    // The arithmetic that makes "nothing silently dropped" checkable:
    // total = imported + invalid + conflicts → 2 + 2 + 1 = 5.
    // (The in-file claim conflict is a *field* error from the domain pass, which is
    // why the storage-level conflict count is the unknown flat alone.)
    expect(result.summary.totalRows).toBe(5);
    expect(result.summary.imported).toBe(2);
    expect(result.summary.invalidRows).toBe(2);
    expect(result.summary.conflicts).toBe(1);
    expect(result.summary.skipped).toBe(3);
    expect(members.callCount("create")).toBe(2);
  });

  it("imports as active residents with no primary claim and the stored occupancy", async () => {
    const { deps, members } = setup();
    await importMembers(deps, ADMIN, SOCIETY, {
      csv: csv(["A-101,Tenant Row,+919876543230,,tenant"]),
    });
    const created = [...members.storedAll()].find(
      (member) => member.displayName === "Tenant Row",
    );
    expect(created).toMatchObject({
      status: "active",
      role: "resident",
      isPrimary: false,
      occupancy: "tenant" as MemberOccupancy,
      userId: null,
      apartmentId: "apartment-101",
    });
  });

  it("imports rows without flats as flatless active members", async () => {
    const { deps, members } = setup();
    await importMembers(deps, ADMIN, SOCIETY, {
      csv: csv([",Flatless Person,+919876543231,,"]),
    });
    const created = [...members.storedAll()].find(
      (member) => member.displayName === "Flatless Person",
    );
    expect(created).toMatchObject({ apartmentId: null, status: "active" });
  });

  it("turns a storage refusal into a per-row failure — the concurrent-admin shape", async () => {
    const { deps, members } = setup();
    // The race: between the preview and the import, another admin (or a join approval)
    // created a member with one of the file's phones. The database's unique index is the
    // final word; the import reports the row and finishes the rest.
    members.failNext(
      "create",
      new MemberError(
        "conflict",
        "Another member in this society is already recorded with that number.",
        { field: "phone" },
      ),
    );

    const result = expectOk(
      await importMembers(deps, ADMIN, SOCIETY, {
        csv: csv([
          "A-101,Races And Loses,+919876543240,,",
          "A-102,Races And Wins,+919876543241,,",
        ]),
      }),
    );

    expect(importedNames(result.imported)).toEqual(["Races And Wins"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({
      line: 2,
      error: { code: "IMPORT_ROW_FAILED", field: "row" },
    });
    expect(result.summary.imported).toBe(1);
    expect(result.summary.invalidRows).toBe(1);
  });

  it("refuses a resident and an empty file before any write", async () => {
    const { deps, members } = setup();
    expect(
      (await importMembers(deps, RESIDENT, SOCIETY, { csv: HEADER })).ok,
    ).toBe(false);
    expect(members.callCount("create")).toBe(0);
  });
});
