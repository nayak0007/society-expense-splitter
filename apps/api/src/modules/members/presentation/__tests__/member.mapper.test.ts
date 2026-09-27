import {
  MemberError,
  ROLE_ORDER,
  actionsFor,
  roleDefinitions,
} from "@ses/domain";
import type { MemberView } from "@ses/domain";

import { AppError } from "../../../../common/errors/app-error";
import {
  ERROR_CODE_BY_MEMBER_CODE,
  toAppError,
} from "../../application/member-error.mapper";
import {
  memberDetailToDto,
  memberListToDto,
  memberPermissionsToDto,
  memberResponseToDto,
  roleCatalogueToDto,
} from "../member.mapper";

/**
 * The presentation boundary: the domain entity the API renders, and the code the client
 * branches on.
 *
 * Two properties are under test, and neither is provable anywhere else:
 *
 *  - **the output parse.** `memberSchema` rejects a payload whose shape drifted, and the mapper
 *    turns that into an `INTERNAL` with the offending path — so a renamed field is a 500 that
 *    names it rather than a client rendering `undefined`. `contactVisible` has no column behind
 *    it, so it is exactly the kind of derived field a refactor can drop silently.
 *  - **every domain code has an HTTP meaning.** The mapper is a `Record`, so a missing entry
 *    would not compile; the test asserts the *chosen* meanings, including the two a client
 *    actually branches on (`sole_admin` and a validation failure's `field`).
 */

const SHADOW: MemberView = {
  id: "aaaaaaaa-0000-4000-8000-000000000001" as MemberView["id"],
  societyId: "b1f0c8e2-4a7d-4f1e-9b23-6c5d8e9f0a12" as MemberView["societyId"],
  userId: null,
  apartmentId: null,
  apartment: null,
  displayName: "Suresh Menon",
  phone: "+919800000009",
  email: null,
  role: "resident",
  status: "active",
  occupancy: "owner_occupied",
  isPrimary: false,
  leaseStart: null,
  leaseEnd: null,
  shareContact: false,
  joinedAt: "2026-09-25T10:00:00.000Z",
  approvedBy: null,
  removedAt: null,
  removedBy: null,
  requestNote: null,
  rejectionReason: null,
  rejectedAt: null,
  rejectedBy: null,
  createdAt: "2026-09-25T10:00:00.000Z",
  updatedAt: "2026-09-25T10:00:00.000Z",
  contactVisible: true,
};

const CAPABILITIES = {
  canView: true,
  canAdd: true,
  canEdit: true,
  canSuspend: false,
  canRemove: false,
  // T046. `canChangeRoles` is asserted below like every other flag, precisely because it is the
  // one a mapper that was not updated would drop — and a client would then render the role picker
  // as read-only for an Admin.
  canChangeRoles: true,
  // T049, for the same reason: a dropped flag renders the join queue as read-only.
  canApprove: true,
} as const;

