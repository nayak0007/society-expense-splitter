import { View } from 'react-native';

import { Text } from '@/components/ui/Text';

/**
 * Splash — shown while the (future) session restore runs on cold start
 * (SAD §5.2). Placeholder branding only; the animated logo and font loading
 * land with the design polish phase.
 */
export function SplashScreen() {
  return (
    <View className="flex-1 items-center justify-center gap-2 bg-surface">
      <Text variant="headlineMedium" color="primary" align="center">
        Society Expense Splitter
      </Text>
      <Text variant="bodyMedium" color="onSurfaceVariant">
        Transparent society finances
      </Text>
    </View>
  );
}
