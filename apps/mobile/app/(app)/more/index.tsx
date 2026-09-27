import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { RequirePermission } from '@/components/layout/RequirePermission';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Text } from '@/components/ui/Text';
import { logout } from '@/features/auth/api/auth.api';
import {
  selectAuthUser,
  selectEmailVerified,
  selectProfile,
  useAuthStore,
} from '@/stores/auth.store';

/** More tab root — settings, members and reports land in later phases. */
export default function More() {
  const router = useRouter();
  const user = useAuthStore(selectAuthUser);
  const profile = useAuthStore(selectProfile);
  const emailVerified = useAuthStore(selectEmailVerified);
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  return (
    <View className="flex-1 bg-surface">
      <Stack.Screen options={{ headerShown: true, headerTitle: 'More' }} />
      <View className="gap-4 p-lg">
        <Text variant="headlineSmall">More</Text>
        <Text variant="bodyMedium" color="onSurfaceVariant">
          Signed in as {profile?.fullName ?? user?.email ?? 'unknown'}
        </Text>

        {/* PRD §3.1: an unverified account can use the app but cannot hold an
            Admin or Treasurer role — so verification is surfaced, not hidden. */}
        {user !== null && !emailVerified ? (
          <Card variant="outlined">
            <View className="gap-2">
              <Text variant="titleSmall">Verify your email</Text>
              <Text variant="bodySmall" color="onSurfaceVariant">
                Confirm {user.email ?? 'your address'} to be eligible for Admin or Treasurer roles.
              </Text>
              <View className="mt-1">
                <Button
                  variant="tonal"
                  size="sm"
                  onPress={() =>
                    router.push({
                      pathname: '/(auth)/verify-email',
                      params: { email: user.email ?? '' },
                    })
                  }
                >
                  Verify email
                </Button>
              </View>
            </View>
          </Card>
        ) : null}

        <Text variant="titleSmall">Society</Text>
        <View className="gap-3">
          <Button variant="tonal" onPress={() => router.push('/(app)/more/society')}>
            Society profile
          </Button>
          <Button variant="outlined" onPress={() => router.push('/(modals)/society-switcher')}>
            Switch society
          </Button>
        </View>

        {/* PRD §5: the physical structure is configuration, set up once and rarely
            revisited — so it hangs off More rather than taking a tab of its own. */}
        <Text variant="titleSmall">Structure</Text>
        <View className="gap-3">
          <Button variant="tonal" onPress={() => router.push('/(app)/more/structure')}>
            Buildings
          </Button>
        </View>

        {/* PRD §3.3: the member directory. It sits beside Structure because the
            two are the same kind of thing — who and what the society is made of —
            and both are read occasionally rather than daily, unlike expenses. */}
        <Text variant="titleSmall">Members</Text>
        <View className="gap-3">
          <Button variant="tonal" onPress={() => router.push('/(app)/more/members')}>
            Member directory
          </Button>
          {/* T046: the permissions viewer sits beside the directory, because the two answer the
              same kind of question — who is in the society and what each of them may do. */}
          <Button variant="outlined" onPress={() => router.push('/(app)/more/permissions')}>
            Roles &amp; permissions
          </Button>
        </View>

        <Text variant="titleSmall">Protected-route demo (SAD §5.5 layer 2)</Text>
        <Text variant="bodySmall" color="onSurfaceVariant">
          Route-level guard rendering PermissionDenied instead of the screen — no redirect, no
          server, a pure UI-state toggle.
        </Text>
        <View className="gap-3">
          <Button variant="tonal" onPress={() => setIsAuthorized((v) => !v)}>
            {isAuthorized ? 'Revoke permission' : 'Grant permission'}
          </Button>
          <RequirePermission action="cycle.publish" authorized={isAuthorized}>
            <View className="gap-2 rounded-card bg-surface-container-low p-lg">
              <Text variant="titleMedium">Cycle detail</Text>
              <Text variant="bodyMedium" color="onSurfaceVariant">
                Protected content. You may publish cycles.
              </Text>
            </View>
          </RequirePermission>
        </View>

        <Button
          variant="outlined"
          loading={isLoggingOut}
          onPress={async () => {
            setIsLoggingOut(true);
            await logout('local');
            setIsLoggingOut(false);
            router.replace('/(auth)/login');
          }}
        >
          Log out
        </Button>
      </View>
    </View>
  );
}
