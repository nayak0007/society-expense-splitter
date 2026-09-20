import { paise, type Paise } from "../shared/money";
import { err, ok, type Result } from "../shared/result";

import { SocietyError, societyError } from "./errors";
import { isValidJoinCode, normalizeJoinCode } from "./join-code";
import { DEFAULT_SOCIETY_SETTINGS, slugify } from "./rules";
import type { OccupancyType, SocietySettings } from "./society";
import { OCCUPANCY_TYPES } from "./society";

/**
 * Society value objects — the *invariants* of the domain, in one place.
 *
 * Everything here is a total function of its arguments: no I/O, no clock, no
 * framework. Each returns a `Result`, never throws, so a use case can hand the
 * failure straight back to the caller with the offending field named
 * (`details.field`), which is what turns into a form error at the edge.
 *
 * The rules deliberately mirror the database constraints in
 * `supabase/migrations/` and `packages/db-schema`: the database is the last line
 * of defence, these are the first, and both must agree — a value the client
 * accepts and the database rejects surfaces as a crash at 2am, not a field error.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Name
// ─────────────────────────────────────────────────────────────────────────────

export const SOCIETY_NAME_MIN_LENGTH = 3;
export const SOCIETY_NAME_MAX_LENGTH = 160;

export interface SocietyName {
  /** Normalised: trimmed, internal whitespace collapsed. */
  readonly value: string;
  /** Derived once, here, so every writer agrees on the slug. */
  readonly slug: string;
}

/**
 * Normalises and validates a society name.
 *
 * PRD §3.2 step 1 asks for a name and a unique slug; deriving the slug inside
 * the value object means the API, an import script and a test all produce the
 * same slug for the same input — there is no second implementation to drift.
 */
export function createSocietyName(
  raw: string,
): Result<SocietyName, SocietyError> {
  // Collapse runs of whitespace: "Green  Valley\nResidency" is one name.
  const value = raw.trim().replace(/\s+/g, " ");

  if (value.length < SOCIETY_NAME_MIN_LENGTH) {
    return err(
      societyError(
        "validation",
        "Society name must be at least 3 characters.",
        {
          field: "name",
        },
      ),
    );
  }
  if (value.length > SOCIETY_NAME_MAX_LENGTH) {
    return err(
      societyError(
        "validation",
        "Society name must be at most 160 characters.",
        {
          field: "name",
        },
      ),
    );
  }
  // Control characters mean pasted junk, not a name.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return err(
      societyError(
        "validation",
        "Society name contains characters that are not allowed.",
        {
          field: "name",
        },
      ),
    );
  }
  // The Devanagari range contains combining marks, which the rule reads as a
  // misleading class; here the range is exactly the intent (letters, not digits).
  // eslint-disable-next-line no-misleading-character-class
  if (!/[A-Za-z\u0900-\u097F]/.test(value)) {
    return err(
      societyError("validation", "Society name must contain letters.", {
        field: "name",
      }),
    );
  }

  const slug = slugify(value);
  if (slug.length === 0) {
    return err(
      societyError(
        "validation",
        "Society name must contain at least one letter or digit.",
        {
          field: "name",
        },
      ),
    );
  }

  return ok({ value, slug });
}

// ─────────────────────────────────────────────────────────────────────────────
// Address
// ─────────────────────────────────────────────────────────────────────────────

export const ADDRESS_LINE_MAX_LENGTH = 200;
export const CITY_MAX_LENGTH = 80;
export const STATE_MAX_LENGTH = 80;

export interface SocietyAddress {
  readonly line1: string | null;
  readonly line2: string | null;
  readonly city: string;
  readonly state: string;
  readonly pincode: string | null;
  readonly country: "IN";
}

export interface SocietyAddressInput {
  readonly line1?: string | undefined;
  readonly line2?: string | undefined;
  readonly city: string;
  readonly state: string;
  readonly pincode?: string | undefined;
}

