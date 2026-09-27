import {
  MemberError,
  asBuildingId,
  asMemberId,
  asSocietyId,
  asUserId,
} from "@ses/domain";

import { addMember } from "../use-cases/add-member";
import {
  reactivateMember,
  suspendMember,
} from "../use-cases/change-member-status";
import { getMember } from "../use-cases/get-member";
import { listMembers } from "../use-cases/list-members";
import { removeMember } from "../use-cases/remove-member";
import type { MemberDeps } from "../use-cases/support";
import { updateMember } from "../use-cases/update-member";
import { FakeMemberRepository } from "./support/fake-member-repository";
import { expectErr, expectOk } from "./support/result-expectations";

/**
 * The member use cases, against a fake repository.
 *
 * What these tests are *for*, in order of value:
 *
 *  1. **The `undefined` / `null` distinction on a patch.** `phone: undefined` means "leave it
 *     alone" and `phone: null` means "we had that wrong, take it off" — and a shadow member's
 *     phone is their only identifier, so it has to be retractable. Asserted through the
 *     *patch the repository received*, because the difference is invisible in the returned
 *     row.
 *  2. **The pair rules are checked against what survives the patch.** A patch that sets only
 *     `isPrimary` is judged against the occupancy and flat already stored, and one that only
 *     moves a lease end is judged against the stored start. Both are why the use case reads
 *     the member before it writes.
 *  3. **Contact consent, per row.** A resident sees a consented neighbour's number and not an
 *     unconsented one, on the same page, while a manager sees both. This is the module's one
 *     genuinely privacy-shaped rule, and it is enforced in the application layer because RLS
 *     filters rows and cannot vary by column.
 *  4. **Authorisation comes from the capability evaluation**, so a Treasurer may keep the
 *     directory accurate and may not cut anybody off, a Guest is refused even a read, and a
 *     non-member gets `not_found` — a different answer on purpose (PRD T041).
 *  5. **Validation happens before I/O**: an invalid command never reaches storage.
 */

const SOCIETY = "society-1";
const OTHER_SOCIETY = "society-2";

const ADMIN = "user-admin";
const TREASURER = "user-treasurer";
const RESIDENT = "user-resident";
const GUEST = "user-guest";
const PENDING = "user-pending";

interface Setup {
  readonly deps: MemberDeps;
  readonly members: FakeMemberRepository;
}

function setup(): Setup {
  const members = new FakeMemberRepository();
  members.seedMember(SOCIETY, {
    id: "m-admin",
    userId: ADMIN,
    role: "admin",
    displayName: "Anita Rao",
    phone: "+919800000001",
  });
  members.seedMember(SOCIETY, {
    id: "m-treasurer",
    userId: TREASURER,
    role: "treasurer",
    displayName: "Bharat Shah",
    phone: "+919800000002",
  });
  members.seedMember(SOCIETY, {
    id: "m-resident",
    userId: RESIDENT,
    role: "resident",
    displayName: "Meera Krishnan",
    phone: "+919800000003",
  });
  members.seedMember(SOCIETY, {
    id: "m-guest",
    userId: GUEST,
    role: "guest",
    displayName: "Gate 1",
    phone: "+919800000004",
  });
  members.seedMember(SOCIETY, {
    id: "m-pending",
    userId: PENDING,
    role: "resident",
    status: "pending",
    displayName: "Pending Person",
    phone: "+919800000005",
  });
  return { deps: { members }, members };
}

/** A shadow member with no account, in a flat — the direct-add path's outcome. */
function seedShadow(
  members: FakeMemberRepository,
  spec: Parameters<FakeMemberRepository["seedMember"]>[1] = {},
) {
  return members.seedMember(SOCIETY, {
    id: "m-shadow",
    displayName: "Suresh Menon",
    phone: "+919800000009",
    apartmentId: "flat-101",
    apartmentNumber: "A-101",
    buildingId: "building-a",
    ...spec,
  });
}

