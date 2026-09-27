import type { CreateMemberPayload, UpdateMemberPayload } from '@ses/contracts';
import {
  MEMBER_EMAIL_MAX_LENGTH,
  MEMBER_NAME_MAX_LENGTH,
  MEMBER_OCCUPANCIES,
  MEMBER_STATUSES,
  isMemberError,
} from '@ses/domain';
import type { Member, MemberOccupancy, MemberRole, MemberStatus } from '@ses/domain';
import { z } from 'zod';

import { sesResolver } from '@/lib/forms/resolver';

/**
 * Form schema + mappers for the member directory.
 *
 * WHY SEPARATE FROM THE CONTRACT: the same reason `building.schemas.ts` and
 * `society.schemas.ts` give — `packages/contracts` describes the *payload* (enums, bounds,
 * uuid fields, `null` for "clear") because that is what crosses the wire and what the API
 * validates, while a form is all-strings and booleans because that is what a text field and
 * a switch yield. The mappers below are the single conversion point, and the service
 * validates the payload against the contract again before it reaches a use case.
 *
 * The enums and bounds are **imported from `@ses/domain`** rather than written as literals
 * here: a `max(120)` in one place and `MEMBER_NAME_MAX_LENGTH` in another is two definitions
 * of one rule, and the way it fails is that the form accepts what the server refuses.
 */

/** The lifecycle in the words the UI uses. `inactive` is the PRD's word for suspended. */
export const MEMBER_STATUS_LABELS: Readonly<Record<MemberStatus, string>> = {
  pending: 'Pending',
  active: 'Active',
  inactive: 'Suspended',
  removed: 'Removed',
  rejected: 'Rejected',
};

export const MEMBER_ROLE_LABELS: Readonly<Record<MemberRole, string>> = {
  admin: 'Admin',
  treasurer: 'Treasurer',
  committee_member: 'Committee',
  resident: 'Resident',
  /**
   * `tenant` is a *role* as well as an occupancy (PRD §7.1 has it in both enums): a tenancy
   * that the society bills and therefore grants a say in, as opposed to a family member
   * living in an owner's flat. The two are separate columns and both are shown.
   */
  tenant: 'Tenant',
  guest: 'Guest',
};

/**
 * The stored occupancy (PRD §7.1), in the words a society actually uses.
 *
 * Not the join flow's declaration (`owner | tenant | family_member`): this is what is
 * stored, and it has one value the join screen cannot express — `vacant_owner`, an owner
 * who lives elsewhere, which is precisely who still has to be billed.
 */
export const MEMBER_OCCUPANCY_LABELS: Readonly<Record<MemberOccupancy, string>> = {
  owner_occupied: 'Owner-occupied',
  tenant: 'Tenant',
  family_member: 'Family member',
  vacant_owner: 'Owner (lives elsewhere)',
};

/**
 * A phone as people type it: digits with optional `+`, spaces, dashes, dots and brackets.
 *
 * Deliberately **not** an E.164 pattern. The domain normalises the value (`createPhone`) and
 * reports its own message on the `phone` field, so restating the exact rule here would be a
 * second copy of it that the user meets first — and the copy would refuse `98765 43210`,
 * which is the most common thing anyone types. The two rules here are only the ones the
 * *keyboard* can get wrong: characters that can never be part of a number, and a digit count
 * that no country's numbering plan fits.
 */
const phoneField = z
  .string()
  .trim()
  .refine((value) => value.length === 0 || /^[+\d][\d\s().-]*$/.test(value), {
    message: 'Enter a valid phone number',
  })
  .refine((value) => {
    if (value.length === 0) return true;
    const digits = value.replace(/\D/g, '');
    return digits.length >= 8 && digits.length <= 15;
  }, 'Enter a valid phone number');

/**
 * `YYYY-MM-DD`, or empty.
 *
 * The same shape the contract accepts, checked here as well for the reason the phone is: a
 * date field that has a typo should say so under the field rather than after a round trip.
 * Not a calendar-picker rule — a lease window is often entered from a paper agreement, and
 * typing a date is faster than scrolling to one.
 */
const dateField = z
  .string()
  .trim()
  .refine((value) => value.length === 0 || /^\d{4}-\d{2}-\d{2}$/.test(value), {
    message: 'Use YYYY-MM-DD',
  });

export const memberFormSchema = z.object({
  displayName: z
    .string()
    .trim()
    .min(1, 'Enter a name')
    .max(MEMBER_NAME_MAX_LENGTH, `Name must be ${MEMBER_NAME_MAX_LENGTH} characters or fewer`),
  email: z
    .string()
    .trim()
    .max(MEMBER_EMAIL_MAX_LENGTH, `Email must be ${MEMBER_EMAIL_MAX_LENGTH} characters or fewer`)
    .refine((value) => value.length === 0 || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), {
      message: 'Enter a valid email address',
    }),
  phone: phoneField,
  occupancy: z.enum(MEMBER_OCCUPANCIES),
  /**
   * The flat is carried as two fields, not one.
   *
   * `buildingId` exists to *narrow* the flat list and is never sent: a society with four
   * towers and 300 flats cannot render 300 options, and the API's flat list is per building.
   * Only `apartmentId` reaches a payload, which is why the second field is the one the
   * contract knows about.
   */
  buildingId: z.string().nullable(),
  apartmentId: z.string().nullable(),
  isPrimary: z.boolean(),
  leaseStart: dateField,
  leaseEnd: dateField,
  shareContact: z.boolean(),
});

