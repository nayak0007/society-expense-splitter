import { z } from 'zod';

import { sesResolver } from '@/lib/forms/resolver';

/**
 * Auth form + API boundary schemas (PRD §18.1: zod at every boundary, types
 * inferred from the schema, never hand-written twice).
 */

export const EmailSchema = z.email('Enter a valid email address');

export const PasswordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(72, 'Password must be at most 72 characters');

export const LoginSchema = z.object({
  email: EmailSchema,
  password: PasswordSchema,
});
export type LoginCredentials = z.infer<typeof LoginSchema>;

export const ForgotPasswordSchema = z.object({
  email: EmailSchema,
});
export type ForgotPasswordValues = z.infer<typeof ForgotPasswordSchema>;

export const ResetPasswordSchema = z
  .object({
    password: PasswordSchema,
    confirmPassword: z.string(),
  })
  .refine((values) => values.password === values.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });
export type ResetPasswordValues = z.infer<typeof ResetPasswordSchema>;

/** Prefilled resolver for the login form. */
export const loginResolver = sesResolver(LoginSchema);
export const forgotPasswordResolver = sesResolver(ForgotPasswordSchema);
export const resetPasswordResolver = sesResolver(ResetPasswordSchema);