/**
 * City and state are required (they drive the join-by-search path, PRD §3.2);
 * address lines are optional because a small society often only knows its name
 * when it starts. The PIN code is optional but, when present, must be a valid
 * Indian PIN — a wrong PIN produces wrong map results and wrong postcode data.
 */
export function createSocietyAddress(
  input: SocietyAddressInput,
): Result<SocietyAddress, SocietyError> {
  const city = input.city.trim();
  const state = input.state.trim();

  if (city.length < 2 || city.length > CITY_MAX_LENGTH) {
    return err(
      societyError("validation", "Enter the city.", { field: "city" }),
    );
  }
  if (state.length < 2 || state.length > STATE_MAX_LENGTH) {
    return err(
      societyError("validation", "Enter the state.", { field: "state" }),
    );
  }

  const line1 = normalizeOptional(input.line1);
  const line2 = normalizeOptional(input.line2);
  if (line1 !== null && line1.length > ADDRESS_LINE_MAX_LENGTH) {
    return err(
      societyError("validation", "Address line is too long.", {
        field: "addressLine1",
      }),
    );
  }
  if (line2 !== null && line2.length > ADDRESS_LINE_MAX_LENGTH) {
    return err(
      societyError("validation", "Address line is too long.", {
        field: "addressLine2",
      }),
    );
  }

  const pincodeRaw = normalizeOptional(input.pincode);
  if (pincodeRaw !== null && !/^[1-9][0-9]{5}$/.test(pincodeRaw)) {
    return err(
      societyError("validation", "Enter a 6-digit PIN code.", {
        field: "pincode",
      }),
    );
  }

  return ok({ line1, line2, city, state, pincode: pincodeRaw, country: "IN" });
}

