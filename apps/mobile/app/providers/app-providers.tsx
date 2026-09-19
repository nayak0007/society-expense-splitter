import { QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useColorScheme } from 'nativewind';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { createQueryClient } from '@/lib/api/query-client';
import { setupReactQueryNetwork } from '@/lib/api/query-network';
import { ThemeProvider } from '@/theme';

/**
 * Global providers (SAD §4.2: the root layout is the only place providers
 * are registered). QueryClient is created lazily in state so Fast Refresh
 * does not recreate it on every edit.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => createQueryClient());

  useEffect(() => {
    const teardown = setupReactQueryNetwork();
    return teardown;
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <SafeAreaProvider>{children}</SafeAreaProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

/** Root navigator — renders inside AppProviders. */
export function RootNavigator() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
    </Stack>
  );
}

/** Status bar icons adapt to the OS color scheme (light icons on dark). */
export function RootStatusBar() {
  const { colorScheme } = useColorScheme();
  return <StatusBar style={colorScheme === 'dark' ? 'light' : 'dark'} />;
}
