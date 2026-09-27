import type {
  CreateSocietyPayload,
  JoinSocietyPayload,
  UpdateSocietyPayload,
} from '@ses/contracts';
import {
  JOIN_NOTE_MAX_LENGTH,
  OCCUPANCY_TYPES,
  SOCIETY_TYPES,
  isValidJoinCode,
  normalizeJoinCode,
} from '@ses/domain';
import type { Society } from '@ses/domain';
import { z } from 'zod';

import { sesResolver } from '@/lib/forms/resolver';

/**
 * Form schemas + mappers for the society feature.
 *
 * WHY SEPARATE FROM THE CONTRACT: `packages/contracts` describes the *payload*
 * (integers, paise, enums) because that is what crosses the wire and what the
 * API validates. Forms are all-strings — a text input yields a string, and
 * forcing coercion into the resolver makes RHF's types lie. The mappers below
 * are the single conversion point, and the payload is still validated again
 * by the service before it reaches the repository (PRD §18.1).
 */

const dayField = (label: string) =>
  z
    .string()
    .trim()
    .regex(/^\d{1,2}$/, `${label} must be a number between 1 and 28`)
    .refine((value) => {
      const day = Number(value);
      return day >= 1 && day <= 28;
    }, `${label} must be between 1 and 28`);

export const societyFormSchema = z.object({
  name: z.string().trim().min(3, 'Name must be at least 3 characters').max(160),
  type: z.enum(SOCIETY_TYPES),
  registrationNumber: z.string().trim().max(64, 'Registration number is too long'),
  addressLine1: z.string().trim().max(200, 'Address is too long'),
  addressLine2: z.string().trim().max(200, 'Address is too long'),
  city: z.string().trim().min(2, 'Enter a city').max(80),
  state: z.string().trim().min(2, 'Enter a state').max(80),
  pincode: z
    .string()
    .trim()
    .refine((value) => value.length === 0 || /^[1-9][0-9]{5}$/.test(value), {
      message: 'Enter a 6-digit PIN code',
    }),
  billingDay: dayField('Billing day'),
  dueDay: dayField('Due day'),
  approvalThresholdRupees: z
    .string()
    .trim()
    .regex(/^\d{1,7}$/, 'Enter an amount in rupees (no decimals)'),
});

export type SocietyFormValues = z.infer<typeof societyFormSchema>;

export const societyFormResolver = sesResolver(societyFormSchema);

export function emptySocietyForm(): SocietyFormValues {
  return {
    name: '',
    type: 'apartment',
    registrationNumber: '',
    addressLine1: '',
    addressLine2: '',
    city: '',
    state: '',
    pincode: '',
    billingDay: '1',
    dueDay: '10',
    approvalThresholdRupees: '10000',
  };
}

/** Prefill the edit form from a society (paise → rupees for the input). */
export function societyToFormValues(society: Society): SocietyFormValues {
  return {
    name: society.name,
    type: society.type,
    registrationNumber: society.registrationNumber ?? '',
    addressLine1: society.addressLine1 ?? '',
    addressLine2: society.addressLine2 ?? '',
    city: society.city,
    state: society.state,
    pincode: society.pincode ?? '',
    billingDay: String(society.settings.billingDay),
    dueDay: String(society.settings.dueDay),
    approvalThresholdRupees: String(Math.round(society.settings.approvalThresholdPaise / 100)),
  };
}

export function formValuesToCreatePayload(values: SocietyFormValues): CreateSocietyPayload {
  return {
    ...commonFields(values),
    name: values.name.trim(),
    type: values.type,
    city: values.city.trim(),
    state: values.state.trim(),
  };
}

export function formValuesToUpdatePayload(values: SocietyFormValues): UpdateSocietyPayload {
  return formValuesToCreatePayload(values);
}

export const joinFormSchema = z.object({
  code: z
    .string()
    .trim()
    .transform(normalizeJoinCode)
    .refine(isValidJoinCode, 'A join code is 6 characters (no 0, O, 1 or I)'),
  occupancyType: z.enum(OCCUPANCY_TYPES),
  /**
   * The flat the requester picks, as a string because a form value is a string.
   *
   * `''` is "none picked yet", which is a legitimate submission — a society whose flats are
   * not recorded still has to be joinable, and an Admin assigns the flat at approval (T049).
   * The mapper is what turns it into an *absent* field rather than an empty id.
   */
  apartmentId: z.string(),
  /** The optional note to the reviewer, bounded by the same constant the column is. */
  message: z
    .string()
    .max(JOIN_NOTE_MAX_LENGTH, `Keep your note to ${JOIN_NOTE_MAX_LENGTH} characters or fewer`),
});

export type JoinFormValues = z.infer<typeof joinFormSchema>;

export const joinFormResolver = sesResolver(joinFormSchema);

export function emptyJoinForm(code = ''): JoinFormValues {
  return {
    code: normalizeJoinCode(code),
    occupancyType: 'owner',
    apartmentId: '',
    message: '',
  };
}

/**
 * The join submission, with the T049 fields only when they carry something.
 *
 * A blank note is *no* note and an unpicked flat is *no* flat — sending `message: ''` would
 * store an empty string the queue then renders as a blank line, and `apartmentId: ''` would
 * fail the contract's UUID check. The contract is `.strict()` and both fields are optional,
 * so the honest mapping is to omit rather than to send a placeholder.
 */
export function formValuesToJoinPayload(values: JoinFormValues): JoinSocietyPayload {
  const apartmentId = values.apartmentId.trim();
  const message = values.message.trim();
  return {
    code: normalizeJoinCode(values.code),
    occupancyType: values.occupancyType,
    ...(apartmentId.length === 0 ? {} : { apartmentId }),
    ...(message.length === 0 ? {} : { message }),
  };
}

/**
 * Deleting a society destroys a tenant, so the confirmation demands the
 * society name typed out (PRD §2: destructive actions are explicit).
 */
export function deleteConfirmSchema(societyName: string) {
  return z.object({
    confirmation: z.string().refine((value) => value.trim() === societyName.trim(), {
      message: `Type "${societyName}" to confirm`,
    }),
  });
}

export type DeleteConfirmValues = z.infer<ReturnType<typeof deleteConfirmSchema>>;

function commonFields(values: SocietyFormValues) {
  return {
    registrationNumber: optional(values.registrationNumber),
    addressLine1: optional(values.addressLine1),
    addressLine2: optional(values.addressLine2),
    pincode: optional(values.pincode),
    billingDay: Number(values.billingDay),
    dueDay: Number(values.dueDay),
    approvalThresholdPaise: Math.round(Number(values.approvalThresholdRupees) * 100),
  };
}

function optional(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
