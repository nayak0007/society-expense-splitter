import { MemberError, asMemberId, asSocietyId, asUserId } from "@ses/domain";

import {
  approveJoinRequest,
  rejectJoinRequest,
} from "../use-cases/decide-join-request";
import { listJoinRequests } from "../use-cases/list-join-requests";
import type { MemberDeps } from "../use-cases/support";
import { FakeMemberRepository } from "./support/fake-member-repository";
import { expectErr, expectOk } from "./support/result-expectations";

/**
 * T049's decision use cases, against a fake repository.
 *
 * What these tests are *for*, in order of value:
 *
 *  1. **The refusals happen before storage is touched.** A resident, a stranger, a reviewer
 *     deciding their own request and a request that is not pending are all answered without a
 *     write — asserted on the repository's call log, because "no membership changed" is the
 *     property that matters and the returned error alone does not prove it. The locked write
 *     underneath is the database function's, and `scripts/db/rls-canary.sql` section 10 is
 *     where that half is asserted.
 *  2. **The role check is a grant, not a hard-coded Admin.** A Treasurer may admit at Resident
 *     and not above it; the refusal is `role_not_assignable` and it is checked before I/O.
 *  3. **The reason is validated here, so a form gets a field error** rather than a database
 *     exception, and what reaches storage is the trimmed reason.
 *  4. **The queue is `member.approve`, not `member.view`.** A Resident can browse the directory
 *     and cannot be handed a decision screen; a non-member gets `not_found`, never `forbidden`.
 */

const SOCIETY = "society-1";
const OTHER_SOCIETY = "society-2";

const ADMIN = "user-admin";
const TREASURER = "user-treasurer";
const RESIDENT = "user-resident";

const A_101 = "dddddddd-0000-4000-8000-000000000101";

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
  });
  members.seedMember(SOCIETY, {
    id: "m-treasurer",
    userId: TREASURER,
    role: "treasurer",
    displayName: "Bharat Shah",
  });
  members.seedMember(SOCIETY, {
    id: "m-resident",
    userId: RESIDENT,
    role: "resident",
    displayName: "Meera Krishnan",
  });
  // The queue: one request with a flat, one without. A second claimant on A-101 is what makes
  // `claims` non-trivial.
  members.seedMember(SOCIETY, {
    id: "m-pending",
    userId: "user-pending",
    status: "pending",
    displayName: "Pending Owner",
    apartmentId: A_101,
    apartmentNumber: "A-101",
    buildingName: "Tower A",
    requestNote: "Owner of A-101",
    createdAt: "2026-09-20T00:00:00.000Z",
  });
  members.seedMember(SOCIETY, {
    id: "m-claimant",
    userId: "user-claimant",
    status: "pending",
    displayName: "Second Claimant",
    apartmentId: A_101,
    apartmentNumber: "A-101",
    buildingName: "Tower A",
    requestNote: "Tenant of A-101",
    createdAt: "2026-09-21T00:00:00.000Z",
  });
  members.seedMember(SOCIETY, {
    id: "m-flatless",
    userId: "user-flatless",
    status: "pending",
    displayName: "No Flat Yet",
    createdAt: "2026-09-19T00:00:00.000Z",
  });
  members.seedMember(OTHER_SOCIETY, {
    id: "m-foreign",
    role: "resident",
    displayName: "Other Society Person",
  });
  return { deps: { members }, members };
}

