import {
  createdSocietyResponseSchema,
  joinPreviewResponseSchema,
  membershipResponseSchema,
  societyProfileResponseSchema,
  societyResponseSchema,
  societySummarySchema,
} from "@ses/contracts";
import {
  asMemberId,
  asSocietyId,
  asUserId,
  evaluateSocietyCapabilities,
} from "@ses/domain";
import type {
  Society,
  SocietyJoinPreview,
  SocietyMembership,
  SocietySummary,
} from "@ses/domain";

import {
  capabilitiesToDto,
  createdSocietyToDto,
  joinPreviewToDto,
  membershipResponseToDto,
  profileToDto,
  societyToDto,
  summaryToDto,
} from "../society.mapper";

/**
 * The domain → wire boundary.
 *
 * The claim under test is that every mapper **parses** rather than constructs —
 * so a domain rename or a `null` becoming `undefined` fails here, loudly, at the
 * moment the field moves, instead of shipping a payload the mobile client cannot
 * parse on one screen in production. Each mapping is therefore asserted by
 * running the same contract schema the client runs.
 */

const SOCIETY: Society = {
  id: asSocietyId("11111111-1111-4111-8111-111111111111"),
  name: "Green Meadows",
  slug: "green-meadows",
  type: "apartment",
  registrationNumber: "REG-2026-1",
  addressLine1: "1 MG Road",
  addressLine2: null,
  city: "Pune",
  state: "MH",
  pincode: "411001",
  country: "IN",
  currency: "INR",
  timezone: "Asia/Kolkata",
  joinCode: "ABC123",
  joinCodeExpiresAt: "2026-10-01T00:00:00.000Z",
  plan: "free",
  createdBy: asUserId("22222222-2222-4222-8222-222222222222"),
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  deletedAt: null,
  settings: {
    billingDay: 1,
    dueDay: 10,
    graceDays: 5,
    approvalThresholdPaise: 1_000_000,
    billVacantFlats: false,
    allowPartialPayments: true,
    defaulterListPublic: false,
    financialYearStartMonth: 4,
    timezone: "Asia/Kolkata",
    currency: "INR",
  },
  memberCount: 12,
};

const MEMBERSHIP: SocietyMembership = {
  id: asMemberId("33333333-3333-4333-8333-333333333333"),
  societyId: SOCIETY.id,
  userId: asUserId("22222222-2222-4222-8222-222222222222"),
  role: "admin",
  status: "active",
  occupancyType: "owner",
  joinedAt: "2026-09-01T00:00:00.000Z",
};

const SUMMARY: SocietySummary = {
  id: SOCIETY.id,
  name: SOCIETY.name,
  city: SOCIETY.city,
  type: SOCIETY.type,
  role: "admin",
  status: "active",
  memberCount: 12,
};

const PREVIEW: SocietyJoinPreview = {
  id: SOCIETY.id,
  name: SOCIETY.name,
  city: SOCIETY.city,
  state: SOCIETY.state,
  type: SOCIETY.type,
  memberCount: 12,
  joinCodeExpiresAt: null,
};

describe("societyToDto", () => {
  it("satisfies the contract's own society schema", () => {
    expect(
      societyResponseSchema.parse({ society: societyToDto(SOCIETY) }),
    ).toBeDefined();
  });

  it("carries settings, because the client renders billing days without a second call", () => {
    const dto = societyToDto(SOCIETY);

    expect(dto.settings.billingDay).toBe(1);
    expect(dto.settings.currency).toBe("INR");
    expect(dto.memberCount).toBe(12);
  });

  it("enumerates fields rather than spreading the entity", () => {
    // A spread would forward any field the domain grows — including ones the
    // contract does not define — making the boundary meaningless the first time
    // someone adds an internal flag to `Society`.
    const widened = {
      ...SOCIETY,
      internalRiskScore: 42,
    } as unknown as Society;

    expect(societyToDto(widened)).not.toHaveProperty("internalRiskScore");
  });

  it("fails loudly when the domain stops satisfying the contract", () => {
    // The whole point of parsing: a raw `construct` would emit this payload and
    // the failure would appear on a screen, in production, as an unparseable
    // response.
    const broken = { ...SOCIETY, createdAt: undefined } as unknown as Society;

    expect(() => societyToDto(broken)).toThrow();
  });
});

describe("membershipToDto / capabilitiesToDto", () => {
  it("satisfies the profile contract for a real capability evaluation", () => {
    const capabilities = evaluateSocietyCapabilities(MEMBERSHIP, [MEMBERSHIP]);

    const profile = profileToDto(SOCIETY, MEMBERSHIP, capabilities);

    expect(societyProfileResponseSchema.safeParse(profile).success).toBe(true);
    // Derived, never re-derived by the screen: this is what stops a client and
    // a server disagreeing about who is an Admin.
    expect(profile.capabilities.canManage).toBe(true);
  });

  it("reports no capabilities for a caller with no membership", () => {
    const capabilities = evaluateSocietyCapabilities(null, []);

    expect(capabilitiesToDto(capabilities)).toEqual({
      canManage: false,
      canDelete: false,
      canRegenerateJoinCode: false,
      canViewJoinCode: false,
      canLeave: false,
    });
  });
});

describe("summaryToDto", () => {
  it("satisfies the switcher's schema", () => {
    expect(societySummarySchema.safeParse(summaryToDto(SUMMARY)).success).toBe(
      true,
    );
  });

  it("carries the caller's own role and status, which is the point of a summary", () => {
    const dto = summaryToDto({ ...SUMMARY, role: "tenant", status: "pending" });

    expect(dto.role).toBe("tenant");
    expect(dto.status).toBe("pending");
  });
});

describe("joinPreviewToDto", () => {
  it("satisfies the public lookup schema", () => {
    const dto = joinPreviewToDto(PREVIEW);

    expect(joinPreviewResponseSchema.safeParse({ preview: dto }).success).toBe(
      true,
    );
  });

  it("exposes only the fields the SQL function is allowed to return", () => {
    // The bound on the public endpoint's exposure: name, city, state, type and
    // member count. Never the join code itself, never members, never settings.
    expect(Object.keys(joinPreviewToDto(PREVIEW)).sort()).toEqual([
      "city",
      "id",
      "memberCount",
      "name",
      "state",
      "type",
    ]);
  });
});

describe("createdSocietyToDto / membershipResponseToDto", () => {
  it("satisfies the create response, which carries the creator's membership too", () => {
    const dto = createdSocietyToDto(SOCIETY, MEMBERSHIP);

    expect(createdSocietyResponseSchema.safeParse(dto).success).toBe(true);
    expect(dto.membership.role).toBe("admin");
  });

  it("satisfies the join response, whose status drives the pending screen", () => {
    const pending: SocietyMembership = { ...MEMBERSHIP, status: "pending" };

    const dto = membershipResponseToDto(pending);

    expect(membershipResponseSchema.safeParse(dto).success).toBe(true);
    // Never auto-approved (PRD §3.2): the client must be told it is pending
    // rather than infer it from an absence.
    expect(dto.membership.status).toBe("pending");
  });
});
