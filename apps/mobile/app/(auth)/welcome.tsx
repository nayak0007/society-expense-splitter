import { Link, Stack } from 'expo-router';
import { View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Text } from '@/components/ui/Text';

/** Welcome — the unauthenticated landing screen (SAD §5.2: Splash → Auth). */
export default function Welcome() {
  return (
    <View className="flex-1 justify-between bg-surface p-lg">
      <Stack.Screen options={{ headerShown: false }} />
      <View className="grow items-center justify-center gap-3">
        <View className="h-16 w-16 items-center justify-center rounded-full bg-primary-container">
          <Text variant="headlineMedium" color="onPrimaryContainer">
            ₹
          </Text>
        </View>
        <Text variant="headlineMedium" align="center">
          Society Expense Splitter
        </Text>
        <Text variant="bodyMedium" color="onSurfaceVariant" align="center">
          Transparent society finances — set up in 20 minutes.
        </Text>
      </View>
      <View className="gap-3 pb-xl">
        <Link href="/(auth)/login" asChild>
          <Button variant="filled">Log in</Button>
        </Link>
        <Link href="/(auth)/register" asChild>
          <Button variant="tonal">Create an account</Button>
        </Link>
      </View>
    </View>
  );
}