function normalizeOptional(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings
// ─────────────────────────────────────────────────────────────────────────────

/** Days 29–31 do not exist in February; the PRD caps billing days at 28. */
export const BILLING_DAY_MIN = 1;
export const BILLING_DAY_MAX = 28;
export const GRACE_DAYS_MAX = 30;

export interface SocietySettingsInput {
  readonly billingDay?: number | undefined;
  readonly dueDay?: number | undefined;
  readonly graceDays?: number | undefined;
  readonly approvalThresholdPaise?: number | Paise | undefined;
  readonly billVacantFlats?: boolean | undefined;
  readonly allowPartialPayments?: boolean | undefined;
  readonly defaulterListPublic?: boolean | undefined;
  readonly financialYearStartMonth?: number | undefined;
  readonly timezone?: string | undefined;
  readonly currency?: "INR" | undefined;
}

/**
 * Builds (or patches) the `society_settings` row.
 *
 * NOTE on a rule that is deliberately absent: due day may precede the billing
 * day. Societies genuinely do both — bill on the 1st and collect by the 10th, or
 * bill late in the month for the following one. Enforcing `dueDay >= billingDay`
 * would reject a legitimate configuration, so the constraint is on each field's
 * own range instead.
 */
export function createSocietySettings(
  input: SocietySettingsInput = {},
): Result<SocietySettings, SocietyError> {
  const billingDay = input.billingDay ?? DEFAULT_SOCIETY_SETTINGS.billingDay;
  const dueDay = input.dueDay ?? DEFAULT_SOCIETY_SETTINGS.dueDay;
  const graceDays = input.graceDays ?? DEFAULT_SOCIETY_SETTINGS.graceDays;
  const financialYearStartMonth =
    input.financialYearStartMonth ??
    DEFAULT_SOCIETY_SETTINGS.financialYearStartMonth;

  const dayCheck = validateDay(billingDay, "billingDay");
  if (!dayCheck.ok) return dayCheck;
  const dueCheck = validateDay(dueDay, "dueDay");
  if (!dueCheck.ok) return dueCheck;

  if (
    !Number.isInteger(graceDays) ||
    graceDays < 0 ||
    graceDays > GRACE_DAYS_MAX
  ) {
    return err(
      societyError(
        "validation",
        `Grace days must be between 0 and ${GRACE_DAYS_MAX}.`,
        {
          field: "graceDays",
        },
      ),
    );
  }
  if (
    !Number.isInteger(financialYearStartMonth) ||
    financialYearStartMonth < 1 ||
    financialYearStartMonth > 12
  ) {
    return err(
      societyError(
        "validation",
        "Financial year start month must be between 1 and 12.",
        {
          field: "financialYearStartMonth",
        },
      ),
    );
  }

  const threshold = toThresholdPaise(input.approvalThresholdPaise);
  if (!threshold.ok) return threshold;

  const timezone = (input.timezone ?? DEFAULT_SOCIETY_SETTINGS.timezone).trim();
  if (timezone.length === 0) {
    return err(
      societyError("validation", "Timezone is required.", {
        field: "timezone",
      }),
    );
  }

  return ok({
    billingDay,
    dueDay,
    graceDays,
    approvalThresholdPaise: threshold.value,
    billVacantFlats:
      input.billVacantFlats ?? DEFAULT_SOCIETY_SETTINGS.billVacantFlats,
    allowPartialPayments:
      input.allowPartialPayments ??
      DEFAULT_SOCIETY_SETTINGS.allowPartialPayments,
    defaulterListPublic:
      input.defaulterListPublic ?? DEFAULT_SOCIETY_SETTINGS.defaulterListPublic,
    financialYearStartMonth,
    timezone,
    // INR is not a default, it is the only supported currency (PRD §3.2 step 1).
    currency: "INR",
  });
}

export function updateSocietySettings(
  current: SocietySettings,
  patch: SocietySettingsInput,
): Result<SocietySettings, SocietyError> {
  return createSocietySettings({ ...current, ...stripUndefined(patch) });
}

function validateDay(
  value: number,
  field: string,
): Result<number, SocietyError> {
  if (
    !Number.isInteger(value) ||
    value < BILLING_DAY_MIN ||
    value > BILLING_DAY_MAX
  ) {
    return err(
      societyError(
        "validation",
        `${field === "billingDay" ? "Billing" : "Due"} day must be between ${BILLING_DAY_MIN} and ${BILLING_DAY_MAX}.`,
        { field },
      ),
    );
  }
  return ok(value);
}

function toThresholdPaise(
  value: number | Paise | undefined,
): Result<Paise, SocietyError> {
  const amount = value ?? DEFAULT_SOCIETY_SETTINGS.approvalThresholdPaise;
  if (
    typeof amount !== "number" ||
    !Number.isSafeInteger(amount) ||
    amount < 0
  ) {
    return err(
      societyError(
        "validation",
        "Approval threshold must be a whole number of paise.",
        {
          field: "approvalThresholdPaise",
        },
      ),
    );
  }
  // `paise()` only throws for values just rejected above; the call documents the
  // branding step and keeps every construction of a Paise in one place.
  return ok(paise(amount));
}

function stripUndefined(input: SocietySettingsInput): SocietySettingsInput {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) result[key] = value;
  }
  return result as SocietySettingsInput;
}

// ─────────────────────────────────────────────────────────────────────────────
// Join request
// ─────────────────────────────────────────────────────────────────────────────

export interface SocietyJoinRequest {
  readonly code: string;
  readonly occupancyType: OccupancyType;
}

/** Validated join submission: a well-formed code and a known occupancy. */
export function createSocietyJoinRequest(
  rawCode: string,
  occupancyType: OccupancyType,
): Result<SocietyJoinRequest, SocietyError> {
  const code = normalizeJoinCode(rawCode);

  if (!isValidJoinCode(code)) {
    return err(
      societyError(
        "join_code_invalid",
        "A join code is 6 characters (no 0, O, 1 or I).",
        {
          field: "code",
        },
      ),
    );
  }
  if (!OCCUPANCY_TYPES.includes(occupancyType)) {
    return err(
      societyError(
        "validation",
        "Choose whether you own, rent or share this home.",
        {
          field: "occupancyType",
        },
      ),
    );
  }
  return ok({ code, occupancyType });
}
