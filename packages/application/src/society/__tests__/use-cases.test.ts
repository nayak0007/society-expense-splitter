import {
  SocietyError,
  asSocietyId,
  asUserId,
  fixedClock,
  rupeesToPaise,
} from "@ses/domain";
import type { OccupancyType, SocietyType } from "@ses/domain";
import {
  createSociety,
  deleteSociety,
  getSocietyProfile,
  joinSociety,
  leaveSociety,
  listSocietySummaries,
  regenerateJoinCode,
  updateSociety,
} from "../use-cases";
import type { CreateSocietyCommand, SocietyDeps } from "../use-cases";
import {
  FakeSocietyRepository,
  TEST_NOW,
  membership,
} from "./support/fake-society-repository";
import { expectErr, expectOk } from "./support/result-expectations";

/**
 * Use cases are tested with no test runner in the loop beyond `describe`/`it`:
 * a fake repository, a frozen clock, and plain assertions on the returned
 * `Result`. That is the payoff of taking `(deps, actor, command)` instead of
 * importing singletons — no module mocking, no `jest.mock` hoisting, no DI
 * container, and a failure points at a rule rather than at wiring.
 *
 * The recurring assertion worth noticing is `repository.calls()`: it proves that
 * validation happens *before* I/O, so an invalid command can never reach storage.
 */

const ADMIN = asUserId("user-admin");
const RESIDENT = asUserId("user-resident");
const OUTSIDER = asUserId("user-outsider");

const BASE_COMMAND: CreateSocietyCommand = {
  name: "Green Valley Residency",
  type: "apartment",
  city: "Pune",
  state: "Maharashtra",
};

function setup(): {
  readonly repository: FakeSocietyRepository;
  readonly deps: SocietyDeps;
} {
  const clock = fixedClock(TEST_NOW);
  const repository = new FakeSocietyRepository({ clock });
  return { repository, deps: { repository, clock } };
}

function seedWithAdminAndResident(
  repository: FakeSocietyRepository,
): ReturnType<FakeSocietyRepository["seedSociety"]> {
  return repository.seedSociety({
    members: [
      { userId: "user-admin", role: "admin" },
      { userId: "user-resident", role: "resident" },
    ],
  });
}

