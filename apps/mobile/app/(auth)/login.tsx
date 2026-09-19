import { PlaceholderScreen } from '@/components/layout/PlaceholderScreen';

/** Login — placeholder. Real form + providers arrive in Phase 2. */
export default function Login() {
  return (
    <PlaceholderScreen
      title="Log in"
      description="Email / phone + OTP sign-in will live here."
      links={[
        ['Continue (demo sign-in)', '/(app)/home'],
        ['Back to Welcome', '/(auth)/welcome'],
      ]}
    />
  );
}
