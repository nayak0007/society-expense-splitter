import { asMemberId, asSocietyId, asUserId } from "../../shared/ids";
import {
  checkJoinRequestReview,
  checkJoinRoleAssignment,
  createJoinNote,
  createRejectionReason,
  isJoinRequestState,
  JOIN_NOTE_MAX_LENGTH,
  JOIN_REQUEST_STATES,
  joinRequestState,
  REJECTION_REASON_MAX_LENGTH,
  REJECTION_REASON_MIN_LENGTH,
} from "../join-requests";
import { MEMBER_STATUSES } from "../member";
import type { Member, MemberStatus } from "../member";

/**
 * T049's join-request rules — PRD §3.2's lifecycle, the note and reason bounds, and the two
 * questions a decision asks (may this reviewer decide, and may they hand out this role).
 *
 * The assertions are written against the PRD's numbers and states rather than against the
 * constants, where the two could drift: `expect(REJECTION_REASON_MIN_LENGTH).toBe(4)` makes a
 * change to the bound a deliberate act with a failing test in front of it, rather than a silent
 * redefinition of "a reason".
 *
 * This file deliberately does **not** test that a write happened. Nothing in
 * `join-requests.ts` writes — `checkJoinRequestReview` answers a question and the decision is
 * the database function's — so the tests here are about the *answers*, and the migration's own
 * canary is what proves the locked write (`scripts/db/rls-canary.sql`, section 10).
 */

