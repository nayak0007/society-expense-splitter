/* global process */
/**
 * Runs before the first module import in every Jest worker.
 *
 * `src/constants/config.ts` validates the public environment at module load and throws when it
 * is missing, so a component test that transitively imports the config — almost all of them —
 * would fail before a single assertion. These are synthetic values: they satisfy the schema
 * and nothing in the suite ever makes a network call with them.
 */
process.env.EXPO_PUBLIC_API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000/v1';
process.env.EXPO_PUBLIC_SUPABASE_URL =
  process.env.EXPO_PUBLIC_SUPABASE_URL ?? 'https://test-project.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY =
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? 'sb_publishable_test_key_0123456789';
process.env.EXPO_PUBLIC_RAZORPAY_KEY_ID =
  process.env.EXPO_PUBLIC_RAZORPAY_KEY_ID ?? 'rzp_test_0123456789abcdef';
process.env.EXPO_PUBLIC_SENTRY_DSN = process.env.EXPO_PUBLIC_SENTRY_DSN ?? '';
process.env.EXPO_PUBLIC_POSTHOG_KEY = process.env.EXPO_PUBLIC_POSTHOG_KEY ?? '';