describe("listMembers", () => {
  it("gives a non-member not_found, and never touches the directory", async () => {
    const { deps, members } = setup();

    const error = expectErr(
      await listMembers(
        deps,
        asUserId("user-stranger"),
        asSocietyId(SOCIETY),
        {},
      ),
    );

    expect(error.code).toBe("not_found");
    // One identity read (`findViewer`), and no directory access at all.
    expect(members.calls()).toEqual(["findViewer"]);
  });

  it("refuses a pending member, whose own RLS branch would show a one-row society", async () => {
    const { deps, members } = setup();

    const error = expectErr(
      await listMembers(deps, asUserId(PENDING), asSocietyId(SOCIETY), {}),
    );

    expect(error.code).toBe("forbidden");
    // The refusal is the capability's, not the repository's: no read happened, so a client
    // cannot use the error's shape to infer how many members exist.
    expect(members.callCount("list")).toBe(0);
  });

  it("refuses a Guest, whose role holds no member.view", async () => {
    const { deps } = setup();

    const error = expectErr(
      await listMembers(deps, asUserId(GUEST), asSocietyId(SOCIETY), {}),
    );

    expect(error.code).toBe("forbidden");
  });

  it("lists the live roster for a resident, with the caller's capabilities", async () => {
    const { deps, members } = setup();
    seedShadow(members);

    const directory = expectOk(
      await listMembers(deps, asUserId(RESIDENT), asSocietyId(SOCIETY), {}),
    );

    expect(directory.members.map((member) => member.id)).toContain(
      asMemberId("m-shadow"),
    );
    expect(directory.total).toBe(6);
    expect(directory.limit).toBe(50);
    expect(directory.offset).toBe(0);
    expect(directory.capabilities).toEqual({
      canView: true,
      canAdd: false,
      canEdit: false,
      canSuspend: false,
      canRemove: false,
      canChangeRoles: false,
      // T049: the directory is `member.view`; the join queue is `member.approve`, which a
      // Resident does not hold.
      canApprove: false,
    });
  });

  it("hides a removed member by default and returns them when asked", async () => {
    const { deps, members } = setup();
    members.seedMember(SOCIETY, {
      id: "m-gone",
      displayName: "Gone Person",
      status: "removed",
    });

    const byDefault = expectOk(
      await listMembers(deps, asUserId(ADMIN), asSocietyId(SOCIETY), {}),
    );
    expect(byDefault.members.some((member) => member.id === "m-gone")).toBe(
      false,
    );

    // PRD §3.3 keeps the history, so the rows stay reachable — deliberately by asking for
    // that status rather than as part of the ordinary roster.
    const asked = expectOk(
      await listMembers(deps, asUserId(ADMIN), asSocietyId(SOCIETY), {
        status: "removed",
      }),
    );
    expect(asked.members.map((member) => member.id)).toEqual([
      asMemberId("m-gone"),
    ]);
  });

  it("filters by role, occupancy, building and free text", async () => {
    const { deps, members } = setup();
    seedShadow(members, {
      occupancy: "tenant",
      id: "m-tenant",
      displayName: "Tara Nair",
    });

    const treasurers = expectOk(
      await listMembers(deps, asUserId(ADMIN), asSocietyId(SOCIETY), {
        role: "treasurer",
      }),
    );
    expect(treasurers.members.map((member) => member.id)).toEqual([
      asMemberId("m-treasurer"),
    ]);

    const tenants = expectOk(
      await listMembers(deps, asUserId(ADMIN), asSocietyId(SOCIETY), {
        occupancy: "tenant",
      }),
    );
    expect(tenants.members.map((member) => member.id)).toEqual([
      asMemberId("m-tenant"),
    ]);

    const inBuilding = expectOk(
      await listMembers(deps, asUserId(ADMIN), asSocietyId(SOCIETY), {
        buildingId: asBuildingId("building-a"),
      }),
    );
    // Only the member who was given a flat: the rest of the roster has none, which is a
    // real state (a committee member who is not an occupant, a shadow added before the
    // flats existed) and must not be pulled into a per-building list.
    expect(inBuilding.members.map((member) => member.id)).toEqual([
      asMemberId("m-tenant"),
    ]);

    // The search box matches a flat number, which is how a manager finds "who lives in
    // A-101?" without knowing anybody's name.
    const searched = expectOk(
      await listMembers(deps, asUserId(ADMIN), asSocietyId(SOCIETY), {
        query: "A-101",
      }),
    );
    expect(searched.members.map((member) => member.id)).toEqual([
      asMemberId("m-tenant"),
    ]);
  });

  it("clamps the page rather than trusting the caller", async () => {
    const { deps } = setup();

    const page = expectOk(
      await listMembers(deps, asUserId(ADMIN), asSocietyId(SOCIETY), {
        limit: 10_000,
        offset: 0,
      }),
    );

    expect(page.limit).toBe(200);
  });

  it("redacts contacts row by row: a resident sees a consented neighbour and not others", async () => {
    const { deps, members } = setup();
    seedShadow(members, {
      id: "m-shared",
      displayName: "Shanta",
      shareContact: true,
    });

    const directory = expectOk(
      await listMembers(deps, asUserId(RESIDENT), asSocietyId(SOCIETY), {}),
    );
    const byId = new Map(
      directory.members.map((member) => [member.id, member]),
    );

    expect(byId.get(asMemberId("m-shared"))?.phone).toBe("+919800000009");
    expect(byId.get(asMemberId("m-shared"))?.contactVisible).toBe(true);
    // The neighbour who has not consented, on the same page.
    expect(byId.get(asMemberId("m-admin"))?.phone).toBeNull();
    expect(byId.get(asMemberId("m-admin"))?.contactVisible).toBe(false);
    // And the caller's own row is never hidden from them.
    expect(byId.get(asMemberId("m-resident"))?.phone).toBe("+919800000003");
  });

  it("shows a manager the contacts of a member who has not consented", async () => {
    const { deps } = setup();

    const directory = expectOk(
      await listMembers(deps, asUserId(TREASURER), asSocietyId(SOCIETY), {}),
    );
    const resident = directory.members.find(
      (member) => member.id === asMemberId("m-resident"),
    );

    expect(resident?.phone).toBe("+919800000003");
    expect(resident?.email).toBeNull();
  });

  it("converts an adapter failure into the module's vocabulary", async () => {
    const { deps, members } = setup();
    members.failNext("list", new Error("connection reset"));

    const error = expectErr(
      await listMembers(deps, asUserId(ADMIN), asSocietyId(SOCIETY), {}),
    );

    expect(error.code).toBe("unknown");
  });
});

