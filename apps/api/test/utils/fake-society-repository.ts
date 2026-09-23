import { randomUUID } from "node:crypto";

import {
  DEFAULT_SOCIETY_SETTINGS,
  JOIN_CODE_ALPHABET,
  JOIN_CODE_LENGTH,
  SocietyError,
  asMemberId,
  asSocietyId,
  asUserId,
  slugify,
} from "@ses/domain";
import type {
  Clock,
  CreateSocietyInput,
  JoinSocietyInput,
  Society,
  SocietyId,
  SocietyJoinPreview,
  SocietyMembership,
  SocietyRepository,
  UpdateSocietyInput,
  UserId,
} from "@ses/domain";

/**
 * An in-memory `SocietyRepository` for HTTP-level tests.
 *
 * ## What is faked, and what is emphatically not
 *
 * Only the *storage* and the *tenancy check* — the two things that need a
 * Postgres connection. Everything between the request and this object runs for
 * real: the global auth guard verifies a real signature, the Zod pipe parses the
 * real contract schema, `SocietyOperations` calls the real use case, the domain's
 * value objects validate, and the mapper parses its output against the same
 * contract the mobile client does. A fake at *this* boundary therefore still
 * fails when a rule regresses; a fake at the controller boundary would not.
 *
 * The tenancy semantics are reproduced deliberately rather than simplified,
 * because they are the contract a real adapter must honour:
 *
 *  - a non-member gets `not_found` from `findById`, never `forbidden` (PRD T041),
 *    so the suite can assert that a foreign society is indistinguishable from a
 *    non-existent one;
 *  - `listSocietyMemberships` throws rather than returning an empty list — an
 *    empty list would confirm the society exists;
 *  - `join` never auto-approves (PRD §3.2), and a second join is
 *    `already_member`.
 *
 * It is **not** a substitute for the RLS suite (T017): nothing here evaluates a
 * policy, so a mistake in the committed SQL is invisible to these tests. That is
 * the point of saying so out loud.
 */

/**
 * Monotonic join codes that satisfy `JOIN_CODE_PATTERN`.
 *
 * Minted from the domain's own alphabet and length rather than a literal like
 * `CODE01`: the contract rejects `0`, `O`, `1` and `I` to avoid transcription
 * errors, so an invented code would make every test fail at the *pipe* — which
 * looks like an application bug and is actually the fixture lying about what the
 * database would return.
 */
function joinCodeSequence(): () => string {
  let n = 0;
  return () => {
    n += 1;
    let code = "";
    let remaining = n;
    for (let index = 0; index < JOIN_CODE_LENGTH; index += 1) {
      code =
        JOIN_CODE_ALPHABET.charAt(remaining % JOIN_CODE_ALPHABET.length) + code;
      remaining = Math.floor(remaining / JOIN_CODE_ALPHABET.length);
    }
    return code;
  };
}

export interface FakeSocietyRepositoryOptions {
  /** Pre-seeded societies, keyed by their id. */
  readonly societies?: readonly Society[];
  readonly memberships?: readonly SocietyMembership[];
  readonly clock?: Clock;
}

export interface FakeSocietyRepository extends SocietyRepository {
  /** Direct access for arranging a test's starting state. */
  readonly state: {
    readonly societies: Map<string, Society>;
    readonly memberships: SocietyMembership[];
    readonly calls: string[];
  };
  /** Adds a society and its creator's Admin membership, out of band. */
  seed(overrides?: Partial<Society> & { readonly ownerId?: UserId }): {
    readonly society: Society;
    readonly membership: SocietyMembership;
  };
}

const systemClock: Clock = {
  now: () => new Date(),
  nowIso: () => new Date().toISOString(),
};

