import { Stack } from 'expo-router';

/**
 * Setup group — the post-auth, pre-membership flow (SAD §5.1):
 * choice → create or join → (optionally) pending approval.
 *
 * Headers are shown because these screens are pushed (`back` returns to the
 * choice screen); the choice screen itself is the group's entry point.
 */
export default function SetupLayout() {
  return <Stack screenOptions={{ headerShown: true }} />;
}