describe("getMember", () => {
  it("returns a member of the caller's society", async () => {
    const { deps } = setup();

    const detail = expectOk(
      await getMember(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-resident"),
      ),
    );

    expect(detail.member.displayName).toBe("Meera Krishnan");
    expect(detail.capabilities.canRemove).toBe(true);
  });

  it("answers not_found for a member of another society", async () => {
    const { deps, members } = setup();
    members.seedMember(OTHER_SOCIETY, { id: "m-foreign", userId: ADMIN });

    const error = expectErr(
      await getMember(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-foreign"),
      ),
    );

    expect(error.code).toBe("not_found");
  });

  it("answers not_found for a member who has been removed", async () => {
    const { deps, members } = setup();
    members.seedMember(SOCIETY, { id: "m-gone", status: "removed" });

    const error = expectErr(
      await getMember(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-gone"),
      ),
    );

    expect(error.code).toBe("not_found");
  });

  it("lets a resident see their own row in full, contact included", async () => {
    const { deps } = setup();

    const detail = expectOk(
      await getMember(
        deps,
        asUserId(RESIDENT),
        asSocietyId(SOCIETY),
        asMemberId("m-resident"),
      ),
    );

    expect(detail.member.phone).toBe("+919800000003");
    expect(detail.member.contactVisible).toBe(true);
  });
});

