import { z } from "zod";

/**
 * Auth contract — schemas shared by the mobile app and the API (SAD §7: DTOs
 * are Zod schemas in `packages/contracts`, validated identically on both sides
 * so a rule cannot drift; PRD §18.1).
 *
 * Two shapes per concept where the wire format and the app's vocabulary differ:
 *  - `*Row` schemas mirror the Postgres columns exactly (snake_case) because
 *    that is what PostgREST returns;
 *  - `*Schema`/types expose camelCase for the app.
 * The mapper between them is deliberately the only conversion point.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Field-level rules
// ─────────────────────────────────────────────────────────────────────────────

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email("Enter a valid email address"));

/**
 * Interim common-password blocklist.
 *
 * PRD §3.1 asks for the top-1000 list bundled locally. The entry point and the
 * rule live here so both sides enforce the same thing; the list itself is a
 * starter subset and the remaining entries land with the API auth module (T021),
 * where it also feeds the Argon2id signup path. Being smaller than specified is
 * a known, tracked gap — silently dropping the check would not be.
 */
export const COMMON_PASSWORDS = [
  "password",
  "password1",
  "password123",
  "passw0rd",
  "p@ssw0rd",
  "12345678",
  "123456789",
  "1234567890",
  "qwerty123",
  "qwertyuiop",
  "letmein1",
  "welcome1",
  "iloveyou1",
  "admin123",
  "administrator",
  "abc12345",
  "abcd1234",
  "a1b2c3d4",
  "test1234",
  "changeme",
  "changeme1",
  "secret123",
  "mypassword",
  "monkey123",
  "dragon123",
  "football1",
  "baseball1",
  "sunshine1",
  "princess1",
  "superman1",
  "india123",
  "india1234",
  "society123",
  "maintenance1",
  "resident1",
  "treasurer1",
  "society@123",
  "abcd@1234",
  "qwerty@123",
  "1qaz2wsx",
  "zaq12wsx",
  "asdfghjkl",
  "987654321",
  "11111111",
  "00000000",
  "88888888",
  "66666666",
  "12341234",
  "11223344",
  "10203040",
] as const;

const COMMON_PASSWORD_SET = new Set<string>(COMMON_PASSWORDS);

/**
 * PRD §3.1: minimum 8 characters, must contain a letter and a number, and must
 * not be a known-common password. Supabase's own minimum (6) is lower, so this
 * schema — not the dashboard setting — is the policy of record.
 */
export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(72, "Password must be at most 72 characters")
  .regex(/[A-Za-z]/, "Password must contain a letter")
  .regex(/[0-9]/, "Password must contain a number")
  .refine((value) => !COMMON_PASSWORD_SET.has(value.toLowerCase()), {
    message: "That password is too common. Choose something less guessable.",
  });

/**
 * E.164. PRD §3.1 defaults to +91 and validates 10 national digits; the stored
 * value is always international so MSG91 dispatch and invites need no guessing.
 */
export const phoneSchema = z
  .string()
  .trim()
  .regex(
    /^\+[1-9][0-9]{7,14}$/,
    "Use international format, e.g. +919876543210",
  );

export const fullNameSchema = z
  .string()
  .trim()
  .min(2, "Enter your name")
  .max(120, "Name is too long");

export const localeSchema = z.enum([
  "en",
  "hi",
  "mr",
  "ta",
  "te",
  "kn",
  "bn",
  "gu",
]);

// ─────────────────────────────────────────────────────────────────────────────
// Requests
// ─────────────────────────────────────────────────────────────────────────────

export const signUpSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  fullName: fullNameSchema,
  phone: phoneSchema.optional(),
  acceptedTerms: z.literal(true, {
    error: "You must accept the terms and privacy policy",
  }),
});
export type SignUpPayload = z.infer<typeof signUpSchema>;

export const signInSchema = z.object({
  email: emailSchema,
  // No policy check on sign-in: an old password that predates a policy change
  // must still be allowed to log in (and then be reset).
  password: z.string().min(1, "Enter your password"),
});
export type SignInPayload = z.infer<typeof signInSchema>;

export const emailOnlySchema = z.object({ email: emailSchema });
export type EmailOnlyPayload = z.infer<typeof emailOnlySchema>;

/** Resend targets differ: an unconfirmed signup vs a recovery link. */
export const resendTargetSchema = z.enum(["signup", "recovery"]);
export type ResendTarget = z.infer<typeof resendTargetSchema>;

export const resetPasswordSchema = z
  .object({
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((values) => values.password === values.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });
export type ResetPasswordPayload = z.infer<typeof resetPasswordSchema>;

/**
 * Link kinds Supabase can hand back to the app (`type` in the redirect). The
 * app routes on this: `signup` finishes email verification, `recovery` unlocks
 * the reset screen, `email_change` confirms a new address.
 */
export const emailLinkTypeSchema = z.enum([
  "signup",
  "recovery",
  "invite",
  "magiclink",
  "email_change",
]);
export type EmailLinkType = z.infer<typeof emailLinkTypeSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Profile
// ─────────────────────────────────────────────────────────────────────────────

export const userStatusSchema = z.enum(["active", "inactive", "deleted"]);
export type UserStatusDto = z.infer<typeof userStatusSchema>;

/** Exactly the `public.profiles` columns as PostgREST returns them. */
export const profileRowSchema = z.object({
  id: z.uuid(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  full_name: z.string().nullable(),
  avatar_url: z.string().nullable(),
  locale: z.string(),
  status: userStatusSchema,
  email_verified_at: z.string().nullable(),
  phone_verified_at: z.string().nullable(),
  is_profile_complete: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
});
export type ProfileRow = z.infer<typeof profileRowSchema>;

/** App-facing profile. Every consumer reads this, never the raw row. */
export interface Profile {
  readonly id: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly fullName: string | null;
  readonly avatarUrl: string | null;
  readonly locale: string;
  readonly status: UserStatusDto;
  readonly emailVerified: boolean;
  readonly phoneVerified: boolean;
  readonly isComplete: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function profileFromRow(row: ProfileRow): Profile {
  return {
    id: row.id,
    email: row.email,
    phone: row.phone,
    fullName: row.full_name,
    avatarUrl: row.avatar_url,
    locale: row.locale,
    status: row.status,
    emailVerified: row.email_verified_at !== null,
    phoneVerified: row.phone_verified_at !== null,
    isComplete: row.is_profile_complete,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Fields a signed-in client may write.
 *
 * `email` and `phone` are intentionally absent: they are identities, so changing
 * them goes through Supabase Auth (confirmation email / OTP) and the
 * `on_auth_user_updated` trigger mirrors the verified value. Letting a client
 * write them directly would make profile rows a path to account takeover, and
 * the column grants in `20260920120100_auth_profiles_rls.sql` reject it anyway.
 */
export const profileUpdateSchema = z.object({
  fullName: fullNameSchema.optional(),
  locale: localeSchema.optional(),
  avatarUrl: z.url().nullable().optional(),
});
export type ProfileUpdatePayload = z.infer<typeof profileUpdateSchema>;

/** Minimal insert used by the bootstrap fallback when the trigger did not run. */
export const profileBootstrapSchema = z.object({
  id: z.uuid(),
  email: z.string().nullable(),
  fullName: z.string().nullable().optional(),
});
export type ProfileBootstrapPayload = z.infer<typeof profileBootstrapSchema>;
