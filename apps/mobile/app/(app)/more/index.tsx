import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { RequirePermission } from '@/components/layout/RequirePermission';
import { Button } from '@/components/ui/Button';
import { Text } from '@/components/ui/Text';

/** More tab root — settings, members, reports land in later phases. */
export default function More() {
  const router = useRouter();
  const [isAuthorized, setIsAuthorized] = useState(false);

  return (
    <View className="flex-1 bg-surface">
      <Stack.Screen options={{ headerShown: true, headerTitle: 'More' }} />
      <View className="gap-4 p-lg">
        <Text variant="headlineSmall">More</Text>
        <Text variant="bodyMedium" color="onSurfaceVariant">
          Settings, members and reports will live here.
        </Text>

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

        <Button variant="outlined" onPress={() => router.replace('/(auth)/login')}>
          Demo sign-out (back to Login)
        </Button>
      </View>
    </View>
  );
}