describe("addMember", () => {
  it("records a shadow member an Admin added: no account, resident, active", async () => {
    const { deps, members } = setup();

    const added = expectOk(
      await addMember(deps, asUserId(ADMIN), asSocietyId(SOCIETY), {
        displayName: "  Suresh   Menon ",
        phone: "98765 40000",
      }),
    );

    expect(added.member.displayName).toBe("Suresh Menon");
    expect(added.member.phone).toBe("+919876540000");
    expect(added.member.userId).toBeNull();
    expect(added.member.role).toBe("resident");
    expect(added.member.status).toBe("active");
    expect(added.member.joinedAt).not.toBeNull();
    // The input the repository received is the *normalised* one, so the row and the
    // duplicate index agree about what the number is.
    expect(members.createInputs()[0]?.phone).toBe("+919876540000");
  });

  it("lets a Treasurer add one — the matrix's invite row is held by both roles", async () => {
    const { deps } = setup();

    const added = expectOk(
      await addMember(deps, asUserId(TREASURER), asSocietyId(SOCIETY), {
        displayName: "Suresh Menon",
        phone: "+919876540000",
      }),
    );

    expect(added.member.id).toBeDefined();
  });

  it("refuses a resident, and writes nothing", async () => {
    const { deps, members } = setup();

    const error = expectErr(
      await addMember(deps, asUserId(RESIDENT), asSocietyId(SOCIETY), {
        displayName: "Suresh Menon",
        phone: "+919876540000",
      }),
    );

    expect(error.code).toBe("forbidden");
    expect(members.callCount("create")).toBe(0);
  });

  it("refuses a second shadow record for the same number, on the phone field", async () => {
    const { deps, members } = setup();
    seedShadow(members);

    const error = expectErr(
      await addMember(deps, asUserId(ADMIN), asSocietyId(SOCIETY), {
        displayName: "Suresh Menon (again)",
        phone: "+91 98000 00009",
      }),
    );

    expect(error.code).toBe("conflict");
    expect(error.details?.field).toBe("phone");
    expect(members.callCount("create")).toBe(0);
  });

  it("allows a number already held by a member who has an account", async () => {
    // The index is partial on `user_id IS NULL`, so a spouse's number may legitimately
    // appear twice once someone has signed in. Asking the broader question here would refuse
    // a record the database would have accepted.
    const { deps } = setup();

    const added = expectOk(
      await addMember(deps, asUserId(ADMIN), asSocietyId(SOCIETY), {
        displayName: "Meera's husband",
        phone: "+919800000003",
      }),
    );

    expect(added.member.id).toBeDefined();
  });

  it("refuses a phone it cannot normalise without guessing a country", async () => {
    const { deps, members } = setup();

    const error = expectErr(
      await addMember(deps, asUserId(ADMIN), asSocietyId(SOCIETY), {
        displayName: "Suresh Menon",
        phone: "12345",
      }),
    );

    expect(error.code).toBe("validation");
    expect(error.details?.field).toBe("phone");
    // One identity read (`findViewer`), and no directory access at all.
    expect(members.calls()).toEqual(["findViewer"]);
  });

  it("requires a flat before a member can be its primary occupant", async () => {
    const { deps } = setup();

    const error = expectErr(
      await addMember(deps, asUserId(ADMIN), asSocietyId(SOCIETY), {
        displayName: "Suresh Menon",
        phone: "+919876540000",
        isPrimary: true,
      }),
    );

    expect(error.code).toBe("validation");
    expect(error.details?.field).toBe("apartmentId");
  });

  it("refuses a family member as the primary occupant", async () => {
    const { deps } = setup();

    const error = expectErr(
      await addMember(deps, asUserId(ADMIN), asSocietyId(SOCIETY), {
        displayName: "Suresh Menon",
        phone: "+919876540000",
        apartmentId: "flat-101",
        occupancy: "family_member",
        isPrimary: true,
      }),
    );

    expect(error.details?.field).toBe("occupancy");
  });

  it("refuses a lease that ends before it starts", async () => {
    const { deps } = setup();

    const error = expectErr(
      await addMember(deps, asUserId(ADMIN), asSocietyId(SOCIETY), {
        displayName: "Tara Nair",
        phone: "+919876540000",
        occupancy: "tenant",
        leaseStart: "2026-06-01",
        leaseEnd: "2026-01-01",
      }),
    );

    expect(error.details?.field).toBe("leaseEnd");
  });

  it("refuses a blank name before it looks up anything", async () => {
    const { deps, members } = setup();

    const error = expectErr(
      await addMember(deps, asUserId(ADMIN), asSocietyId(SOCIETY), {
        displayName: "   ",
        phone: "+919876540000",
      }),
    );

    expect(error.details?.field).toBe("displayName");
    // One identity read (`findViewer`), and no directory access at all.
    expect(members.calls()).toEqual(["findViewer"]);
  });
});

