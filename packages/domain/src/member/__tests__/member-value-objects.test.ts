import type { Result } from "../../shared/result";
import type { MemberError } from "../errors";
import {
  createDisplayName,
  createEmail,
  createLeaseWindow,
  createMemberOccupancy,
  createPhone,
  createPrimaryClaim,
} from "../member-value-objects";

/**
 * The member module's invariants, tested against the *messages and fields* the form
 * receives rather than against `ok === false`.
 *
 * That choice is deliberate and is the same one the apartment value-object tests make:
 * the value here is not "a bad phone is refused", it is "a bad phone is refused **on the
 * phone field**", because a failure that cannot be attached to an input is a banner the
 * user cannot act on. A test that only asserted the failure would pass with the field
 * missing.
 */

/** The value, or a test failure — so no assertion has to read `.ok` inline. */
function valueOf<TValue>(result: Result<TValue, MemberError>): TValue {
  if (!result.ok) {
    throw new Error(
      `Expected a value, got ${result.error.code}: ${result.error.message}`,
    );
  }
  return result.value;
}

/** The error a value object returned, or a failure that names what happened instead. */
function errorOf<TValue>(result: Result<TValue, MemberError>): MemberError {
  if (result.ok) throw new Error("Expected a failure, got a value.");
  return result.error;
}

describe("createDisplayName", () => {
  it("collapses whitespace but preserves case", () => {
    expect(valueOf(createDisplayName("  Meera   Krishnan "))).toBe(
      "Meera Krishnan",
    );
  });

  it("refuses a blank name on the name field", () => {
    const error = errorOf(createDisplayName("   "));
    expect(error.code).toBe("validation");
    expect(error.details?.field).toBe("displayName");
  });

  it("refuses a name past the column width", () => {
    const error = errorOf(createDisplayName("a".repeat(121)));
    expect(error.code).toBe("validation");
    expect(error.details?.field).toBe("displayName");
  });

  it("does not police uniqueness — two neighbours may share a name", () => {
    // A uniqueness rule here would be one the database does not have and could not
    // want: `members` has no unique index on the name, and two residents called
    // "A. Sharma" are two people.
    expect(valueOf(createDisplayName("A. Sharma"))).toBe("A. Sharma");
    expect(valueOf(createDisplayName("A. Sharma"))).toBe("A. Sharma");
  });
});

describe("createPhone", () => {
  it("turns a bare ten-digit mobile into E.164 with +91", () => {
    expect(valueOf(createPhone("98765 43210"))).toBe("+919876543210");
  });

  it("strips the domestic trunk zero", () => {
    expect(valueOf(createPhone("09876543210"))).toBe("+919876543210");
  });

  it("accepts a country code written without the plus", () => {
    expect(valueOf(createPhone("919876543210"))).toBe("+919876543210");
  });

  it("takes an explicit country code at its word", () => {
    // An NRI owner is a real member of an Indian society. Rewriting +971 to +91 would
    // silently mis-dial them, which is why the plus is authoritative.
    expect(valueOf(createPhone("+971 50 123 4567"))).toBe("+971501234567");
  });

  it("treats empty and absent as 'no number on file'", () => {
    expect(valueOf(createPhone(""))).toBe(null);
    expect(valueOf(createPhone(null))).toBe(null);
    expect(valueOf(createPhone(undefined))).toBe(null);
  });

  it("refuses a number whose country code it would have to guess", () => {
    const error = errorOf(createPhone("12345"));
    expect(error.code).toBe("validation");
    expect(error.details?.field).toBe("phone");
  });

  it("refuses letters rather than salvaging digits from them", () => {
    // `"call me on 98765"` would otherwise become a number nobody can dial.
    const error = errorOf(createPhone("98765-abc"));
    expect(error.details?.field).toBe("phone");
  });

  it("fits the column: the longest legal value is 16 characters", () => {
    const value = valueOf(createPhone("+919876543210"));
    expect(value).not.toBeNull();
    expect((value ?? "").length).toBeLessThanOrEqual(16);
  });
});

describe("createEmail", () => {
  it("lower-cases so one address is one member", () => {
    expect(valueOf(createEmail("  Meera@Example.COM "))).toBe(
      "meera@example.com",
    );
  });

  it("treats empty as absent", () => {
    expect(valueOf(createEmail(""))).toBe(null);
    expect(valueOf(createEmail(null))).toBe(null);
  });

  it("refuses an address with no domain on the email field", () => {
    const error = errorOf(createEmail("meera@localhost"));
    expect(error.code).toBe("validation");
    expect(error.details?.field).toBe("email");
  });
});

describe("createMemberOccupancy", () => {
  it("defaults to owner_occupied, the column default", () => {
    expect(valueOf(createMemberOccupancy(undefined))).toBe("owner_occupied");
  });

  it("accepts vacant_owner, which the join flow cannot declare", () => {
    // PRD §3.3 needs it: an owner living elsewhere is charged differently and gets
    // different notices, so the state has to survive storage.
    expect(valueOf(createMemberOccupancy("vacant_owner"))).toBe("vacant_owner");
  });

  it("refuses the join flow's spelling of the same thing", () => {
    // `owner` is the join *declaration*; the stored enum is `owner_occupied`. Accepting
    // both would put a value in the column the enum cannot hold, or store a second
    // spelling of one state.
    const error = errorOf(createMemberOccupancy("owner"));
    expect(error.details?.field).toBe("occupancy");
  });
});

describe("createLeaseWindow", () => {
  it("accepts both ends absent — most owners have no lease", () => {
    expect(createLeaseWindow(null, null).ok).toBe(true);
    expect(createLeaseWindow(undefined, undefined).ok).toBe(true);
  });

  it("accepts a start with no end — a rolling tenancy", () => {
    expect(createLeaseWindow("2026-01-01", null).ok).toBe(true);
  });

  it("refuses an end before the start, on the end field", () => {
    const error = errorOf(createLeaseWindow("2026-06-01", "2026-01-01"));
    expect(error.code).toBe("validation");
    expect(error.details?.field).toBe("leaseEnd");
  });

  it("refuses a non-date on the field that carried it", () => {
    const error = errorOf(createLeaseWindow("next month", null));
    expect(error.details?.field).toBe("leaseStart");
  });

  it("accepts the same day at both ends", () => {
    expect(createLeaseWindow("2026-01-01", "2026-01-01").ok).toBe(true);
  });
});

describe("createPrimaryClaim", () => {
  it("is satisfied when the flag is off, whatever else is true", () => {
    expect(createPrimaryClaim(false, "family_member", null).ok).toBe(true);
  });

  it("requires a flat", () => {
    const error = errorOf(createPrimaryClaim(true, "owner_occupied", null));
    expect(error.code).toBe("validation");
    expect(error.details?.field).toBe("apartmentId");
  });

  it("refuses a family member as the primary occupant", () => {
    const error = errorOf(
      createPrimaryClaim(true, "family_member", "flat-uuid"),
    );
    expect(error.details?.field).toBe("occupancy");
  });

  it("allows a vacant owner to hold the claim — they are still the owner", () => {
    expect(createPrimaryClaim(true, "vacant_owner", "flat-uuid").ok).toBe(true);
  });
});
