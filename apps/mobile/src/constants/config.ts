import { z } from 'zod';

/**
 * Public, build-time configuration — the ONLY place the app reads
 * EXPO_PUBLIC_* variables. Validated with Zod at module load so a
 * misconfigured build fails immediately with every offending variable listed,
 * rather than at 2am on a code path (SAD §19.2, Roadmap T009).
 *
 * Add nothing secret here: everything in this file ships in the bundle.
 */

/** The only variables allowed to be EXPO_PUBLIC_* (SAD §19.2). */
const PUBLIC_ENV_KEYS = [
  'EXPO_PUBLIC_API_URL',
  'EXPO_PUBLIC_SUPABASE_URL',
  'EXPO_PUBLIC_SUPABASE_ANON_KEY',
  'EXPO_PUBLIC_RAZORPAY_KEY_ID',
  'EXPO_PUBLIC_SENTRY_DSN',
  'EXPO_PUBLIC_POSTHOG_KEY',
] as const;

const PublicEnvSchema = z.object({
  EXPO_PUBLIC_API_URL: z.url('EXPO_PUBLIC_API_URL must be a valid URL'),
  EXPO_PUBLIC_SUPABASE_URL: z.url().refine((v) => v.endsWith('.supabase.co'), {
    message: 'must be the Supabase project URL (https://<ref>.supabase.co)',
  }),
  // Supabase publishable/anon keys are JWTs (two dots) or sb_ prefixed
  // publishable keys; both are public by design — RLS is the boundary.
  EXPO_PUBLIC_SUPABASE_ANON_KEY: z
    .string()
    .min(20, 'EXPO_PUBLIC_SUPABASE_ANON_KEY is missing or too short'),
  EXPO_PUBLIC_RAZORPAY_KEY_ID: z
    .string()
    .regex(/^rzp_(test|live)_[A-Za-z0-9]+$/, 'must look like rzp_test_… / rzp_live_…'),
  EXPO_PUBLIC_SENTRY_DSN: z.union([z.url(), z.literal('')]),
  EXPO_PUBLIC_POSTHOG_KEY: z.union([z.string().min(1), z.literal('')]),
});

const parsed = PublicEnvSchema.safeParse({
  EXPO_PUBLIC_API_URL: process.env.EXPO_PUBLIC_API_URL?.trim(),
  EXPO_PUBLIC_SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL?.trim(),
  EXPO_PUBLIC_SUPABASE_ANON_KEY: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY?.trim(),
  EXPO_PUBLIC_RAZORPAY_KEY_ID:
    process.env.EXPO_PUBLIC_RZP_KEY_ID?.trim() ?? process.env.EXPO_PUBLIC_RAZORPAY_KEY_ID?.trim(),
  EXPO_PUBLIC_SENTRY_DSN: process.env.EXPO_PUBLIC_SENTRY_DSN?.trim() ?? '',
  EXPO_PUBLIC_POSTHOG_KEY: process.env.EXPO_PUBLIC_POSTHOG_KEY?.trim() ?? '',
});

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  // console.error is deliberate: this is the fail-loud bootstrap path (T009).
  // eslint-disable-next-line no-console
  console.error(
    `[config] Invalid public environment:\n${issues}\n` +
      `Allowed public vars: ${PUBLIC_ENV_KEYS.join(', ')}\n` +
      `Copy apps/mobile/.env.example to apps/mobile/.env and fill the values.`,
  );
  throw new Error(`[config] Invalid public environment:\n${issues}`);
}

export const config = {
  /** Base URL of the SES API, e.g. https://api.societyexpensesplitter.com/v1 */
  apiUrl: parsed.data.EXPO_PUBLIC_API_URL,
  /** Supabase project URL (public — RLS is the security boundary). */
  supabaseUrl: parsed.data.EXPO_PUBLIC_SUPABASE_URL,
  /** Supabase anon/publishable key (public by design). */
  supabaseAnonKey: parsed.data.EXPO_PUBLIC_SUPABASE_ANON_KEY,
  /** Razorpay key id (public identifier — the secret never lives here). */
  razorpayKeyId: parsed.data.EXPO_PUBLIC_RAZORPAY_KEY_ID,
  sentryDsn: parsed.data.EXPO_PUBLIC_SENTRY_DSN,
  posthogKey: parsed.data.EXPO_PUBLIC_POSTHOG_KEY,
} as const;

export type AppConfig = typeof config;