describe("createSociety", () => {
  it("normalises the name, derives the slug and makes the creator an Admin", async () => {
    const { deps } = setup();

    const created = expectOk(
      await createSociety(deps, ADMIN, {
        ...BASE_COMMAND,
        name: "  Green   Valley Residency  ",
        pincode: "411045",
        billingDay: 5,
        dueDay: 20,
        approvalThresholdPaise: rupeesToPaise(5000),
      }),
    );

    expect(created.society.name).toBe("Green Valley Residency");
    expect(created.society.slug).toBe("green-valley-residency");
    expect(created.society.pincode).toBe("411045");
    expect(created.society.plan).toBe("free");
    expect(created.society.createdBy).toBe(ADMIN);
    expect(created.society.createdAt).toBe(TEST_NOW);
    expect(created.society.memberCount).toBe(1);
    expect(created.society.settings.billingDay).toBe(5);
    expect(created.society.settings.dueDay).toBe(20);
    expect(created.society.settings.approvalThresholdPaise).toBe(500_000);
    expect(created.membership.role).toBe("admin");
    expect(created.membership.status).toBe("active");
    expect(created.membership.userId).toBe(ADMIN);
  });

  it("falls back to the financial defaults when the wizard omits them", async () => {
    const { deps } = setup();

    const created = expectOk(await createSociety(deps, ADMIN, BASE_COMMAND));

    expect(created.society.settings.billingDay).toBe(1);
    expect(created.society.settings.dueDay).toBe(10);
    expect(created.society.settings.graceDays).toBe(5);
    expect(created.society.settings.approvalThresholdPaise).toBe(1_000_000);
    expect(created.society.settings.timezone).toBe("Asia/Kolkata");
  });

  it("validates the whole aggregate before any I/O", async () => {
    const cases: readonly {
      readonly command: CreateSocietyCommand;
      readonly field: string;
    }[] = [
      { command: { ...BASE_COMMAND, name: "A" }, field: "name" },
      { command: { ...BASE_COMMAND, city: "" }, field: "city" },
      { command: { ...BASE_COMMAND, state: " " }, field: "state" },
      { command: { ...BASE_COMMAND, pincode: "011045" }, field: "pincode" },
      { command: { ...BASE_COMMAND, billingDay: 31 }, field: "billingDay" },
      {
        command: { ...BASE_COMMAND, approvalThresholdPaise: 10.5 },
        field: "approvalThresholdPaise",
      },
    ];

    for (const { command, field } of cases) {
      const { deps, repository } = setup();
      const error = expectErr(await createSociety(deps, ADMIN, command));

      expect(error.code).toBe("validation");
      expect(error.details).toMatchObject({ field });
      expect(repository.calls()).toEqual([]);
    }
  });

  it("rejects a type that is not a society type, without I/O", async () => {
    const { deps, repository } = setup();

    const error = expectErr(
      await createSociety(deps, ADMIN, {
        ...BASE_COMMAND,
        type: "castle" as SocietyType,
      }),
    );

    expect(error.code).toBe("validation");
    expect(error.details).toMatchObject({ field: "type" });
    expect(repository.calls()).toEqual([]);
  });

  it("turns a repository failure into a typed Err instead of throwing", async () => {
    const { deps, repository } = setup();
    repository.failNext(
      "create",
      new SocietyError("conflict", "Slug already taken."),
    );

    expect(expectErr(await createSociety(deps, ADMIN, BASE_COMMAND)).code).toBe(
      "conflict",
    );
  });

  it("classifies an unrecognised failure as unknown", async () => {
    const { deps, repository } = setup();
    repository.failNext("create", new Error("socket hang up"));

    const error = expectErr(await createSociety(deps, ADMIN, BASE_COMMAND));

    expect(error.code).toBe("unknown");
    expect(error.message).not.toContain("socket");
  });
});