function member(overrides: Partial<Member> = {}): Member {
  return {
    id: asMemberId("aaaaaaaa-0000-4000-8000-000000000001"),
    societyId: asSocietyId("aaaaaaaa-0000-4000-8000-0000000000ff"),
    userId: asUserId("bbbbbbbb-0000-4000-8000-000000000001"),
    apartmentId: null,
    apartment: null,
    displayName: "Meera Krishnan",
    phone: "+919876543210",
    email: "meera@example.com",
    role: "resident",
    status: "pending",
    occupancy: "tenant",
    isPrimary: false,
    leaseStart: null,
    leaseEnd: null,
    shareContact: false,
    joinedAt: null,
    approvedBy: null,
    removedAt: null,
    removedBy: null,
    requestNote: "Tenant of A-402 from March",
    rejectionReason: null,
    rejectedAt: null,
    rejectedBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("joinRequestState", () => {
  it("maps the five membership statuses to the four request states", () => {
    expect(joinRequestState("pending")).toBe("pending");
    expect(joinRequestState("active")).toBe("approved");
    expect(joinRequestState("rejected")).toBe("rejected");
    expect(joinRequestState("removed")).toBe("withdrawn");
  });

  it("reports a suspended member's request as approved, not as pending", () => {
    // `inactive` is a member-level state: the request *was* approved and a suspension does not
    // re-open the queue. Collapsing it into `pending` would show "awaiting approval" to somebody
    // an Admin had already admitted and then suspended — a different screen with a different
    // action.
    expect(joinRequestState("inactive")).toBe("approved");
  });

  it("answers for every membership status the schema can hold", () => {
    // A status the switch does not handle would return `undefined` with no error anywhere; this
    // is what makes a fifth status a visible decision rather than a missing screen.
    for (const status of MEMBER_STATUSES) {
      expect(JOIN_REQUEST_STATES).toContain(joinRequestState(status));
    }
  });

  it("has no `expired` state, deliberately", () => {
    // Neither the PRD nor the roadmap gives a join request a TTL. Where expiry *is* part of the
    // design — invitations — it is derived and checked at acceptance. A request lives until
    // somebody decides.
    expect(JOIN_REQUEST_STATES).not.toContain("expired");
    expect([...JOIN_REQUEST_STATES]).toEqual([
      "pending",
      "approved",
      "rejected",
      "withdrawn",
    ]);
  });
});

describe("isJoinRequestState", () => {
  it("accepts the four states and nothing else", () => {
    for (const state of JOIN_REQUEST_STATES) {
      expect(isJoinRequestState(state)).toBe(true);
    }
    for (const value of ["expired", "PENDING", "", 3, null, undefined, {}]) {
      expect(isJoinRequestState(value)).toBe(false);
    }
  });
});

describe("createJoinNote", () => {
  it("treats absence and blankness as no note, never as an error", () => {
    // The note is optional (PRD §3.2's flow is code → flat → occupancy → submit): a required
    // message would put a text box in the way of the common case.
    for (const raw of [null, undefined, "", "   ", "\n\t"]) {
      const result = createJoinNote(raw);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBeNull();
    }
  });

  it("trims the note it stores", () => {
    const result = createJoinNote("  Tenant of A-402  ");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("Tenant of A-402");
  });

  it("bounds the note at the column's own length", () => {
    expect(JOIN_NOTE_MAX_LENGTH).toBe(500);
    expect(createJoinNote("x".repeat(500)).ok).toBe(true);

    const tooLong = createJoinNote("x".repeat(501));
    expect(tooLong.ok).toBe(false);
    if (tooLong.ok) return;
    expect(tooLong.error.code).toBe("validation");
    expect(tooLong.error.details).toMatchObject({ field: "message" });
  });
});

describe("createRejectionReason", () => {
  it("requires a reason a requester can act on", () => {
    expect(REJECTION_REASON_MIN_LENGTH).toBe(4);
    for (const raw of [null, undefined, "", " ", "no", " no "]) {
      const result = createRejectionReason(raw);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe("validation");
      expect(result.error.details).toMatchObject({ field: "reason" });
    }
  });

  it("accepts the first usable length and trims what it accepts", () => {
    const result = createRejectionReason("  Wrong flat.  ");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("Wrong flat.");

    expect(createRejectionReason("nope").ok).toBe(true);
  });

  it("bounds the reason at the column's own length", () => {
    expect(REJECTION_REASON_MAX_LENGTH).toBe(500);
    expect(createRejectionReason("x".repeat(500)).ok).toBe(true);
    expect(createRejectionReason("x".repeat(501)).ok).toBe(false);
  });
});

describe("checkJoinRequestReview", () => {
  const viewer = member({
    id: asMemberId("aaaaaaaa-0000-4000-8000-00000000000a"),
    userId: asUserId("bbbbbbbb-0000-4000-8000-00000000000a"),
    role: "treasurer",
    status: "active",
  });

  it("refuses a request that is no longer pending, before anything else", () => {
    for (const status of [
      "active",
      "inactive",
      "rejected",
      "removed",
    ] as const) {
      const result = checkJoinRequestReview(
        viewer,
        member({ status: status as MemberStatus }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe("join_request_not_pending");
      expect(result.error.details).toMatchObject({ field: "memberId" });
    }
  });

  it("refuses a reviewer deciding their own request, by row id", () => {
    const request = member({ id: viewer.id, userId: null });
    const result = checkJoinRequestReview(viewer, request);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("self_review");
  });

  it("refuses a reviewer deciding their own request, by account", () => {
    // The row-id check alone would miss the case the schema is heading toward: one account with
    // a second membership row in the same society (a re-ask after removal) reviewing itself.
    const request = member({
      id: asMemberId("m-other"),
      userId: viewer.userId,
    });
    const result = checkJoinRequestReview(viewer, request);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("self_review");
  });

  it("allows a different person to decide a pending request", () => {
    expect(checkJoinRequestReview(viewer, member()).ok).toBe(true);
  });
});

describe("checkJoinRoleAssignment", () => {
  const admin = member({ role: "admin", status: "active" });
  const treasurer = member({ role: "treasurer", status: "active" });

  it("lets either reviewer admit at the default role", () => {
    expect(checkJoinRoleAssignment(treasurer, "resident").ok).toBe(true);
    expect(checkJoinRoleAssignment(admin, "resident").ok).toBe(true);
  });

  it("lets only an Admin hand out anything above Resident", () => {
    // The same asymmetry the invitation path enforces (`stamp_invitation_creator`): a Treasurer
    // holds `member.approve` — whether somebody joins — and only an Admin holds
    // `member.role_change`, which is what handing out a role is.
    for (const role of [
      "admin",
      "treasurer",
      "committee_member",
      "tenant",
      "guest",
    ] as const) {
      const result = checkJoinRoleAssignment(treasurer, role);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("role_not_assignable");
        expect(result.error.details).toMatchObject({ field: "role" });
      }
      expect(checkJoinRoleAssignment(admin, role).ok).toBe(true);
    }
  });
});
