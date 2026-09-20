import { DEFAULT_SOCIETY_SETTINGS, slugify } from "../rules";
import type { OccupancyType } from "../society";
import {
  ADDRESS_LINE_MAX_LENGTH,
  SOCIETY_NAME_MAX_LENGTH,
  createSocietyAddress,
  createSocietyJoinRequest,
  createSocietyName,
  createSocietySettings,
  updateSocietySettings,
} from "../value-objects";
import { expectErr, expectOk } from "./support/result-expectations";

/**
 * Value objects are where the domain's invariants live, so these tests are the
 * specification of what the API and the database must also refuse. Each
 * rejection asserts on `error.code` **and** `error.details.field`: the code is
 * what the API maps onto HTTP, the field is what turns into an inline form error
 * without the UI having to parse a message string.
 */
describe("createSocietyName", () => {
  it("normalises whitespace and derives the slug", () => {
    const name = expectOk(createSocietyName("  Green   Valley\nResidency  "));

    expect(name.value).toBe("Green Valley Residency");
    expect(name.slug).toBe("green-valley-residency");
  });

  it("accepts a name at each length boundary", () => {
    expect(expectOk(createSocietyName("abc")).value).toBe("abc");
    expect(
      expectOk(createSocietyName("a".repeat(SOCIETY_NAME_MAX_LENGTH))).value,
    ).toHaveLength(SOCIETY_NAME_MAX_LENGTH);
  });

  it("rejects a name shorter than three characters", () => {
    const error = expectErr(createSocietyName("  ab "));

    expect(error.code).toBe("validation");
    expect(error.details).toMatchObject({ field: "name" });
  });

  it("rejects a name past the column limit", () => {
    expect(
      expectErr(createSocietyName("a".repeat(SOCIETY_NAME_MAX_LENGTH + 1)))
        .code,
    ).toBe("validation");
  });

  it("rejects a name with no letters at all", () => {
    const error = expectErr(createSocietyName("12345"));

    expect(error.code).toBe("validation");
    expect(error.message).toContain("letters");
  });

  it("derives the slug from the Latin part of a mixed-script name", () => {
    const name = expectOk(createSocietyName("Green Valley ग्रीन"));

    expect(name.value).toBe("Green Valley ग्रीन");
    expect(name.slug).toBe("green-valley");
  });

  it("documents the current limit on a Devanagari-only name", () => {
    // NOT desired behaviour, deliberately pinned: `slugify` keeps ASCII only, so
    // a Devanagari-only name produces an empty slug and is rejected here — for an
    // India-only product that is a real gap. Whether the slug should keep
    // Devanagari, transliterate, or fall back to a generated key is a product and
    // schema decision that has not been taken yet, so this test records today's
    // behaviour and a change to it will be intentional.
    expect(expectErr(createSocietyName("ग्रीन वैली")).code).toBe("validation");
    expect(slugify("ग्रीन वैली")).toBe("");
  });

  it("rejects control characters", () => {
    expect(expectErr(createSocietyName("Green\u0000Valley")).code).toBe(
      "validation",
    );
  });
});

describe("createSocietyAddress", () => {
  it("requires only the city and the state", () => {
    const address = expectOk(
      createSocietyAddress({ city: " Pune ", state: "Maharashtra" }),
    );

    expect(address).toEqual({
      line1: null,
      line2: null,
      city: "Pune",
      state: "Maharashtra",
      pincode: null,
      country: "IN",
    });
  });

  it("treats blank optional strings as absent", () => {
    const address = expectOk(
      createSocietyAddress({
        city: "Pune",
        state: "MH",
        line1: "   ",
        pincode: "",
      }),
    );

    expect(address.line1).toBeNull();
    expect(address.pincode).toBeNull();
  });

  it("rejects a missing or one-character city", () => {
    for (const city of ["", " P "]) {
      const error = expectErr(
        createSocietyAddress({ city, state: "Maharashtra" }),
      );
      expect(error.code).toBe("validation");
      expect(error.details).toMatchObject({ field: "city" });
    }
  });

  it("rejects a missing state", () => {
    const error = expectErr(
      createSocietyAddress({ city: "Pune", state: "  " }),
    );

    expect(error.code).toBe("validation");
    expect(error.details).toMatchObject({ field: "state" });
  });

  it("accepts a valid Indian PIN code", () => {
    expect(
      expectOk(
        createSocietyAddress({ city: "Pune", state: "MH", pincode: "411045" }),
      ).pincode,
    ).toBe("411045");
  });

  it("rejects a PIN code that cannot exist", () => {
    // A leading zero, a wrong length and letters are all invalid.
    for (const pincode of ["011045", "41104", "4110456", "41104X"]) {
      const error = expectErr(
        createSocietyAddress({ city: "Pune", state: "MH", pincode }),
      );
      expect(error.code).toBe("validation");
      expect(error.details).toMatchObject({ field: "pincode" });
    }
  });

  it("rejects an over-long address line on either line", () => {
    const line1 = expectErr(
      createSocietyAddress({
        city: "Pune",
        state: "MH",
        line1: "x".repeat(ADDRESS_LINE_MAX_LENGTH + 1),
      }),
    );
    const line2 = expectErr(
      createSocietyAddress({
        city: "Pune",
        state: "MH",
        line2: "x".repeat(ADDRESS_LINE_MAX_LENGTH + 1),
      }),
    );

    expect(line1.details).toMatchObject({ field: "addressLine1" });
    expect(line2.details).toMatchObject({ field: "addressLine2" });
  });
});