export function createFakeSocietyRepository(
  options: FakeSocietyRepositoryOptions = {},
): FakeSocietyRepository {
  const clock = options.clock ?? systemClock;
  const nextJoinCode = joinCodeSequence();

  const societies = new Map<string, Society>();
  const memberships: SocietyMembership[] = [];
  const calls: string[] = [];

  for (const society of options.societies ?? []) {
    societies.set(society.id, society);
  }
  for (const membership of options.memberships ?? []) {
    memberships.push(membership);
  }

  const liveMembershipsOf = (societyId: string): readonly SocietyMembership[] =>
    memberships.filter(
      (m) => m.societyId === societyId && m.status !== "removed",
    );

  const memberCount = (societyId: string): number =>
    liveMembershipsOf(societyId).length;

  const findMine = (
    societyId: string,
    actor: UserId,
  ): SocietyMembership | undefined =>
    memberships.find(
      (m) =>
        m.societyId === societyId &&
        m.userId === actor &&
        m.status !== "removed",
    );

  const withCount = (society: Society): Society => ({
    ...society,
    memberCount: memberCount(society.id),
  });

  /** Mirrors the adapter's `not_found` for a caller who is not a member. */
  const requireMine = (
    societyId: SocietyId,
    actor: UserId,
  ): SocietyMembership => {
    const mine = findMine(societyId, actor);
    if (mine === undefined) {
      throw new SocietyError(
        "not_found",
        "That society is not available to you.",
      );
    }
    return mine;
  };

  function seed(
    overrides: Partial<Society> & { readonly ownerId?: UserId } = {},
  ): { readonly society: Society; readonly membership: SocietyMembership } {
    const { ownerId, ...societyOverrides } = overrides;
    const owner = ownerId ?? asUserId(randomUUID());
    const id = asSocietyId(randomUUID());
    const now = clock.now().toISOString();

    const society: Society = {
      id,
      name: "Green Meadows",
      slug: "green-meadows",
      type: "apartment",
      registrationNumber: null,
      addressLine1: "1 MG Road",
      addressLine2: null,
      city: "Pune",
      state: "MH",
      pincode: "411001",
      country: "IN",
      currency: "INR",
      timezone: "Asia/Kolkata",
      joinCode: nextJoinCode(),
      joinCodeExpiresAt: null,
      plan: "free",
      createdBy: owner,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      settings: { ...DEFAULT_SOCIETY_SETTINGS, timezone: "Asia/Kolkata" },
      memberCount: 0,
      ...societyOverrides,
    };
    societies.set(society.id, society);

    const membership: SocietyMembership = {
      id: asMemberId(randomUUID()),
      societyId: society.id,
      userId: owner,
      role: "admin",
      status: "active",
      occupancyType: "owner",
      joinedAt: now,
    };
    memberships.push(membership);

    return { society, membership };
  }

  return {
    state: { societies, memberships, calls },
    seed,

    async listMemberships(actor) {
      calls.push("listMemberships");
      return memberships
        .filter((m) => m.userId === actor && m.status !== "removed")
        .sort((a, b) => (a.joinedAt ?? "").localeCompare(b.joinedAt ?? ""));
    },

    async listSocietyMemberships(societyId, actor) {
      calls.push("listSocietyMemberships");
      // Throws rather than returning an empty list: an empty roster would
      // confirm the society exists to someone who is not a member of it.
      requireMine(societyId, actor);
      return memberships.filter((m) => m.societyId === societyId);
    },

    async findById(id, actor) {
      calls.push("findById");
      const society = societies.get(id);
      if (society === undefined || society.deletedAt !== null) return null;
      if (findMine(id, actor) === undefined) return null;
      return withCount(society);
    },

    async findJoinPreview(rawCode) {
      calls.push("findJoinPreview");
      const code = rawCode.trim().toUpperCase();
      if (code.length === 0) return null;
      for (const society of societies.values()) {
        if (society.joinCode === code && society.deletedAt === null) {
          const preview: SocietyJoinPreview = {
            id: society.id,
            name: society.name,
            city: society.city,
            state: society.state,
            type: society.type,
            memberCount: memberCount(society.id),
            joinCodeExpiresAt: society.joinCodeExpiresAt,
          };
          return preview;
        }
      }
      return null;
    },

    async create(input: CreateSocietyInput, actor) {
      calls.push("create");
      const now = clock.now().toISOString();
      const id = asSocietyId(randomUUID());
      const name = input.name;

      const society: Society = {
        id,
        name,
        slug: slugify(name),
        type: input.type,
        registrationNumber: input.registrationNumber ?? null,
        addressLine1: input.addressLine1 ?? null,
        addressLine2: input.addressLine2 ?? null,
        city: input.city,
        state: input.state,
        pincode: input.pincode ?? null,
        country: "IN",
        currency: "INR",
        timezone: DEFAULT_SOCIETY_SETTINGS.timezone,
        joinCode: nextJoinCode(),
        joinCodeExpiresAt: null,
        plan: "free",
        createdBy: actor,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        settings: {
          ...DEFAULT_SOCIETY_SETTINGS,
          billingDay: input.billingDay,
          dueDay: input.dueDay,
          approvalThresholdPaise: input.approvalThresholdPaise,
        },
        memberCount: 1,
      };
      societies.set(id, society);

      const membership: SocietyMembership = {
        id: asMemberId(randomUUID()),
        societyId: id,
        userId: actor,
        role: "admin",
        status: "active",
        occupancyType: "owner",
        joinedAt: now,
      };
      memberships.push(membership);

      return { society, membership };
    },

    async update(id, input: UpdateSocietyInput, actor) {
      calls.push("update");
      requireMine(id, actor);
      const current = societies.get(id);
      if (current === undefined) {
        throw new SocietyError(
          "not_found",
          "That society is not available to you.",
        );
      }

      // Key presence is the signal: a key present with `undefined` is a clear
      // (the use case normalises it deliberately), so it must not be skipped as
      // "not sent".
      const next: Society = {
        ...current,
        name: input.name ?? current.name,
        type: input.type ?? current.type,
        registrationNumber:
          "registrationNumber" in input
            ? (input.registrationNumber ?? null)
            : current.registrationNumber,
        addressLine1:
          "addressLine1" in input
            ? (input.addressLine1 ?? null)
            : current.addressLine1,
        addressLine2:
          "addressLine2" in input
            ? (input.addressLine2 ?? null)
            : current.addressLine2,
        city: input.city ?? current.city,
        state: input.state ?? current.state,
        pincode: "pincode" in input ? (input.pincode ?? null) : current.pincode,
        updatedAt: clock.now().toISOString(),
        settings: {
          ...current.settings,
          billingDay: input.billingDay ?? current.settings.billingDay,
          dueDay: input.dueDay ?? current.settings.dueDay,
          approvalThresholdPaise:
            input.approvalThresholdPaise ??
            current.settings.approvalThresholdPaise,
        },
      };
      societies.set(id, next);

      return withCount(next);
    },

    async regenerateJoinCode(id, actor) {
      calls.push("regenerateJoinCode");
      requireMine(id, actor);
      const current = societies.get(id);
      if (current === undefined) {
        throw new SocietyError(
          "not_found",
          "That society is not available to you.",
        );
      }
      const next: Society = {
        ...current,
        joinCode: nextJoinCode(),
        updatedAt: clock.now().toISOString(),
      };
      societies.set(id, next);
      return withCount(next);
    },

    async remove(id, actor) {
      calls.push("remove");
      requireMine(id, actor);
      const current = societies.get(id);
      if (current === undefined) {
        throw new SocietyError(
          "not_found",
          "That society is not available to you.",
        );
      }
      societies.set(id, {
        ...current,
        deletedAt: clock.now().toISOString(),
        updatedAt: clock.now().toISOString(),
      });
      // Every membership is marked removed in the same transaction, and the
      // society disappears from every read path.
      for (const membership of memberships.filter((m) => m.societyId === id)) {
        memberships[memberships.indexOf(membership)] = {
          ...membership,
          status: "removed",
        };
      }
    },

    async join(input: JoinSocietyInput, actor) {
      calls.push("join");
      const code = input.code.trim().toUpperCase();
      const society = [...societies.values()].find(
        (candidate) =>
          candidate.joinCode === code && candidate.deletedAt === null,
      );
      if (society === undefined) {
        throw new SocietyError(
          "join_code_invalid",
          "That join code does not match any society.",
        );
      }

      const existing = memberships.find(
        (m) => m.societyId === society.id && m.userId === actor,
      );
      if (existing !== undefined && existing.status !== "removed") {
        throw new SocietyError(
          "already_member",
          "You are already a member of this society.",
        );
      }

      const membership: SocietyMembership = {
        id: existing?.id ?? asMemberId(randomUUID()),
        societyId: society.id,
        userId: actor,
        // Never auto-approved (PRD §3.2).
        role: "resident",
        status: "pending",
        occupancyType: input.occupancyType,
        joinedAt: existing?.joinedAt ?? null,
      };

      if (existing === undefined) {
        memberships.push(membership);
      } else {
        memberships[memberships.indexOf(existing)] = membership;
      }
      return membership;
    },

    async leave(id, actor) {
      calls.push("leave");
      const mine = findMine(id, actor);
      if (mine === undefined) {
        throw new SocietyError(
          "not_found",
          "That society is not available to you.",
        );
      }
      memberships[memberships.indexOf(mine)] = {
        ...mine,
        status: "removed",
      };
    },
  };
}