describe("updateSociety", () => {
  it("patches only the fields the caller sent", async () => {
    const { deps, repository } = setup();
    const { society } = seedWithAdminAndResident(repository);
    repository.putSociety({ ...society, addressLine1: "Plot 12, Baner Road" });

    const updated = expectOk(
      await updateSociety(deps, ADMIN, society.id, { city: "Mumbai" }),
    );
    const patches = repository.updatePatches();

    expect(patches).toHaveLength(1);
    expect(Object.keys(patches[0] ?? {})).toEqual(["city"]);
    expect(updated.city).toBe("Mumbai");
    // Untouched fields survive: an edit form that sends one field must not wipe
    // the others.
    expect(updated.addressLine1).toBe("Plot 12, Baner Road");
    expect(updated.name).toBe(society.name);
  });

  it("normalises a new name", async () => {
    const { deps, repository } = setup();
    const { society } = seedWithAdminAndResident(repository);

    await updateSociety(deps, ADMIN, society.id, {
      name: "  Green   Valley  ",
    });

    expect(repository.updatePatches()[0]?.name).toBe("Green Valley");
  });

  it('distinguishes "leave unchanged" from "clear this field"', async () => {
    const { deps, repository } = setup();
    const { society } = seedWithAdminAndResident(repository);
    repository.putSociety({ ...society, registrationNumber: "MH/PNA/12345" });

    await updateSociety(deps, ADMIN, society.id, { registrationNumber: "   " });
    const patch = repository.updatePatches()[0] ?? {};

    expect("registrationNumber" in patch).toBe(true);
    expect(patch.registrationNumber).toBeUndefined();
  });

  it("validates the resulting address, not just the changed field", async () => {
    const { deps, repository } = setup();
    const { society } = seedWithAdminAndResident(repository);
    repository.putSociety({ ...society, pincode: "411045" });

    const error = expectErr(
      await updateSociety(deps, ADMIN, society.id, { city: "" }),
    );

    expect(error.code).toBe("validation");
    expect(error.details).toMatchObject({ field: "city" });
    expect(repository.callCount("update")).toBe(0);
  });

  it("sends the whole settings object when any setting changes", async () => {
    const { deps, repository } = setup();
    const { society } = seedWithAdminAndResident(repository);

    await updateSociety(deps, ADMIN, society.id, { dueDay: 25 });
    const patch = repository.updatePatches()[0] ?? {};

    expect(patch.dueDay).toBe(25);
    // Settings are stored with the society, so there is no way to half-apply
    // them: the untouched keys travel at their current values.
    expect(patch.billingDay).toBe(society.settings.billingDay);
    expect(patch.approvalThresholdPaise).toBe(
      society.settings.approvalThresholdPaise,
    );
  });

  it("rejects an out-of-range setting without I/O", async () => {
    const { deps, repository } = setup();
    const { society } = seedWithAdminAndResident(repository);

    const error = expectErr(
      await updateSociety(deps, ADMIN, society.id, { billingDay: 31 }),
    );

    expect(error.details).toMatchObject({ field: "billingDay" });
    expect(repository.callCount("update")).toBe(0);
  });

  it("rejects an empty patch", async () => {
    const { deps, repository } = setup();
    const { society } = seedWithAdminAndResident(repository);

    const error = expectErr(await updateSociety(deps, ADMIN, society.id, {}));

    expect(error.code).toBe("validation");
    expect(repository.callCount("update")).toBe(0);
  });

  it("forbids a non-Admin, naming the reason the rule gave", async () => {
    const { deps, repository } = setup();
    const { society } = seedWithAdminAndResident(repository);

    const error = expectErr(
      await updateSociety(deps, RESIDENT, society.id, { city: "Mumbai" }),
    );

    expect(error.code).toBe("forbidden");
    expect(error.message).toContain("Admin");
    expect(repository.callCount("update")).toBe(0);
  });

  it("reports a non-member as not_found, never forbidden", async () => {
    const { deps, repository } = setup();
    const { society } = seedWithAdminAndResident(repository);

    expect(
      expectErr(await updateSociety(deps, OUTSIDER, society.id, { city: "X" }))
        .code,
    ).toBe("not_found");
  });

  it("reports an unknown society id as not_found", async () => {
    const { deps } = setup();

    expect(
      expectErr(
        await updateSociety(deps, ADMIN, asSocietyId("society-nope"), {
          city: "X",
        }),
      ).code,
    ).toBe("not_found");
  });
});

describe("deleteSociety", () => {
  it("lets an Admin delete", async () => {
    const { deps, repository } = setup();
    const { society } = seedWithAdminAndResident(repository);

    expect(
      expectOk(await deleteSociety(deps, ADMIN, society.id)),
    ).toBeUndefined();
    expect(repository.callCount("remove")).toBe(1);
  });

  it("refuses a non-Admin and a non-member", async () => {
    const { deps, repository } = setup();
    const { society } = seedWithAdminAndResident(repository);

    expect(
      expectErr(await deleteSociety(deps, RESIDENT, society.id)).code,
    ).toBe("forbidden");
    expect(
      expectErr(await deleteSociety(deps, OUTSIDER, society.id)).code,
    ).toBe("not_found");
    expect(repository.callCount("remove")).toBe(0);
  });
});

describe("regenerateJoinCode", () => {
  it("rotates the code for an Admin", async () => {
    const { deps, repository } = setup();
    const { society } = seedWithAdminAndResident(repository);

    const rotated = expectOk(await regenerateJoinCode(deps, ADMIN, society.id));

    expect(rotated.joinCode).not.toBe(society.joinCode);
    expect(repository.callCount("regenerateJoinCode")).toBe(1);
  });

  it("refuses a non-Admin", async () => {
    const { deps, repository } = setup();
    const { society } = seedWithAdminAndResident(repository);

    expect(
      expectErr(await regenerateJoinCode(deps, RESIDENT, society.id)).code,
    ).toBe("forbidden");
    expect(repository.callCount("regenerateJoinCode")).toBe(0);
  });
});