describe("updateMember", () => {
  it("sends only the fields it was given", async () => {
    const { deps, members } = setup();

    expectOk(
      await updateMember(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-resident"),
        {
          displayName: "Meera K",
        },
      ),
    );

    expect(members.updatePatches()).toEqual([{ displayName: "Meera K" }]);
  });

  it("clears a phone with an explicit null, rather than ignoring it", async () => {
    const { deps, members } = setup();
    seedShadow(members);

    const updated = expectOk(
      await updateMember(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-shadow"),
        {
          phone: null,
        },
      ),
    );

    expect(members.updatePatches()).toEqual([{ phone: null }]);
    expect(updated.member.phone).toBeNull();
  });

  it("normalises a phone it is given", async () => {
    const { deps, members } = setup();
    seedShadow(members);

    const updated = expectOk(
      await updateMember(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-shadow"),
        {
          phone: "098765 40001",
        },
      ),
    );

    expect(updated.member.phone).toBe("+919876540001");
    expect(members.updatePatches()[0]?.phone).toBe("+919876540001");
  });

  it("judges isPrimary against the stored flat and occupancy", async () => {
    const { deps, members } = setup();
    seedShadow(members, { occupancy: "owner_occupied" });

    const updated = expectOk(
      await updateMember(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-shadow"),
        {
          isPrimary: true,
        },
      ),
    );

    expect(updated.member.isPrimary).toBe(true);
  });

  it("refuses making a stored family member primary", async () => {
    const { deps, members } = setup();
    seedShadow(members, { occupancy: "family_member", isPrimary: false });

    const error = expectErr(
      await updateMember(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-shadow"),
        {
          isPrimary: true,
        },
      ),
    );

    expect(error.code).toBe("validation");
    expect(error.details?.field).toBe("occupancy");
    expect(members.callCount("update")).toBe(0);
  });

  it("refuses clearing the flat of a member who is still the primary occupant", async () => {
    const { deps, members } = setup();
    seedShadow(members, { isPrimary: true });

    const error = expectErr(
      await updateMember(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-shadow"),
        {
          apartmentId: null,
        },
      ),
    );

    expect(error.details?.field).toBe("apartmentId");
  });

  it("judges a one-end lease patch against the stored other end", async () => {
    const { deps, members } = setup();
    seedShadow(members, {
      occupancy: "tenant",
      leaseStart: "2026-01-01",
      leaseEnd: "2026-12-31",
    });

    const error = expectErr(
      await updateMember(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-shadow"),
        {
          leaseStart: "2027-01-01",
        },
      ),
    );

    expect(error.details?.field).toBe("leaseEnd");
  });

  it("refuses a shadow member's number that another shadow already holds", async () => {
    const { deps, members } = setup();
    seedShadow(members);
    members.seedMember(SOCIETY, {
      id: "m-other-shadow",
      displayName: "Other Shadow",
      phone: "+919800000010",
    });

    const error = expectErr(
      await updateMember(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-other-shadow"),
        {
          phone: "+919800000009",
        },
      ),
    );

    expect(error.code).toBe("conflict");
    expect(error.details?.field).toBe("phone");
  });

  it("rejects an empty patch rather than issuing an empty UPDATE", async () => {
    const { deps, members } = setup();

    const error = expectErr(
      await updateMember(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-resident"),
        {},
      ),
    );

    expect(error.code).toBe("validation");
    expect(members.callCount("update")).toBe(0);
  });

  it("refuses a resident editing anyone", async () => {
    const { deps, members } = setup();
    seedShadow(members);

    const error = expectErr(
      await updateMember(
        deps,
        asUserId(RESIDENT),
        asSocietyId(SOCIETY),
        asMemberId("m-shadow"),
        {
          displayName: "New Name",
        },
      ),
    );

    expect(error.code).toBe("forbidden");
    expect(members.callCount("update")).toBe(0);
  });

  it("keeps the consent flag writable by a manager", async () => {
    const { deps, members } = setup();
    seedShadow(members);

    const updated = expectOk(
      await updateMember(
        deps,
        asUserId(TREASURER),
        asSocietyId(SOCIETY),
        asMemberId("m-shadow"),
        {
          shareContact: true,
        },
      ),
    );

    expect(updated.member.shareContact).toBe(true);
  });
});

