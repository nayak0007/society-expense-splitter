import { Ionicons } from '@expo/vector-icons';
import { Redirect, Tabs } from 'expo-router';
import type { ComponentProps } from 'react';

import { useTheme } from '@/theme';
import { selectSessionStatus, useAuthStore } from '@/stores/auth.store';

type IoniconsName = ComponentProps<typeof Ionicons>['name'];

/** Options type derived from expo-router's own Tabs — a single source of truth. */
type TabScreenOptions = NonNullable<ComponentProps<typeof Tabs.Screen>['options']>;

/**
 * Protected group — five tabs, each owning an independent stack (SAD §5.3).
 * Tab state is preserved (`unmountOnBlur` false), so drafts and scroll
 * positions survive tab switches.
 *
 * GROUP-LEVEL GUARD (SAD §5.5, layer 1): redirects when the session is not
 * authenticated. This handles navigation, not security — the server stays
 * the only real enforcement layer.
 */
export default function AppLayout() {
  const status = useAuthStore(selectSessionStatus);
  const { colors } = useTheme();

  if (status !== 'authenticated') {
    return <Redirect href="/(auth)/login" />;
  }

  const screenOptions = {
    headerShown: true,
    headerTintColor: colors.onSurface,
    headerTitleStyle: { color: colors.onSurface },
    headerStyle: { backgroundColor: colors.surface },
    tabBarActiveTintColor: colors.primary,
    tabBarInactiveTintColor: colors.onSurfaceVariant,
    tabBarStyle: {
      backgroundColor: colors.surfaceContainer,
      borderTopColor: colors.outlineVariant,
    },
    lazy: false,
  };

  return (
    <Tabs screenOptions={screenOptions}>
      <Tabs.Screen name="home" options={tabScreen('Home', 'home', 'home-outline')} />
      <Tabs.Screen name="expenses" options={tabScreen('Expenses', 'receipt', 'receipt-outline')} />
      <Tabs.Screen name="payments" options={tabScreen('Payments', 'wallet', 'wallet-outline')} />
      <Tabs.Screen name="community" options={tabScreen('Community', 'people', 'people-outline')} />
      <Tabs.Screen name="more" options={tabScreen('More', 'settings', 'settings-outline')} />
    </Tabs>
  );
}

function tabScreen(
  title: string,
  focusedIcon: IoniconsName,
  unfocusedIcon: IoniconsName,
): TabScreenOptions {
  return {
    title,
    tabBarIcon: ({ focused, color, size }) => (
      <Ionicons name={focused ? focusedIcon : unfocusedIcon} color={color} size={size} />
    ),
  };
}