describe("joinSociety", () => {
  function seedJoinable(
    repository: FakeSocietyRepository,
    overrides: {
      readonly joinCode?: string;
      readonly joinCodeExpiresAt?: string | null;
    } = {},
  ): ReturnType<FakeSocietyRepository["seedSociety"]> {
    return repository.seedSociety({
      joinCode: overrides.joinCode ?? "AB2CD3",
      joinCodeExpiresAt: overrides.joinCodeExpiresAt ?? null,
      members: [{ userId: "user-other", role: "admin" }],
    });
  }

  it("rejects a malformed code without ever querying for it", async () => {
    const { deps, repository } = setup();

    const error = expectErr(
      await joinSociety(deps, RESIDENT, {
        code: "ABC",
        occupancyType: "owner",
      }),
    );

    expect(error.code).toBe("join_code_invalid");
    expect(repository.calls()).toEqual([]);
  });

  it("rejects an unknown occupancy without touching the repository", async () => {
    const { deps, repository } = setup();

    const error = expectErr(
      await joinSociety(deps, RESIDENT, {
        code: "AB2CD3",
        occupancyType: "squatter" as OccupancyType,
      }),
    );

    expect(error.details).toMatchObject({ field: "occupancyType" });
    expect(repository.calls()).toEqual([]);
  });

  it("reports an unknown code as invalid, not as an empty society", async () => {
    const { deps, repository } = setup();
    seedJoinable(repository);

    const error = expectErr(
      await joinSociety(deps, RESIDENT, {
        code: "ZZZZZZ",
        occupancyType: "owner",
      }),
    );

    expect(error.code).toBe("join_code_invalid");
    expect(repository.callCount("join")).toBe(0);
  });

  it("refuses an expired code against the injected clock", async () => {
    const { deps, repository } = setup();
    seedJoinable(repository, { joinCodeExpiresAt: "2026-09-20T09:00:00.000Z" });

    const error = expectErr(
      await joinSociety(deps, RESIDENT, {
        code: "AB2CD3",
        occupancyType: "owner",
      }),
    );

    expect(error.code).toBe("join_code_expired");
    expect(repository.callCount("join")).toBe(0);
  });

  it("treats an expiry exactly at the current instant as expired", async () => {
    const { deps, repository } = setup();
    seedJoinable(repository, { joinCodeExpiresAt: TEST_NOW });

    expect(
      expectErr(
        await joinSociety(deps, RESIDENT, {
          code: "AB2CD3",
          occupancyType: "owner",
        }),
      ).code,
    ).toBe("join_code_expired");
  });

  it("accepts a future expiry and normalises a lower-case code", async () => {
    const { deps, repository } = setup();
    const { society } = seedJoinable(repository, {
      joinCodeExpiresAt: "2026-10-01T00:00:00.000Z",
    });

    const joined = expectOk(
      await joinSociety(deps, RESIDENT, {
        code: " ab2cd-3 ",
        occupancyType: "tenant",
      }),
    );

    expect(joined.societyId).toBe(society.id);
    expect(joined.userId).toBe(RESIDENT);
    expect(joined.occupancyType).toBe("tenant");
    // PRD §3.2: joins are never auto-approved — the server owns that decision.
    expect(joined.status).toBe("pending");
    expect(joined.joinedAt).toBeNull();
    expect(repository.callCount("join")).toBe(1);
  });

  it("surfaces an existing membership as a conflict", async () => {
    const { deps, repository } = setup();
    repository.seedSociety({
      joinCode: "AB2CD3",
      members: [
        { userId: "user-other", role: "admin" },
        { userId: "user-resident", role: "resident" },
      ],
    });

    const error = expectErr(
      await joinSociety(deps, RESIDENT, {
        code: "AB2CD3",
        occupancyType: "owner",
      }),
    );

    expect(error.code).toBe("conflict");
  });
});