describe("suspendMember and reactivateMember", () => {
  it("suspends an active member", async () => {
    const { deps, members } = setup();

    const suspended = expectOk(
      await suspendMember(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-resident"),
      ),
    );

    expect(suspended.member.status).toBe("inactive");
    expect(members.statusWrites()).toEqual(["inactive"]);
  });

  it("refuses to suspend somebody who is not active", async () => {
    const { deps, members } = setup();

    const error = expectErr(
      await suspendMember(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-pending"),
      ),
    );

    expect(error.code).toBe("conflict");
    expect(members.callCount("setStatus")).toBe(0);
  });

  it("refuses suspending your own membership", async () => {
    const { deps } = setup();

    const error = expectErr(
      await suspendMember(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-admin"),
      ),
    );

    expect(error.code).toBe("forbidden");
  });

  it("reactivates a suspended member and keeps their original join date", async () => {
    const { deps, members } = setup();
    members.seedMember(SOCIETY, {
      id: "m-suspended",
      displayName: "Suspended Person",
      status: "inactive",
    });

    const reactivated = expectOk(
      await reactivateMember(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-suspended"),
      ),
    );

    expect(reactivated.member.status).toBe("active");
    // `stamp_member_removal()` only fills `joined_at` when it is null: reactivation is not a
    // second joining, and the directory's "member since" must not move.
    expect(reactivated.member.joinedAt).toBe("2026-09-24T10:00:00.000Z");
  });

  it("refuses reactivating somebody who is already active", async () => {
    const { deps } = setup();

    const error = expectErr(
      await reactivateMember(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-resident"),
      ),
    );

    expect(error.code).toBe("conflict");
  });

  it("refuses a Treasurer: suspension is access revocation, the Admin-only row", async () => {
    const { deps, members } = setup();

    const error = expectErr(
      await suspendMember(
        deps,
        asUserId(TREASURER),
        asSocietyId(SOCIETY),
        asMemberId("m-resident"),
      ),
    );

    expect(error.code).toBe("forbidden");
    expect(members.callCount("setStatus")).toBe(0);
  });
});

describe("removeMember", () => {
  it("soft-removes another member and leaves the row in place", async () => {
    const { deps, members } = setup();

    expectOk(
      await removeMember(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-resident"),
      ),
    );

    // The row survives with its status changed: dues, payments and receipts will point at
    // `members.id` and PRD §3.3 keeps financial history.
    expect(members.stored("m-resident")?.status).toBe("removed");
    expect(members.stored("m-resident")?.removedAt).not.toBeNull();
  });

  it("removes a shadow member too", async () => {
    const { deps, members } = setup();
    seedShadow(members);

    expect(
      expectOk(
        await removeMember(
          deps,
          asUserId(ADMIN),
          asSocietyId(SOCIETY),
          asMemberId("m-shadow"),
        ),
      ),
    ).toBeUndefined();
  });

  it("refuses removing your own membership — leaving is the society module's path", async () => {
    const { deps, members } = setup();

    const error = expectErr(
      await removeMember(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-admin"),
      ),
    );

    expect(error.code).toBe("forbidden");
    expect(members.callCount("remove")).toBe(0);
  });

  it("refuses a Treasurer", async () => {
    const { deps, members } = setup();

    const error = expectErr(
      await removeMember(
        deps,
        asUserId(TREASURER),
        asSocietyId(SOCIETY),
        asMemberId("m-resident"),
      ),
    );

    expect(error.code).toBe("forbidden");
    expect(members.callCount("remove")).toBe(0);
  });

  it("surfaces the database's refusal to orphan a society of its last admin", async () => {
    // The trigger raises `SOCIETY_ADMIN_REQUIRED`; the adapter classifies it as `sole_admin`,
    // the same code the society module's `leaveSociety` already uses for it. The use case
    // must pass that through rather than turning it into a generic failure.
    const { deps, members } = setup();
    members.failNext(
      "remove",
      new MemberError(
        "sole_admin",
        "A society needs at least one active Admin.",
      ),
    );

    const error = expectErr(
      await removeMember(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-treasurer"),
      ),
    );

    expect(error.code).toBe("sole_admin");
  });

  it("answers not_found for somebody already removed", async () => {
    const { deps } = setup();

    const error = expectErr(
      await removeMember(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-does-not-exist"),
      ),
    );

    expect(error.code).toBe("not_found");
  });
});
