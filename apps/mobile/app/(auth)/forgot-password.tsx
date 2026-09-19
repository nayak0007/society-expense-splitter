import { PlaceholderScreen } from '@/components/layout/PlaceholderScreen';

/** Forgot password — placeholder. Real flow arrives in Phase 2. */
export default function ForgotPassword() {
  return (
    <PlaceholderScreen
      title="Reset password"
      description="Email / OTP reset flow will live here."
      links={[['Back to Log in', '/(auth)/login']]}
    />
  );
}