describe("listJoinRequests", () => {
  it("returns the pending rows with every claim on their flat", async () => {
    const { deps } = setup();

    const queue = expectOk(
      await listJoinRequests(deps, asUserId(ADMIN), asSocietyId(SOCIETY)),
    );

    expect(queue.requests.map((request) => request.member.id)).toEqual([
      asMemberId("m-claimant"),
      asMemberId("m-pending"),
      asMemberId("m-flatless"),
    ]);
    expect(queue.total).toBe(3);
    expect(queue.capabilities.canApprove).toBe(true);

    const contested = queue.requests.find(
      (request) => request.member.id === asMemberId("m-claimant"),
    );
    // PRD §3.2's "route it to the Admin with both claims visible": the two claimers on A-101
    // arrive together, this request included.
    expect(contested?.claims.map((claim) => claim.id).sort()).toEqual(
      [asMemberId("m-claimant"), asMemberId("m-pending")].sort(),
    );
    expect(contested?.member.requestNote).toBe("Tenant of A-101");

    // A request with no flat has no claims by construction — "both have no flat" is not a
    // claim on anything.
    const flatless = queue.requests.find(
      (request) => request.member.id === asMemberId("m-flatless"),
    );
    expect(flatless?.claims).toEqual([]);
  });

  it("is member.approve — a Resident is refused before the queue is read", async () => {
    const { deps, members } = setup();

    const error = expectErr(
      await listJoinRequests(deps, asUserId(RESIDENT), asSocietyId(SOCIETY)),
    );

    expect(error.code).toBe("forbidden");
    expect(members.callCount("listJoinRequests")).toBe(0);
  });

  it("answers a non-member with not_found, never forbidden", async () => {
    const { deps, members } = setup();

    const error = expectErr(
      await listJoinRequests(
        deps,
        asUserId("user-outsider"),
        asSocietyId(SOCIETY),
      ),
    );

    expect(error.code).toBe("not_found");
    expect(members.callCount("listJoinRequests")).toBe(0);
  });

  it("pages with the directory's own bounds and reports the filters' total", async () => {
    const { deps } = setup();

    const queue = expectOk(
      await listJoinRequests(deps, asUserId(TREASURER), asSocietyId(SOCIETY), {
        limit: 1,
        offset: 1,
      }),
    );

    expect(queue.limit).toBe(1);
    expect(queue.offset).toBe(1);
    expect(queue.requests).toHaveLength(1);
    // The total is what the filter produced, not the page size: "showing 1 of 3".
    expect(queue.total).toBe(3);
  });

  it("converts a repository failure into the domain's error vocabulary", async () => {
    const { deps, members } = setup();
    members.failNext(
      "listJoinRequests",
      new MemberError("conflict", "The queue is unavailable."),
    );

    expect(
      expectErr(
        await listJoinRequests(deps, asUserId(ADMIN), asSocietyId(SOCIETY)),
      ).code,
    ).toBe("conflict");
  });
});

describe("approveJoinRequest", () => {
  it('admits a request as Treasurer, recording an empty payload as "as requested"', async () => {
    const { deps, members } = setup();

    const detail = expectOk(
      await approveJoinRequest(
        deps,
        asUserId(TREASURER),
        asSocietyId(SOCIETY),
        asMemberId("m-pending"),
      ),
    );

    expect(detail.member.status).toBe("active");
    expect(detail.member.id).toBe(asMemberId("m-pending"));
    // The row keeps what the requester declared: the default payload overrides nothing.
    expect(detail.member.occupancy).toBe("owner_occupied");
    expect(detail.member.apartmentId).toBe(A_101);

    expect(members.approvalInputs()).toEqual([
      { id: asMemberId("m-pending"), input: {} },
    ]);
  });

  it("lets an Admin confirm a corrected flat", async () => {
    const { deps, members } = setup();

    const detail = expectOk(
      await approveJoinRequest(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-flatless"),
        {
          apartmentId: A_101,
          occupancy: "tenant",
          isPrimary: false,
        },
      ),
    );

    expect(detail.member.apartmentId).toBe(A_101);
    expect(detail.member.occupancy).toBe("tenant");
    expect(members.approvalInputs()[0]?.input).toMatchObject({
      apartmentId: A_101,
      occupancy: "tenant",
    });
  });

  it("refuses a Treasurer handing out a role above Resident, before any write", async () => {
    const { deps, members } = setup();

    const error = expectErr(
      await approveJoinRequest(
        deps,
        asUserId(TREASURER),
        asSocietyId(SOCIETY),
        asMemberId("m-pending"),
        { role: "admin" },
      ),
    );

    expect(error.code).toBe("role_not_assignable");
    expect(error.details).toMatchObject({ field: "role" });
    expect(members.callCount("approveJoinRequest")).toBe(0);
  });

  it("refuses a request that was already decided", async () => {
    const { deps, members } = setup();
    members.seedMember(SOCIETY, {
      id: "m-decided",
      status: "active",
      displayName: "Already In",
    });

    const error = expectErr(
      await approveJoinRequest(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-decided"),
      ),
    );

    expect(error.code).toBe("join_request_not_pending");
    expect(error.details).toMatchObject({ field: "memberId" });
    expect(members.callCount("approveJoinRequest")).toBe(0);
  });

  it("refuses a reviewer deciding their own request — by account, not just by row", async () => {
    const { deps, members } = setup();
    // The same account, a second row: the structural case the schema heads toward and the one
    // a row-id check alone would miss.
    members.seedMember(SOCIETY, {
      id: "m-admin-reask",
      userId: ADMIN,
      status: "pending",
      displayName: "Anita Rao",
    });

    const error = expectErr(
      await approveJoinRequest(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-admin-reask"),
      ),
    );

    expect(error.code).toBe("self_review");
    expect(members.callCount("approveJoinRequest")).toBe(0);
  });

  it("refuses a caller without the grant, and one who is not a member at all", async () => {
    const { deps } = setup();

    expect(
      expectErr(
        await approveJoinRequest(
          deps,
          asUserId(RESIDENT),
          asSocietyId(SOCIETY),
          asMemberId("m-pending"),
        ),
      ).code,
    ).toBe("forbidden");

    expect(
      expectErr(
        await approveJoinRequest(
          deps,
          asUserId("user-outsider"),
          asSocietyId(SOCIETY),
          asMemberId("m-pending"),
        ),
      ).code,
    ).toBe("not_found");
  });

  it("names the flat when primacy is asked for with none", async () => {
    const { deps, members } = setup();

    const error = expectErr(
      await approveJoinRequest(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-flatless"),
        { isPrimary: true },
      ),
    );

    expect(error.code).toBe("validation");
    expect(error.details).toMatchObject({ field: "apartmentId" });
    expect(members.callCount("approveJoinRequest")).toBe(0);
  });

  it("converts a repository failure — a lost race, say — into the domain's error", async () => {
    const { deps, members } = setup();
    members.failNext(
      "approveJoinRequest",
      new MemberError(
        "join_request_not_pending",
        "That request has already been decided.",
      ),
    );

    expect(
      expectErr(
        await approveJoinRequest(
          deps,
          asUserId(ADMIN),
          asSocietyId(SOCIETY),
          asMemberId("m-pending"),
        ),
      ).code,
    ).toBe("join_request_not_pending");
  });
});