export type MemberFormValues = z.infer<typeof memberFormSchema>;

export const memberFormResolver = sesResolver(memberFormSchema);

/**
 * The create form's resolver: the same schema, with the phone required.
 *
 * The requirement is create-only, because the contract says so — `createMemberSchema`
 * requires a number (a shadow member's only identifier) while `updateMemberSchema` accepts
 * `null` for it, since a society that recorded the wrong number has to be able to take it
 * off. One schema plus one refinement states that asymmetry once, instead of two forms that
 * can drift apart field by field.
 */
export const memberCreateResolver = sesResolver(
  memberFormSchema.refine((values) => values.phone.length > 0, {
    message: 'Enter a phone number',
    path: ['phone'],
  }),
);

export function emptyMemberForm(): MemberFormValues {
  return {
    displayName: '',
    email: '',
    phone: '',
    occupancy: 'owner_occupied',
    buildingId: null,
    apartmentId: null,
    isPrimary: false,
    leaseStart: '',
    leaseEnd: '',
    shareContact: false,
  };
}

/** Prefill the edit form (`null`s become empty strings — the only thing a field can hold). */
export function memberToFormValues(member: Member): MemberFormValues {
  return {
    displayName: member.displayName,
    email: member.email ?? '',
    phone: member.phone ?? '',
    occupancy: member.occupancy,
    buildingId: member.apartment?.buildingId ?? null,
    apartmentId: member.apartmentId,
    isPrimary: member.isPrimary,
    leaseStart: member.leaseStart ?? '',
    leaseEnd: member.leaseEnd ?? '',
    shareContact: member.shareContact,
  };
}

/**
 * Form → create payload.
 *
 * Every optional field is **omitted** when empty, never sent as `null` or `''`: the create
 * contract makes them `.optional()` and refuses `null` (there is nothing to clear on a row
 * that does not exist yet), and an empty string would be stored as an empty phone number
 * rather than as "none on file".
 */
export function formValuesToCreatePayload(values: MemberFormValues): CreateMemberPayload {
  const email = values.email.trim();
  const leaseStart = values.leaseStart.trim();
  const leaseEnd = values.leaseEnd.trim();

  return {
    displayName: values.displayName.trim(),
    phone: values.phone.trim(),
    occupancy: values.occupancy,
    isPrimary: values.isPrimary,
    shareContact: values.shareContact,
    ...(email.length === 0 ? {} : { email }),
    ...(values.apartmentId === null ? {} : { apartmentId: values.apartmentId }),
    ...(leaseStart.length === 0 ? {} : { leaseStart }),
    ...(leaseEnd.length === 0 ? {} : { leaseEnd }),
  };
}

/**
 * Form → update payload.
 *
 * The other half of the asymmetry, and this is where it matters: an emptied field becomes an
 * explicit **`null`**, not an omission. A shadow member's phone is the only identifier they
 * have, so "we recorded the wrong number, take it off" has to be expressible — and with the
 * field simply left out, the wrong number would stay on the row and the next attempt to
 * record the right one would collide with it.
 */
export function formValuesToUpdatePayload(values: MemberFormValues): UpdateMemberPayload {
  const email = values.email.trim();
  const phone = values.phone.trim();
  const leaseStart = values.leaseStart.trim();
  const leaseEnd = values.leaseEnd.trim();

  return {
    displayName: values.displayName.trim(),
    phone: phone.length === 0 ? null : phone,
    email: email.length === 0 ? null : email,
    occupancy: values.occupancy,
    // Always present, and `null` when no flat is chosen: picking a building's first flat and
    // then clearing it is a real edit, and an omitted key could not say so.
    apartmentId: values.apartmentId,
    isPrimary: values.isPrimary,
    leaseStart: leaseStart.length === 0 ? null : leaseStart,
    leaseEnd: leaseEnd.length === 0 ? null : leaseEnd,
    shareContact: values.shareContact,
  };
}

const FORM_FIELDS: ReadonlySet<string> = new Set([
  'displayName',
  'phone',
  'email',
  'occupancy',
  'buildingId',
  'apartmentId',
  'isPrimary',
  'leaseStart',
  'leaseEnd',
  'shareContact',
] satisfies ReadonlyArray<keyof MemberFormValues>);

/** Every status, as a filter option (the list screen's chips). */
export const MEMBER_STATUS_OPTIONS = MEMBER_STATUSES.map((status) => ({
  value: status,
  label: MEMBER_STATUS_LABELS[status],
}));

/**
 * The form input a failed request belongs to, when the server named one.
 *
 * A duplicate shadow phone is not a banner — it is *this* input's problem, and the API
 * deliberately says so (`field: "phone"`), as does the domain's value object. The name is
 * checked against this form's own fields first: the server's vocabulary is broader than one
 * form's, and an unrecognised name passed to `setError` would create an error key no input
 * renders — an invisible failure.
 */
export function formFieldOfError(error: unknown): keyof MemberFormValues | undefined {
  if (!isMemberError(error)) return undefined;
  const field = error.details?.field;
  return typeof field === 'string' && FORM_FIELDS.has(field)
    ? (field as keyof MemberFormValues)
    : undefined;
}