describe("memberResponseToDto", () => {
  it("renders every field the contract declares", () => {
    const dto = memberResponseToDto(SHADOW);

    expect(dto.member.id).toBe(SHADOW.id);
    expect(dto.member.userId).toBeNull();
    expect(dto.member.contactVisible).toBe(true);
    expect(dto.member.occupancy).toBe("owner_occupied");
  });

  it("carries the flat label when there is one", () => {
    const dto = memberResponseToDto({
      ...SHADOW,
      apartmentId:
        "cccccccc-0000-4000-8000-000000000001" as MemberView["apartmentId"],
      apartment: {
        id: "cccccccc-0000-4000-8000-000000000001" as never,
        number: "A-101",
        buildingId: "dddddddd-0000-4000-8000-000000000001" as never,
        buildingName: "Block A",
        floor: 1,
      },
    });

    expect(dto.member.apartment?.number).toBe("A-101");
    expect(dto.member.apartment?.buildingName).toBe("Block A");
  });

  it("fails as INTERNAL — naming the path — when a derived field goes missing", () => {
    // The failure mode the parse exists for: `contactVisible` has no column behind it, so
    // without the parse a client would render every withheld contact as "not shared".
    const broken = { ...SHADOW } as Record<string, unknown>;
    delete broken.contactVisible;

    let thrown: unknown;
    try {
      memberResponseToDto(broken as unknown as MemberView);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("INTERNAL");
    expect((thrown as AppError).status).toBe(500);
    expect((thrown as AppError).payload.details?.[0]?.field).toContain(
      "contactVisible",
    );
  });
});

describe("memberDetailToDto", () => {
  it("travels with the caller's capabilities", () => {
    const dto = memberDetailToDto(SHADOW, { ...CAPABILITIES });

    expect(dto.capabilities).toEqual({
      canView: true,
      canAdd: true,
      canEdit: true,
      canSuspend: false,
      canRemove: false,
      canChangeRoles: true,
      canApprove: true,
    });
  });
});

describe("memberListToDto", () => {
  it("echoes the page the request asked for, with the total", () => {
    const dto = memberListToDto({
      members: [SHADOW],
      total: 340,
      limit: 50,
      offset: 100,
      capabilities: { ...CAPABILITIES },
    });

    expect(dto.members).toHaveLength(1);
    expect(dto.total).toBe(340);
    expect(dto.limit).toBe(50);
    expect(dto.offset).toBe(100);
  });

  it("accepts an empty page — a society with one member is a real state", () => {
    const dto = memberListToDto({
      members: [],
      total: 0,
      limit: 50,
      offset: 0,
      capabilities: { ...CAPABILITIES },
    });

    expect(dto.members).toEqual([]);
    expect(dto.total).toBe(0);
  });
});

describe("roleCatalogueToDto", () => {
  it("carries every role's evaluator list and the caller's capabilities", () => {
    const dto = roleCatalogueToDto({
      roles: roleDefinitions(),
      capabilities: { ...CAPABILITIES },
    });

    // The DTO's list is the evaluator's, role for role — a catalogue that restated the matrix
    // would be the fourth copy of it, and the one nobody notices drifting.
    expect(dto.roles.map((definition) => definition.role)).toEqual([
      ...ROLE_ORDER,
    ]);
    for (const definition of dto.roles) {
      expect(definition.permissions).toEqual(actionsFor(definition.role));
    }
    expect(dto.capabilities.canChangeRoles).toBe(true);
  });
});

describe("memberPermissionsToDto", () => {
  it("answers one membership's role with the actions it holds", () => {
    const dto = memberPermissionsToDto({
      memberId: SHADOW.id,
      role: "treasurer",
      permissions: actionsFor("treasurer"),
      capabilities: { ...CAPABILITIES },
    });

    expect(dto.memberId).toBe(SHADOW.id);
    expect(dto.role).toBe("treasurer");
    expect(dto.permissions).toEqual(actionsFor("treasurer"));
  });

  it("parses the role write's own response — the same shape, from the stored row", () => {
    // The role routes answer with this mapper, so an empty action list for a suspended member is
    // representable: `permissions: []` is a fact about a membership, not a contract violation.
    const dto = memberPermissionsToDto({
      memberId: SHADOW.id,
      role: "guest",
      permissions: [],
      capabilities: { ...CAPABILITIES },
    });

    expect(dto.permissions).toEqual([]);
  });
});

describe("toAppError", () => {
  it("maps every domain code onto the catalogue", () => {
    for (const [domainCode, httpCode] of Object.entries(
      ERROR_CODE_BY_MEMBER_CODE,
    )) {
      const error = toAppError(new MemberError(domainCode as never, "Nope."));
      expect(error.code).toBe(httpCode);
    }
  });

  it("keeps a validation failure on the field the user typed in", () => {
    const error = toAppError(
      new MemberError("validation", "Enter a valid phone number.", {
        field: "phone",
      }),
    );

    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.status).toBe(422);
    expect(error.payload.field).toBe("phone");
  });

  it("reports the last-admin refusal as SOCIETY_ADMIN_REQUIRED with a SOLE_ADMIN detail", () => {
    // The same code the society module returns when the last Admin tries to leave, so a client
    // needs one case rather than two.
    const error = toAppError(
      new MemberError(
        "sole_admin",
        "A society needs at least one active Admin.",
      ),
    );

    expect(error.code).toBe("SOCIETY_ADMIN_REQUIRED");
    expect(error.status).toBe(403);
    expect(error.payload.details?.[0]?.code).toBe("SOLE_ADMIN");
  });

  it("reports a role cap as a conflict with a ROLE_CAP_EXCEEDED detail", () => {
    // A cap is not a bad value — the request was well formed and the population is what refuses
    // it — so it is a 409 whose detail code lets a picker say which cap and for which role.
    const error = toAppError(
      new MemberError(
        "role_cap_exceeded",
        "A society can have at most 2 treasurers.",
        {
          field: "role",
        },
      ),
    );

    expect(error.code).toBe("CONFLICT");
    expect(error.status).toBe(409);
    expect(error.payload.field).toBe("role");
    expect(error.payload.details?.[0]?.code).toBe("ROLE_CAP_EXCEEDED");
  });

  it("does not invent a field when the domain named none", () => {
    // Unlike the structure module there is no default here, because this module has several
    // field-less conflicts that belong to different inputs: a default would move a
    // duplicate-phone error onto the name box.
    const error = toAppError(
      new MemberError("conflict", "That change conflicts."),
    );

    expect(error.payload.field).toBeUndefined();
  });

  it("answers INTERNAL for an adapter failure it cannot place", () => {
    const error = toAppError(
      new MemberError("unknown", "Something went wrong.", { code: "08006" }),
    );

    expect(error.status).toBe(500);
  });
});
