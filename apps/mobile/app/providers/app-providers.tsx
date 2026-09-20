import { QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useColorScheme } from 'nativewind';
import { Linking } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useSessionRestore } from '@/features/auth/hooks/useSessionRestore';
import { handleAuthDeepLink } from '@/features/auth/services/auth-deep-link';
import { useSocietyBootstrap } from '@/features/society/hooks/use-society-bootstrap';
import { handleSocietyDeepLink } from '@/features/society/services/society-deep-link';
import { createQueryClient } from '@/lib/api/query-client';
import { setupReactQueryNetwork } from '@/lib/api/query-network';
import { startSessionSync } from '@/lib/supabase/session-sync';
import { ThemeProvider } from '@/theme';

/**
 * Global providers (SAD §4.2: the root layout is the only place providers
 * are registered). QueryClient is created lazily in state so Fast Refresh
 * does not recreate it on every edit.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => createQueryClient());

  // Session restore + profile bootstrap. Mounted here, not in a screen, because
  // the resolver needs a profile to have settled before it can route.
  useSessionRestore();

  useEffect(() => {
    const teardown = setupReactQueryNetwork();
    return teardown;
  }, []);

  // Session persistence: restore the SecureStore-backed session on cold
  // start and keep the zustand store in sync with every auth event.
  useEffect(() => {
    const teardown = startSessionSync();
    return teardown;
  }, []);

  // Deep links, one dispatch point: society join links first (the resolver
  // routes on memberships), everything else to the auth flow — OAuth return
  // (Android) and password-recovery links. getInitialURL covers a cold start
  // from a link; the listener covers links while the app is running.
  useEffect(() => {
    const subscription = Linking.addEventListener('url', (event) => {
      handleIncomingUrl(event.url);
    });
    void Linking.getInitialURL().then((url) => {
      if (url !== null) handleIncomingUrl(url);
    });
    return () => {
      subscription.remove();
    };
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <SocietyBootstrap />
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

/** Loads the session's memberships once, so routing can decide on frame one. */
function SocietyBootstrap() {
  useSocietyBootstrap();
  return null;
}

function handleIncomingUrl(url: string): void {
  if (handleSocietyDeepLink(url)) return;
  // Verifies the link, installs the session it carries, then routes by kind
  // (signup confirmation → verify screen, recovery → new password).
  void handleAuthDeepLink(url);
}
