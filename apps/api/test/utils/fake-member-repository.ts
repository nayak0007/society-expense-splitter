import { randomUUID } from "node:crypto";

import {
  DEFAULT_MEMBER_OCCUPANCY,
  DEFAULT_MEMBER_ROLE,
  MemberError,
  asApartmentId,
  asBuildingId,
  asMemberId,
  asSocietyId,
  asUserId,
} from "@ses/domain";
import type {
  CreateMemberInput,
  JoinApprovalInput,
  JoinRequest,
  JoinRequestPage,
  JoinRequestQuery,
  Member,
  MemberActivation,
  MemberId,
  MemberPage,
  MemberQuery,
  MemberRepository,
  MemberRole,
  MemberStatus,
  UpdateMemberInput,
  UserId,
} from "@ses/domain";

/**
 * An in-memory `MemberRepository` for HTTP-level tests.
 *
 * ## What is faked, and what is emphatically not
 *
 * Only the *storage* and the *tenancy check* — the two things that need a Postgres connection.
 * Everything between the request and this object runs for real: the global auth guard verifies
 * a real signature, `SocietyGuard` resolves the header, `PermissionGuard` asks the domain's
 * matrix, the Zod pipe parses the real contract schema, `MembersOperations` calls the real use
 * case, and the mapper parses its output against the same contract the mobile client does. A
 * fake at *this* boundary therefore still fails when a rule regresses; a fake at the controller
 * boundary would not.
 *
 * It reproduces the three properties the port promises or the storage enforces, and each is a
 * fact rather than a rule:
 *
 *  - a member is addressable only by the pair `(member id, society id)`, so a member of another
 *    society is *unreachable*, not merely unauthorised — the assertion that matters for
 *    cross-tenant isolation;
 *  - `update` distinguishes absent (`undefined` = unchanged) from `null` (= clear), which is the
 *    single rule that makes the patch API honest;
 *  - `uq_members_shadow_phone` and `uq_primary_occupant`, because a unique index is a
 *    storage-level fact rather than a rule — the same choice the building fake makes for
 *    `uq_buildings_society_name`. Note *which* rows: the phone index covers shadow members
 *    (`user_id IS NULL`) only, so a fake that enforced it over every row would fail the one test
 *    that proves two account-holders may share a number.
 *
 * It deliberately does **not** enforce the Admin role, the capability rules, the value ranges,
 * the status-transition rules — nor T046's role caps: `countActiveByRole` answers a count and
 * `setRole` writes what it is given, so a suite exercises the *use case's* cap check rather than
 * this object's. Those rules are what the guard chain, the use cases and the domain's value
 * objects are under test for, and a fake that enforced them too would let a broken one pass.
 *
 * It is **not** a substitute for the RLS canary: nothing here evaluates a policy, so a mistake in
 * the committed SQL is invisible to these tests. That is the point of saying so out loud.
 */

export interface FakeMemberRepository extends MemberRepository {
  /** How many times each port method was called — the "did this route write?" assertion. */
  callCount(method: string): number;
  readonly state: {
    readonly members: Map<string, Member>;
    readonly calls: string[];
    /**
     * Empties the store **and resets the sequence**, so a suite's `beforeEach` produces the same
     * fixtures every time.
     *
     * The reset is not tidiness: the seeded flat and building labels are derived from the
     * sequence, so a store that was cleared without rewinding it would hand the second test in a
     * file a member in `building-16` when the test asks for `building-6` — a failure that looks
     * like a filter bug and is a fixture bug.
     */
    readonly reset: () => void;
  };
  /** Inserts a member out of band, bypassing every rule. */
  seed(
    societyId: string,
    spec?: {
      readonly id?: string;
      readonly userId?: string | null;
      readonly apartmentId?: string | null;
      readonly displayName?: string;
      readonly phone?: string | null;
      readonly email?: string | null;
      readonly role?: MemberRole;
      readonly status?: MemberStatus;
      readonly isPrimary?: boolean;
      readonly shareContact?: boolean;
      readonly removed?: boolean;
      /** T049 — what the requester wrote, and what a previous decision said. */
      readonly requestNote?: string | null;
      readonly rejectionReason?: string | null;
      readonly rejectedAt?: string | null;
      readonly createdAt?: string;
    },
  ): Member;
}

const NOW = "2026-09-25T10:00:00.000Z";