describe("rejectJoinRequest", () => {
  it("records the trimmed reason and the rejection stamps", async () => {
    const { deps, members } = setup();

    const detail = expectOk(
      await rejectJoinRequest(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-pending"),
        "  R-101 belongs to another owner.  ",
      ),
    );

    expect(detail.member.status).toBe("rejected");
    expect(detail.member.rejectionReason).toBe(
      "R-101 belongs to another owner.",
    );
    expect(members.rejectionReasons()).toEqual([
      "R-101 belongs to another owner.",
    ]);
  });

  it("requires a reason a requester can act on, before any write", async () => {
    const { deps, members } = setup();

    for (const reason of ["", "no", "   "]) {
      const error = expectErr(
        await rejectJoinRequest(
          deps,
          asUserId(TREASURER),
          asSocietyId(SOCIETY),
          asMemberId("m-pending"),
          reason,
        ),
      );
      expect(error.code).toBe("validation");
      expect(error.details).toMatchObject({ field: "reason" });
    }
    expect(members.callCount("rejectJoinRequest")).toBe(0);
  });

  it("refuses a second decision on the same request", async () => {
    const { deps, members } = setup();

    expectOk(
      await rejectJoinRequest(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-pending"),
        "Wrong flat.",
      ),
    );

    const error = expectErr(
      await rejectJoinRequest(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-pending"),
        "Wrong flat again.",
      ),
    );

    expect(error.code).toBe("join_request_not_pending");
    expect(members.callCount("rejectJoinRequest")).toBe(1);
  });

  it("is member.approve: a Resident is refused, and a stranger learns nothing", async () => {
    const { deps, members } = setup();

    expect(
      expectErr(
        await rejectJoinRequest(
          deps,
          asUserId(RESIDENT),
          asSocietyId(SOCIETY),
          asMemberId("m-pending"),
          "Not yours to decide.",
        ),
      ).code,
    ).toBe("forbidden");

    expect(
      expectErr(
        await rejectJoinRequest(
          deps,
          asUserId("user-outsider"),
          asSocietyId(SOCIETY),
          asMemberId("m-pending"),
          "Not yours to decide.",
        ),
      ).code,
    ).toBe("not_found");

    expect(members.callCount("rejectJoinRequest")).toBe(0);
  });
});