describe("leaveSociety", () => {
  it("refuses to leave a society without an active Admin", async () => {
    const { deps, repository } = setup();
    const { society } = repository.seedSociety({
      members: [{ userId: "user-admin", role: "admin" }],
    });

    const error = expectErr(await leaveSociety(deps, ADMIN, society.id));

    expect(error.code).toBe("sole_admin");
    expect(error.message).toMatch(/Promote another member/);
    expect(repository.callCount("leave")).toBe(0);
  });

  it("allows an Admin to leave once a peer Admin exists", async () => {
    const { deps, repository } = setup();
    const { society } = repository.seedSociety({
      members: [
        { userId: "user-admin", role: "admin" },
        { userId: "user-admin-2", role: "admin" },
      ],
    });

    expect(
      expectOk(await leaveSociety(deps, ADMIN, society.id)),
    ).toBeUndefined();
    expect(repository.callCount("leave")).toBe(1);
  });

  it("lets a resident leave", async () => {
    const { deps, repository } = setup();
    const { society } = seedWithAdminAndResident(repository);

    expect(
      expectOk(await leaveSociety(deps, RESIDENT, society.id)),
    ).toBeUndefined();
    expect(repository.callCount("leave")).toBe(1);
  });

  it("reports a non-member and a removed member as not_found", async () => {
    const { deps, repository } = setup();
    const { society } = seedWithAdminAndResident(repository);
    const ghost = repository.seedSociety({
      id: "society-2",
      members: [{ userId: "user-admin", role: "admin", status: "removed" }],
    });

    expect(expectErr(await leaveSociety(deps, OUTSIDER, society.id)).code).toBe(
      "not_found",
    );
    expect(
      expectErr(await leaveSociety(deps, ADMIN, ghost.society.id)).code,
    ).toBe("not_found");
    expect(repository.callCount("leave")).toBe(0);
  });
});

describe("getSocietyProfile", () => {
  it("returns the society, the caller membership and their capabilities", async () => {
    const { deps, repository } = setup();
    const { society } = seedWithAdminAndResident(repository);

    const profile = expectOk(await getSocietyProfile(deps, ADMIN, society.id));

    expect(profile.society.id).toBe(society.id);
    expect(profile.membership.userId).toBe(ADMIN);
    expect(profile.capabilities.canManage).toBe(true);
    // Sole Admin: may manage, may not leave.
    expect(profile.capabilities.canLeave).toBe(false);
  });

  it("withholds management from a resident but allows them to invite", async () => {
    const { deps, repository } = setup();
    const { society } = seedWithAdminAndResident(repository);

    const capabilities = expectOk(
      await getSocietyProfile(deps, RESIDENT, society.id),
    ).capabilities;

    expect(capabilities.canManage).toBe(false);
    expect(capabilities.canViewJoinCode).toBe(true);
    expect(capabilities.canLeave).toBe(true);
  });

  it("reports a non-member as not_found", async () => {
    const { deps, repository } = setup();
    const { society } = seedWithAdminAndResident(repository);

    expect(
      expectErr(await getSocietyProfile(deps, OUTSIDER, society.id)).code,
    ).toBe("not_found");
  });
});

