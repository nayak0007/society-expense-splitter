import { err, ok, type Result } from "../shared/result";

import {
  DEFAULT_MEMBER_OCCUPANCY,
  MEMBER_EMAIL_MAX_LENGTH,
  MEMBER_NAME_MAX_LENGTH,
  MEMBER_OCCUPANCIES,
  MEMBER_PHONE_MAX_LENGTH,
  PRIMARY_OCCUPANCIES,
} from "./member";
import type { MemberOccupancy } from "./member";
import { memberError, type MemberError } from "./errors";

/**
 * Member value objects — the *invariants* of a membership, in one place.
 *
 * Total functions of their arguments returning `Result`, never throwing, for the
 * reasons `structure/value-objects.ts` records: each failure carries
 * `details.field`, which is what becomes a form error at the edge, and each rule
 * mirrors a constraint in
 * `supabase/migrations/20260925120000_members_directory.sql` so a value the client
 * accepts is a value the database accepts.
 *
 * ## Nullability means "clear it", not "skip it"
 *
 * Every optional field here accepts `null` and returns `null`. On the create path
 * `null` and absent are the same thing; on the update path they are not — absent is
 * "leave it alone" and `null` is "clear it" — and the use case decides which by
 * whether it calls the value object at all. Keeping that decision in the use case is
 * what lets these stay total functions with no notion of a patch.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Name
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalises and validates the display name.
 *
 * Whitespace is collapsed because it is pasted junk rather than meaning; case is
 * preserved because ``"Murthy"`` and ``"murthy"`` are the same person but only one
 * of them is how they write their name. Uniqueness is deliberately **not** checked:
 * two residents called "A. Sharma" are two people, and a uniqueness rule here would
 * be a rule the database does not have and could not want.
 */