export function createFakeMemberRepository(): FakeMemberRepository {
  const members = new Map<string, Member>();
  const calls: string[] = [];
  let sequence = 0;

  function seed(
    societyId: string,
    spec: {
      readonly id?: string;
      readonly userId?: string | null;
      readonly apartmentId?: string | null;
      readonly displayName?: string;
      readonly phone?: string | null;
      readonly email?: string | null;
      readonly role?: MemberRole;
      readonly status?: MemberStatus;
      readonly isPrimary?: boolean;
      readonly shareContact?: boolean;
      readonly removed?: boolean;
      readonly requestNote?: string | null;
      readonly rejectionReason?: string | null;
      readonly rejectedAt?: string | null;
      readonly createdAt?: string;
    } = {},
  ): Member {
    sequence += 1;
    const status: MemberStatus =
      spec.status ?? (spec.removed === true ? "removed" : "active");
    const apartmentId = spec.apartmentId ?? null;
    const member: Member = {
      id: asMemberId(spec.id ?? randomUUID()),
      societyId: asSocietyId(societyId),
      userId:
        spec.userId === null || spec.userId === undefined
          ? null
          : asUserId(spec.userId),
      apartmentId: apartmentId === null ? null : asApartmentId(apartmentId),
      // Shaped like a real UUID, because the *contract* validates `buildingId` as one: a fixture
      // label like `building-1` would make every filter-by-building test answer 422 at the pipe and
      // look like a filter bug.
      apartment:
        apartmentId === null
          ? null
          : {
              id: asApartmentId(apartmentId),
              number: `A-${100 + sequence}`,
              buildingId: asBuildingId(
                `dddddddd-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
              ),
              buildingName: "Block A",
              floor: 1,
            },
      displayName: spec.displayName ?? `Member ${sequence}`,
      phone: spec.phone ?? null,
      email: spec.email ?? null,
      role: spec.role ?? DEFAULT_MEMBER_ROLE,
      status,
      occupancy: DEFAULT_MEMBER_OCCUPANCY,
      isPrimary: spec.isPrimary ?? false,
      leaseStart: null,
      leaseEnd: null,
      shareContact: spec.shareContact ?? false,
      joinedAt: status === "pending" ? null : NOW,
      approvedBy: null,
      removedAt: status === "removed" ? NOW : null,
      removedBy: null,
      requestNote: spec.requestNote ?? null,
      rejectionReason: spec.rejectionReason ?? null,
      rejectedAt: spec.rejectedAt ?? null,
      rejectedBy: null,
      createdAt: spec.createdAt ?? NOW,
      updatedAt: NOW,
    };
    members.set(member.id, member);
    return member;
  }

  /**
   * The two partial unique indexes, reproduced over *live* rows only and with the same
   * predicates the migration uses — including that the phone index covers shadow members alone.
   */
  function assertStorageRules(next: Member, exceptId?: string): void {
    if (
      next.userId === null &&
      next.phone !== null &&
      next.status !== "removed"
    ) {
      const clash = [...members.values()].find(
        (member) =>
          member.id !== exceptId &&
          member.societyId === next.societyId &&
          member.userId === null &&
          member.phone === next.phone &&
          member.status !== "removed",
      );
      if (clash !== undefined) {
        throw new MemberError(
          "conflict",
          "Another member in this society is already recorded with that number.",
          { field: "phone" },
        );
      }
    }

    if (
      next.isPrimary &&
      next.apartmentId !== null &&
      next.status === "active"
    ) {
      const clash = [...members.values()].find(
        (member) =>
          member.id !== exceptId &&
          member.societyId === next.societyId &&
          member.apartmentId === next.apartmentId &&
          member.isPrimary &&
          member.status === "active",
      );
      if (clash !== undefined) {
        throw new MemberError(
          "conflict",
          "That flat already has a primary occupant.",
          { field: "apartmentId" },
        );
      }
    }
  }

  /** The actor's own membership id — what the SQL stamps as the decision's author. */
  const reviewerId = (
    societyId: string,
    actor: UserId,
  ): MemberId | undefined => {
    const found = [...members.values()].find(
      (member) => member.societyId === societyId && member.userId === actor,
    );
    return found === undefined ? undefined : found.id;
  };

  const live = (id: string, societyId: string): Member | undefined => {
    const member = members.get(id);
    if (member === undefined) return undefined;
    if (member.societyId !== societyId) return undefined;
    if (member.status === "removed") return undefined;
    return member;
  };

  return {
    callCount(method: string): number {
      return calls.filter((entry) => entry === method).length;
    },
    state: {
      members,
      calls,
      reset: () => {
        members.clear();
        calls.length = 0;
        sequence = 0;
      },
    },
    seed,

    async list(
      societyId,
      _actor: UserId,
      query: MemberQuery,
    ): Promise<MemberPage> {
      calls.push("list");
      const filtered = [...members.values()]
        .filter((member) => member.societyId === societyId)
        .filter((member) =>
          query.status === undefined
            ? member.status !== "removed"
            : member.status === query.status,
        )
        .filter((member) =>
          query.role === undefined ? true : member.role === query.role,
        )
        .filter((member) =>
          query.occupancy === undefined
            ? true
            : member.occupancy === query.occupancy,
        )
        .filter((member) =>
          query.apartmentId === undefined
            ? true
            : member.apartmentId === query.apartmentId,
        )
        .filter((member) =>
          query.buildingId === undefined
            ? true
            : member.apartment?.buildingId === query.buildingId,
        )
        .filter((member) => {
          const needle = query.query?.trim().toLowerCase();
          if (needle === undefined || needle.length === 0) return true;
          if (member.displayName.toLowerCase().includes(needle)) return true;
          if (member.phone !== null && member.phone.includes(needle))
            return true;
          return member.apartment?.number.toLowerCase() === needle;
        })
        .sort((left, right) =>
          query.sort === "joined"
            ? (right.joinedAt ?? "").localeCompare(left.joinedAt ?? "")
            : left.displayName.localeCompare(right.displayName) ||
              left.id.localeCompare(right.id),
        );

      const limit = query.limit ?? 50;
      const offset = query.offset ?? 0;
      return {
        members: filtered.slice(offset, offset + limit),
        total: filtered.length,
      };
    },

    async findById(id, societyId) {
      calls.push("findById");
      return live(id, societyId) ?? null;
    },

    async findViewer(societyId, actor) {
      calls.push("findViewer");
      return (
        [...members.values()].find(
          (member) =>
            member.societyId === societyId &&
            member.userId === actor &&
            member.status !== "removed",
        ) ?? null
      );
    },

    async findLiveShadowByPhone(societyId, phone, _actor, exceptId) {
      calls.push("findLiveShadowByPhone");
      return (
        [...members.values()].find(
          (member) =>
            member.societyId === societyId &&
            member.userId === null &&
            member.phone === phone &&
            member.status !== "removed" &&
            member.id !== exceptId,
        ) ?? null
      );
    },

    async create(societyId, input: CreateMemberInput) {
      calls.push("create");
      sequence += 1;
      const created: Member = {
        id: asMemberId(`created-${sequence}`),
        societyId: asSocietyId(societyId),
        // No account: the direct-add path's whole point.
        userId: null,
        apartmentId:
          input.apartmentId === undefined || input.apartmentId === null
            ? null
            : asApartmentId(input.apartmentId),
        apartment: null,
        displayName: input.displayName,
        phone: input.phone,
        email: input.email ?? null,
        role: DEFAULT_MEMBER_ROLE,
        status: "active",
        occupancy: input.occupancy ?? DEFAULT_MEMBER_OCCUPANCY,
        isPrimary: input.isPrimary ?? false,
        leaseStart: input.leaseStart ?? null,
        leaseEnd: input.leaseEnd ?? null,
        shareContact: input.shareContact ?? false,
        joinedAt: NOW,
        approvedBy: null,
        removedAt: null,
        removedBy: null,
        requestNote: null,
        rejectionReason: null,
        rejectedAt: null,
        rejectedBy: null,
        createdAt: NOW,
        updatedAt: NOW,
      };
      assertStorageRules(created);
      members.set(created.id, created);
      return created;
    },

    async update(id: MemberId, societyId, input: UpdateMemberInput) {
      calls.push("update");
      const existing = live(id, societyId);
      if (existing === undefined) {
        throw new MemberError(
          "not_found",
          "That member is not available to you.",
        );
      }
      const patch = input as Record<string, unknown>;
      const next: Member = {
        ...existing,
        ...("displayName" in patch ? { displayName: input.displayName } : {}),
        ...("phone" in patch ? { phone: input.phone ?? null } : {}),
        ...("email" in patch ? { email: input.email ?? null } : {}),
        ...("occupancy" in patch ? { occupancy: input.occupancy } : {}),
        ...("apartmentId" in patch
          ? {
              apartmentId:
                input.apartmentId === null || input.apartmentId === undefined
                  ? null
                  : asApartmentId(input.apartmentId),
            }
          : {}),
        ...("isPrimary" in patch ? { isPrimary: input.isPrimary } : {}),
        ...("leaseStart" in patch
          ? { leaseStart: input.leaseStart ?? null }
          : {}),
        ...("leaseEnd" in patch ? { leaseEnd: input.leaseEnd ?? null } : {}),
        ...("shareContact" in patch
          ? { shareContact: input.shareContact }
          : {}),
        updatedAt: NOW,
      } as Member;

      assertStorageRules(next, existing.id);
      members.set(next.id, next);
      return next;
    },

    async setStatus(id, societyId, status: MemberActivation) {
      calls.push("setStatus");
      const existing = live(id, societyId);
      if (existing === undefined) {
        throw new MemberError(
          "not_found",
          "That member is not available to you.",
        );
      }
      const next: Member = {
        ...existing,
        status,
        joinedAt:
          status === "active" && existing.joinedAt === null
            ? NOW
            : existing.joinedAt,
        updatedAt: NOW,
      };
      assertStorageRules(next, existing.id);
      members.set(next.id, next);
      return next;
    },

    /**
     * The storage half of a role change, and nothing more — the caps, the self-change rule, the
     * target's status and the last-Admin rule stay where they live (the use case and the database),
     * so a suite that broke one of them would still fail here. `role` is written as given:
     * `committee_member` is the domain's spelling and this object stores domain members, so no
     * transition table is involved (the adapter's `roleToDatabase` is a Postgres concern).
     */
    async setRole(id, societyId, role: MemberRole) {
      calls.push("setRole");
      const existing = live(id, societyId);
      if (existing === undefined) {
        throw new MemberError(
          "not_found",
          "That member is not available to you.",
        );
      }
      const next: Member = { ...existing, role, updatedAt: NOW };
      members.set(next.id, next);
      return next;
    },

    /** Counts live rows the way the SQL does: `active` only, `exceptId` excluded. */
    async countActiveByRole(
      societyId,
      role: MemberRole,
      _actor: UserId,
      exceptId?: MemberId,
    ): Promise<number> {
      calls.push("countActiveByRole");
      return [...members.values()].filter(
        (member) =>
          member.societyId === societyId &&
          member.role === role &&
          member.status === "active" &&
          member.id !== exceptId,
      ).length;
    },

    /**
     * The queue, with the claims Postgres would compute (T049).
     *
     * Both halves are reproduced as *facts* rather than rules: the pending filter and ordering
     * are the query's own shape, and the claims are every live membership naming the same flat —
     * including a second pending one, which is the collision the PRD says to surface rather than
     * auto-reject.
     */
    async listJoinRequests(
      societyId,
      _actor: UserId,
      query: JoinRequestQuery,
    ): Promise<JoinRequestPage> {
      calls.push("listJoinRequests");
      const pending = [...members.values()]
        .filter(
          (member) =>
            member.societyId === societyId && member.status === "pending",
        )
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

      const requests: JoinRequest[] = pending.map((member) => ({
        member,
        claims: [...members.values()].filter(
          (claim) =>
            claim.societyId === societyId &&
            claim.status !== "removed" &&
            member.apartmentId !== null &&
            claim.apartmentId === member.apartmentId,
        ),
      }));

      const limit = query.limit ?? 50;
      const offset = query.offset ?? 0;
      return {
        requests: requests.slice(offset, offset + limit),
        total: requests.length,
      };
    },

    /**
     * The decision's storage half: the row becomes `active` with what the approver confirmed.
     *
     * `uq_primary_occupant` is re-checked through `assertStorageRules`, because it is a
     * storage fact rather than a rule and it is exactly what refuses two primary claims on one
     * flat — the "both claims visible, one decision" rule reaching the database.
     */
    async approveJoinRequest(
      id: MemberId,
      societyId,
      input: JoinApprovalInput,
      actor: UserId,
    ) {
      calls.push("approveJoinRequest");
      const existing = live(id, societyId);
      if (existing === undefined) {
        throw new MemberError(
          "not_found",
          "That member is not available to you.",
        );
      }
      const next: Member = {
        ...existing,
        status: "active",
        role: input.role ?? existing.role,
        occupancy: input.occupancy ?? existing.occupancy,
        apartmentId:
          input.apartmentId === undefined
            ? existing.apartmentId
            : input.apartmentId === null
              ? null
              : asApartmentId(input.apartmentId),
        isPrimary: input.isPrimary ?? existing.isPrimary,
        joinedAt: existing.joinedAt ?? NOW,
        approvedBy: reviewerId(societyId, actor) ?? null,
        rejectionReason: null,
        rejectedAt: null,
        rejectedBy: null,
        updatedAt: NOW,
      };
      assertStorageRules(next, existing.id);
      members.set(next.id, next);
      return next;
    },

    async rejectJoinRequest(id, societyId, reason: string, actor: UserId) {
      calls.push("rejectJoinRequest");
      const existing = live(id, societyId);
      if (existing === undefined) {
        throw new MemberError(
          "not_found",
          "That member is not available to you.",
        );
      }
      const next: Member = {
        ...existing,
        status: "rejected",
        rejectionReason: reason,
        rejectedAt: NOW,
        rejectedBy: reviewerId(societyId, actor) ?? null,
        updatedAt: NOW,
      };
      members.set(next.id, next);
      return next;
    },

    async remove(id, societyId) {
      calls.push("remove");
      const existing = live(id, societyId);
      if (existing === undefined) {
        throw new MemberError(
          "not_found",
          "That member is not available to you.",
        );
      }
      // Soft: the row stays, exactly as the port promises.
      members.set(existing.id, {
        ...existing,
        status: "removed",
        removedAt: NOW,
        updatedAt: NOW,
      });
    },
  };
}