describe("listSocietySummaries", () => {
  it("lists every society the caller belongs to", async () => {
    const { deps, repository } = setup();
    repository.seedSociety({ id: "society-1", name: "Green Valley" });
    repository.seedSociety({
      id: "society-2",
      name: "Sunrise Heights",
      members: [{ userId: "user-admin", role: "treasurer", status: "pending" }],
    });

    const summaries = expectOk(await listSocietySummaries(deps, ADMIN));

    expect(summaries).toHaveLength(2);
    const byName = new Map(summaries.map((summary) => [summary.name, summary]));
    expect(byName.get("Green Valley")).toMatchObject({
      role: "admin",
      status: "active",
      memberCount: 1,
      city: "Pune",
      type: "apartment",
    });
    expect(byName.get("Sunrise Heights")).toMatchObject({
      role: "treasurer",
      status: "pending",
    });
  });

  it("never lists a removed membership", async () => {
    const { deps, repository } = setup();
    repository.seedSociety({
      members: [{ userId: "user-admin", role: "admin", status: "removed" }],
    });

    expect(expectOk(await listSocietySummaries(deps, ADMIN))).toEqual([]);
  });

  it("skips a membership whose society can no longer be read", async () => {
    const { deps, repository } = setup();
    repository.seedSociety({ id: "society-1", name: "Green Valley" });
    repository.putMembership(
      membership({
        id: "member-dangling",
        societyId: "society-ghost",
        userId: "user-admin",
      }),
    );

    const summaries = expectOk(await listSocietySummaries(deps, ADMIN));

    expect(summaries.map((summary) => summary.name)).toEqual(["Green Valley"]);
  });

  it("returns an empty list for a user with no societies", async () => {
    const { deps } = setup();

    expect(expectOk(await listSocietySummaries(deps, OUTSIDER))).toEqual([]);
  });

  it("classifies a transport failure as unknown", async () => {
    const { deps, repository } = setup();
    repository.failNext("listMemberships", new Error("offline"));

    expect(expectErr(await listSocietySummaries(deps, ADMIN)).code).toBe(
      "unknown",
    );
  });
});

/**
 * Every use case promises a `Result`, which means no adapter failure may escape
 * as a throw. These tests hold that promise: a crash deep in a repository is
 * flattened into a typed `Err` (`unknown` unless the adapter already spoke the
 * domain's error language), and a `DomainError` that arrives from an adapter
 * keeps its code — the API maps that code onto an HTTP status and the UI onto
 * copy, so losing it would turn a precise 409 into a generic 500.
 */
describe("repository failures never escape as throws", () => {
  it("keeps a code the adapter already carried", async () => {
    const { deps, repository } = setup();
    const { society } = seedWithAdminAndResident(repository);
    repository.failNext(
      "update",
      new SocietyError("conflict", "Slug already taken."),
    );

    expect(
      expectErr(
        await updateSociety(deps, ADMIN, society.id, { city: "Mumbai" }),
      ).code,
    ).toBe("conflict");
  });

  it("flattens a read that throws while loading the society", async () => {
    const { deps, repository } = setup();
    const { society } = seedWithAdminAndResident(repository);
    repository.failNext("findById", new Error("socket hang up"));

    expect(
      expectErr(await getSocietyProfile(deps, ADMIN, society.id)).code,
    ).toBe("unknown");
  });

  it("flattens a failed update", async () => {
    const { deps, repository } = setup();
    const { society } = seedWithAdminAndResident(repository);
    repository.failNext("update", new Error("socket hang up"));

    expect(
      expectErr(
        await updateSociety(deps, ADMIN, society.id, { city: "Mumbai" }),
      ).code,
    ).toBe("unknown");
  });

  it("flattens a failed delete", async () => {
    const { deps, repository } = setup();
    const { society } = seedWithAdminAndResident(repository);
    repository.failNext("remove", new Error("socket hang up"));

    expect(expectErr(await deleteSociety(deps, ADMIN, society.id)).code).toBe(
      "unknown",
    );
  });

  it("flattens a failed leave", async () => {
    const { deps, repository } = setup();
    const { society } = seedWithAdminAndResident(repository);
    repository.failNext("leave", new Error("socket hang up"));

    expect(expectErr(await leaveSociety(deps, RESIDENT, society.id)).code).toBe(
      "unknown",
    );
  });

  it("flattens a failed join-code rotation", async () => {
    const { deps, repository } = setup();
    const { society } = seedWithAdminAndResident(repository);
    repository.failNext("regenerateJoinCode", new Error("socket hang up"));

    expect(
      expectErr(await regenerateJoinCode(deps, ADMIN, society.id)).code,
    ).toBe("unknown");
  });

  it("flattens a failed join at either step", async () => {
    const previewFailure = setup();
    seedWithAdminAndResident(previewFailure.repository);
    previewFailure.repository.failNext(
      "findJoinPreview",
      new Error("socket hang up"),
    );
    expect(
      expectErr(
        await joinSociety(previewFailure.deps, RESIDENT, {
          code: "GV4K2M",
          occupancyType: "owner",
        }),
      ).code,
    ).toBe("unknown");

    const joinFailure = setup();
    seedWithAdminAndResident(joinFailure.repository);
    joinFailure.repository.failNext("join", new Error("socket hang up"));
    expect(
      expectErr(
        await joinSociety(joinFailure.deps, RESIDENT, {
          code: "GV4K2M",
          occupancyType: "owner",
        }),
      ).code,
    ).toBe("unknown");
  });

  it("flattens a failed lookup while listing", async () => {
    const { deps, repository } = setup();
    repository.seedSociety();
    repository.failNext("findById", new Error("socket hang up"));

    expect(expectErr(await listSocietySummaries(deps, ADMIN)).code).toBe(
      "unknown",
    );
  });
});