export function createDisplayName(raw: string): Result<string, MemberError> {
  const value = raw.trim().replace(/\s+/g, " ");

  if (value.length === 0) {
    return err(
      memberError("validation", "Enter a name.", { field: "displayName" }),
    );
  }
  if (value.length > MEMBER_NAME_MAX_LENGTH) {
    return err(
      memberError(
        "validation",
        `Name must be at most ${MEMBER_NAME_MAX_LENGTH} characters.`,
        { field: "displayName" },
      ),
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return err(
      memberError(
        "validation",
        "Name contains characters that are not allowed.",
        {
          field: "displayName",
        },
      ),
    );
  }

  return ok(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Phone
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalises a phone number to E.164 (PRD §3.2/§7, and T048's "Phone normalised to
 * E.164").
 *
 * ## Why normalise at all, and why here
 *
 * A shadow member's phone **is** their identity in the directory: it is what
 * `uq_members_shadow_phone` keys on, what the person will be matched by when they
 * sign up, and what the Admin reads out to call them. Storing `"98765 43210"` for
 * one member and `"+91 98765 43210"` for another makes those two rows two people.
 * One shape, decided once, in the domain.
 *
 * ## The rules, and the product reason for each
 *
 *  - **A `+` is taken at its word.** If the caller wrote a country code, it is used
 *    unchanged: an Indian society may well have an NRI owner, and rewriting
 *    `+971…` to `+91…` would silently mis-dial them.
 *  - **No country code, ten digits → `+91`.** The product is India-only by
 *    construction — `currency` is locked to INR and `country` to IN in the society
 *    record — so the only reading of a bare ten-digit number is an Indian mobile.
 *  - **A single leading `0` is the domestic trunk prefix**, not part of the number.
 *  - **`91` + ten digits is a country code written without the `+`**, which is how
 *    it arrives from a WhatsApp paste.
 *  - Anything else is refused rather than guessed at: the message asks for the
 *    country code, so the user can supply what the function cannot infer.
 *
 * `null` in, `null` out — and an empty string is `null` rather than an error, since
 * "I do not have their number" is a legitimate state for a member whose flat is
 * empty (the column is nullable; only the *direct add* path requires one, and the
 * contract says so).
 */
export function createPhone(
  raw: string | null | undefined,
): Result<string | null, MemberError> {
  if (raw === null || raw === undefined) return ok(null);
  const cleaned = raw.trim().replace(/[\s()\-.]/g, "");
  if (cleaned.length === 0) return ok(null);

  const hasCountryCode = cleaned.startsWith("+");
  const digits = cleaned.replace(/\+/g, "");
  if (!/^\d+$/.test(digits)) {
    return err(
      memberError("validation", "Enter a valid phone number.", {
        field: "phone",
      }),
    );
  }

  let e164: string;
  if (hasCountryCode) {
    e164 = `+${digits}`;
  } else if (digits.length === 10) {
    e164 = `+91${digits}`;
  } else if (digits.length === 11 && digits.startsWith("0")) {
    e164 = `+91${digits.slice(1)}`;
  } else if (digits.length === 12 && digits.startsWith("91")) {
    e164 = `+${digits}`;
  } else {
    return err(
      memberError(
        "validation",
        "Include the country code, for example +91 98765 43210.",
        { field: "phone" },
      ),
    );
  }

  // E.164: `+`, a non-zero country code, and 8–15 digits in total. The column is
  // `varchar(16)` and the longest legal value is 16 characters, so the length test
  // is the column's constraint written where the user can see it.
  if (
    !/^\+[1-9]\d{7,14}$/.test(e164) ||
    e164.length > MEMBER_PHONE_MAX_LENGTH
  ) {
    return err(
      memberError(
        "validation",
        "Include the country code, for example +91 98765 43210.",
        { field: "phone" },
      ),
    );
  }

  return ok(e164);
}

// ─────────────────────────────────────────────────────────────────────────────
// Email
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalises and validates an optional address.
 *
 * Lower-cased, and no more than that: an email's local part is technically
 * case-sensitive and every provider that matters treats it case-insensitively, so
 * the choice is between two imperfect readings — and the one that stops
 * `Meera@Example.com` and `meera@example.com` being two members is the one that
 * matches how the address is actually used (matched against `profiles.email` when a
 * shadow member signs up).
 *
 * The validation is deliberately shallow (one `@`, a dot, no spaces) rather than an
 * RFC 5322 grammar: the only address this app can verify is one it sends mail to,
 * and a regex that rejects a genuinely valid exotic address is a worse failure than
 * one that accepts a typo the user will notice when nothing arrives.
 */
export function createEmail(
  raw: string | null | undefined,
): Result<string | null, MemberError> {
  if (raw === null || raw === undefined) return ok(null);
  const value = raw.trim().toLowerCase();
  if (value.length === 0) return ok(null);

  if (
    value.length > MEMBER_EMAIL_MAX_LENGTH ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)
  ) {
    return err(
      memberError("validation", "Enter a valid email address.", {
        field: "email",
      }),
    );
  }
  return ok(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Occupancy
// ─────────────────────────────────────────────────────────────────────────────

/** Validates the stored occupancy against the enum, narrowing `string` to the union. */
export function createMemberOccupancy(
  value: string | null | undefined,
): Result<MemberOccupancy, MemberError> {
  if (value === undefined || value === null)
    return ok(DEFAULT_MEMBER_OCCUPANCY);

  const match = MEMBER_OCCUPANCIES.find((occupancy) => occupancy === value);
  if (match === undefined) {
    return err(
      memberError(
        "validation",
        `Occupancy must be one of: ${MEMBER_OCCUPANCIES.join(", ")}.`,
        { field: "occupancy" },
      ),
    );
  }
  return ok(match);
}

// ─────────────────────────────────────────────────────────────────────────────
// Lease window
// ─────────────────────────────────────────────────────────────────────────────

/** `YYYY-MM-DD`, the shape a Postgres `date` column round-trips as. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed);
}

/**
 * Validates a lease window as a **pair**, because neither end can see the rule
 * alone: a tenancy that ends before it starts is a typo with a billing consequence
 * (PRD §3.4 prorates a tenant's charges by this window), and the failure belongs on
 * the field that is wrong — the end date.
 *
 * Both `null` is fine and is the ordinary case: most owners do not have a lease.
 * One end without the other is also fine, and deliberate — a rolling tenancy has a
 * start and no end, which is exactly how a real one is recorded.
 */
export function createLeaseWindow(
  start: string | null | undefined,
  end: string | null | undefined,
): Result<true, MemberError> {
  for (const [value, field, label] of [
    [start, "leaseStart", "Lease start"],
    [end, "leaseEnd", "Lease end"],
  ] as const) {
    if (value === null || value === undefined || value === "") continue;
    if (!isValidDate(value)) {
      return err(
        memberError("validation", `${label} must be a date.`, { field }),
      );
    }
  }

  if (
    start !== null &&
    start !== undefined &&
    start !== "" &&
    end !== null &&
    end !== undefined &&
    end !== "" &&
    end < start
  ) {
    return err(
      memberError("validation", "Lease end cannot be before the lease start.", {
        field: "leaseEnd",
      }),
    );
  }

  return ok(true);
}

// ─────────────────────────────────────────────────────────────────────────────
// The primary claim
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cross-field rule: who may be a flat's primary occupant.
 *
 * Two conditions, both mirrored by constraints in the migration
 * (`chk_members_primary_requires_apartment`, `uq_primary_occupant`):
 *
 *  - **a flat is required**, because "primary" is what the flat's dues are
 *    addressed to and a member without a flat has no address to be primary of;
 *  - **the occupancy must be an owning or tenancy one** (`PRIMARY_OCCUPANCIES`),
 *    because a family member cannot hold the flat's claim while the owner's own
 *    membership does not.
 *
 * Checked against the values that will **survive** the write, not against the fields
 * in the request: a patch that sets `isPrimary: true` without mentioning the flat is
 * judged against the flat already stored, and one that sets the occupancy to
 * `family_member` is judged against the flag already stored. That is the same shape
 * `updateApartment` uses for the carpet/built-up pair, and for the same reason — the
 * rule is about the pair, so a one-field patch cannot be validated on its own.
 */
export function createPrimaryClaim(
  isPrimary: boolean,
  occupancy: MemberOccupancy,
  apartmentId: string | null,
): Result<true, MemberError> {
  if (!isPrimary) return ok(true);

  if (apartmentId === null) {
    return err(
      memberError(
        "validation",
        "Choose the flat this member is the primary occupant of.",
        { field: "apartmentId" },
      ),
    );
  }

  if (!PRIMARY_OCCUPANCIES.includes(occupancy)) {
    return err(
      memberError(
        "validation",
        "A family member cannot be the primary occupant of a flat.",
        { field: "occupancy" },
      ),
    );
  }

  return ok(true);
}
