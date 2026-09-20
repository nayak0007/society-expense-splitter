import { Redirect, Stack } from 'expo-router';

import { selectSessionStatus, useAuthStore } from '@/stores/auth.store';

/**
 * Setup group — the post-auth, pre-membership flow (SAD §5.1):
 * profile setup → choice → create or join → (optionally) pending approval.
 *
 * Both setup and (app) are protected groups (Roadmap T033): reaching them
 * without a session redirects to `(auth)`. This is navigation hygiene, not
 * security — every read and write is also bounded by RLS on the server.
 *
 * There is deliberately no *profile* gate here: this group is where an
 * incomplete profile gets completed.
 */
export default function SetupLayout() {
  const status = useAuthStore(selectSessionStatus);

  if (status !== 'authenticated') {
    return <Redirect href="/(auth)/login" />;
  }

  return <Stack screenOptions={{ headerShown: true }} />;
}
