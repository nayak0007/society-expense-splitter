import { Stack } from 'expo-router';
import { View } from 'react-native';

import { Text } from '@/components/ui/Text';

/**
 * Society switcher modal (SAD §5.1 modals). Content lands with the
 * multi-society model in Phase 3; the route proves the modal presentation.
 */
export default function SocietySwitcher() {
  return (
    <View className="flex-1 items-center justify-center bg-surface p-lg">
      <Stack.Screen options={{ presentation: 'modal', title: 'Switch society' }} />
      <Text variant="titleMedium" align="center">
        Society switcher
      </Text>
      <Text variant="bodyMedium" color="onSurfaceVariant" align="center">
        Placeholder — the membership list arrives in Phase 3.
      </Text>
    </View>
  );
}