describe("createSocietySettings", () => {
  it("falls back to the column defaults", () => {
    expect(expectOk(createSocietySettings())).toEqual(DEFAULT_SOCIETY_SETTINGS);
  });

  it("applies a partial patch over the defaults", () => {
    const settings = expectOk(
      createSocietySettings({ billingDay: 5, graceDays: 0 }),
    );

    expect(settings.billingDay).toBe(5);
    expect(settings.graceDays).toBe(0);
    expect(settings.dueDay).toBe(DEFAULT_SOCIETY_SETTINGS.dueDay);
  });

  it("refuses to bill on days February does not have", () => {
    for (const billingDay of [0, 29, 30, 31, -1, 1.5]) {
      const error = expectErr(createSocietySettings({ billingDay }));
      expect(error.code).toBe("validation");
      expect(error.details).toMatchObject({ field: "billingDay" });
    }
  });

  it("rejects an impossible due day and grace period", () => {
    expect(
      expectErr(createSocietySettings({ dueDay: 29 })).details,
    ).toMatchObject({
      field: "dueDay",
    });
    expect(
      expectErr(createSocietySettings({ graceDays: 31 })).details,
    ).toMatchObject({
      field: "graceDays",
    });
  });

  it("allows a due day before the billing day", () => {
    // Deliberate: societies genuinely bill on the 25th and collect by the 5th.
    const settings = expectOk(
      createSocietySettings({ billingDay: 25, dueDay: 5 }),
    );

    expect(settings.billingDay).toBe(25);
    expect(settings.dueDay).toBe(5);
  });

  it("keeps the approval threshold an integer number of paise", () => {
    expect(
      expectOk(createSocietySettings({ approvalThresholdPaise: 500_000 }))
        .approvalThresholdPaise,
    ).toBe(500_000);
    expect(
      expectErr(createSocietySettings({ approvalThresholdPaise: 10.5 }))
        .details,
    ).toMatchObject({
      field: "approvalThresholdPaise",
    });
    expect(
      expectErr(createSocietySettings({ approvalThresholdPaise: -1 })).code,
    ).toBe("validation");
  });

  it("rejects an out-of-range financial year start and a blank timezone", () => {
    expect(
      expectErr(createSocietySettings({ financialYearStartMonth: 13 })).details,
    ).toMatchObject({ field: "financialYearStartMonth" });
    expect(
      expectErr(createSocietySettings({ timezone: "   " })).details,
    ).toMatchObject({
      field: "timezone",
    });
  });

  it("pins the currency to INR regardless of input", () => {
    // Not a default — the only supported currency (PRD §3.2 step 1).
    expect(expectOk(createSocietySettings()).currency).toBe("INR");
  });
});

describe("updateSocietySettings", () => {
  it("changes only the patched field", () => {
    const current = expectOk(
      createSocietySettings({ billingDay: 5, dueDay: 20, graceDays: 7 }),
    );
    const next = expectOk(updateSocietySettings(current, { dueDay: 25 }));

    expect(next.dueDay).toBe(25);
    expect(next.billingDay).toBe(5);
    expect(next.graceDays).toBe(7);
  });

  it("ignores explicitly-undefined keys instead of resetting them", () => {
    const current = expectOk(createSocietySettings({ billingDay: 5 }));
    const next = expectOk(
      updateSocietySettings(current, { billingDay: undefined, dueDay: 15 }),
    );

    expect(next.billingDay).toBe(5);
    expect(next.dueDay).toBe(15);
  });

  it("validates the resulting settings, not just the patch", () => {
    const current = expectOk(createSocietySettings());
    expect(
      expectErr(updateSocietySettings(current, { graceDays: 99 })).code,
    ).toBe("validation");
  });
});

describe("createSocietyJoinRequest", () => {
  it("normalises the code and keeps the occupancy", () => {
    expect(expectOk(createSocietyJoinRequest(" gv4k-2m ", "tenant"))).toEqual({
      code: "GV4K2M",
      occupancyType: "tenant",
    });
  });

  it("rejects a malformed code with the field named", () => {
    const error = expectErr(createSocietyJoinRequest("GV0K2M", "owner"));

    expect(error.code).toBe("join_code_invalid");
    expect(error.details).toMatchObject({ field: "code" });
  });

  it("rejects an unknown occupancy type", () => {
    const error = expectErr(
      createSocietyJoinRequest("GV4K2M", "squatter" as OccupancyType),
    );

    expect(error.code).toBe("validation");
    expect(error.details).toMatchObject({ field: "occupancyType" });
  });
});