describe("updateSociety field handling", () => {
  it("patches the type and every address field the caller sent", async () => {
    const { deps, repository } = setup();
    const { society } = seedWithAdminAndResident(repository);

    await updateSociety(deps, ADMIN, society.id, {
      type: "villa",
      addressLine1: "Plot 12",
      addressLine2: "Baner Road",
      state: "Goa",
      pincode: "403001",
    });
    const patch = repository.updatePatches()[0] ?? {};

    expect(patch.type).toBe("villa");
    expect(patch.addressLine1).toBe("Plot 12");
    expect(patch.addressLine2).toBe("Baner Road");
    expect(patch.state).toBe("Goa");
    expect(patch.pincode).toBe("403001");
    expect(Object.keys(patch).sort()).toEqual([
      "addressLine1",
      "addressLine2",
      "pincode",
      "state",
      "type",
    ]);
  });

  it("clears an address field with an empty string", async () => {
    const { deps, repository } = setup();
    const { society } = seedWithAdminAndResident(repository);
    repository.putSociety({ ...society, addressLine1: "Plot 12" });

    await updateSociety(deps, ADMIN, society.id, { addressLine1: "   " });
    const patch = repository.updatePatches()[0] ?? {};

    expect("addressLine1" in patch).toBe(true);
    expect(patch.addressLine1).toBeUndefined();
  });

  it("rejects a type that is not a society type", async () => {
    const { deps, repository } = setup();
    const { society } = seedWithAdminAndResident(repository);

    const error = expectErr(
      await updateSociety(deps, ADMIN, society.id, {
        type: "castle" as SocietyType,
      }),
    );

    expect(error.code).toBe("validation");
    expect(error.details).toMatchObject({ field: "type" });
    expect(repository.callCount("update")).toBe(0);
  });

  it("rejects an over-long address line without I/O", async () => {
    const { deps, repository } = setup();
    const { society } = seedWithAdminAndResident(repository);

    const error = expectErr(
      await updateSociety(deps, ADMIN, society.id, {
        addressLine2: "x".repeat(201),
      }),
    );

    expect(error.details).toMatchObject({ field: "addressLine2" });
    expect(repository.callCount("update")).toBe(0);
  });

  it("keeps a valid existing address when only the city changes", async () => {
    const { deps, repository } = setup();
    const { society } = seedWithAdminAndResident(repository);
    repository.putSociety({
      ...society,
      addressLine1: "Plot 12",
      pincode: "411045",
    });

    const updated = expectOk(
      await updateSociety(deps, ADMIN, society.id, { city: "Mumbai" }),
    );

    expect(updated.pincode).toBe("411045");
    expect(updated.addressLine1).toBe("Plot 12");
  });
});
