import { emailSchema, fullNameSchema, passwordSchema } from '@ses/contracts';
import type { SignUpPayload } from '@ses/contracts';
import { z } from 'zod';

import { sesResolver } from '@/lib/forms/resolver';

/**
 * Auth form schemas.
 *
 * The *rules* live in `packages/contracts/src/auth.ts` and are imported here, so
 * the client cannot validate something the API would reject — the drift PRD
 * §18.1 is about. This file only adds what forms need and payloads must not
 * carry: password confirmation, a boolean consent flag, and mapping to payloads.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Login
// ─────────────────────────────────────────────────────────────────────────────

export const LoginSchema = z.object({
  email: emailSchema,
  // No policy check here: a password that predates a policy change must still
  // be able to sign in (and then be reset).
  password: z.string().min(1, 'Enter your password'),
});
export type LoginCredentials = z.infer<typeof LoginSchema>;
export const loginResolver = sesResolver(LoginSchema);

// ─────────────────────────────────────────────────────────────────────────────
// Sign-up
// ─────────────────────────────────────────────────────────────────────────────

export const SignUpFormSchema = z
  .object({
    fullName: fullNameSchema,
    email: emailSchema,
    password: passwordSchema,
    confirmPassword: z.string(),
    /**
     * Terms/privacy consent (Roadmap T030). Boolean rather than the contract's
     * `z.literal(true)`: a checkbox starts false, and a literal would type the
     * field as `true` and fight React Hook Form.
     */
    acceptedTerms: z
      .boolean()
      .refine((value) => value, 'You must accept the terms and privacy policy'),
  })
  .refine((values) => values.password === values.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });
export type SignUpFormValues = z.infer<typeof SignUpFormSchema>;
export const signUpResolver = sesResolver(SignUpFormSchema);

export function toSignUpPayload(values: SignUpFormValues): SignUpPayload {
  return {
    email: values.email,
    password: values.password,
    fullName: values.fullName,
    // The form validator has already proven this is true.
    acceptedTerms: true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Password reset
// ─────────────────────────────────────────────────────────────────────────────

export const ForgotPasswordSchema = z.object({ email: emailSchema });
export type ForgotPasswordValues = z.infer<typeof ForgotPasswordSchema>;
export const forgotPasswordResolver = sesResolver(ForgotPasswordSchema);

export const ResetPasswordSchema = z
  .object({
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((values) => values.password === values.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });
export type ResetPasswordValues = z.infer<typeof ResetPasswordSchema>;
export const resetPasswordResolver = sesResolver(ResetPasswordSchema);

// ─────────────────────────────────────────────────────────────────────────────
// Profile
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Profile setup collects a name only.
 *
 * Phone is deliberately absent: it is an *identity* (PRD §3.1 prefers it as the
 * primary one), so it is attached through Supabase Auth with an OTP and mirrored
 * by the `on_auth_user_updated` trigger. A plain text field here would write an
 * unverified number that the column grants reject anyway.
 */
export const ProfileSetupSchema = z.object({ fullName: fullNameSchema });
export type ProfileSetupValues = z.infer<typeof ProfileSetupSchema>;
export const profileSetupResolver = sesResolver(ProfileSetupSchema);
