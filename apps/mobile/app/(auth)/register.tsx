import { PlaceholderScreen } from '@/components/layout/PlaceholderScreen';

/** Register — placeholder. Real form arrives in Phase 2. */
export default function Register() {
  return (
    <PlaceholderScreen
      title="Create account"
      description="Sign-up flow will live here."
      links={[['Back to Welcome', '/(auth)/welcome']]}
    />
  );
}
