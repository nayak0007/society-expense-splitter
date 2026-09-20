import { Ionicons } from '@expo/vector-icons';
import { Redirect, Tabs } from 'expo-router';
import type { ComponentProps } from 'react';

import { useTheme } from '@/theme';
import {
  selectIsProfileComplete,
  selectProfileStatus,
  selectSessionStatus,
  useAuthStore,
} from '@/stores/auth.store';
import { selectMemberships, selectSocietiesStatus, useSocietyStore } from '@/stores/society.store';

type IoniconsName = ComponentProps<typeof Ionicons>['name'];

/** Options type derived from expo-router's own Tabs — a single source of truth. */
type TabScreenOptions = NonNullable<ComponentProps<typeof Tabs.Screen>['options']>;

/**
 * Protected group — five tabs, each owning an independent stack (SAD §5.3).
 * Tab state is preserved (`unmountOnBlur` false), so drafts and scroll
 * positions survive tab switches.
 *
 * GROUP-LEVEL GUARD (SAD §5.5, layer 1): redirects when the session is not
 * authenticated, and back to `(setup)` when the session has no usable
 * membership — e.g. the user just left their last society (SAD §5.1
 * "App → Setup: removed from last society"). This handles navigation, not
 * security — the server stays the only real enforcement layer.
 */
export default function AppLayout() {
  const status = useAuthStore(selectSessionStatus);
  const profileStatus = useAuthStore(selectProfileStatus);
  const profileComplete = useAuthStore(selectIsProfileComplete);
  const societiesStatus = useSocietyStore(selectSocietiesStatus);
  const memberships = useSocietyStore(selectMemberships);
  const { colors } = useTheme();

  if (status !== 'authenticated') {
    return <Redirect href="/(auth)/login" />;
  }

  // Onboarding is not finished for a profile the database reports incomplete
  // (SAD §5.2). A fetch *error* is not an incomplete profile, so it falls
  // through — an offline user with a valid session still reaches the app.
  if (profileStatus === 'ready' && !profileComplete) {
    return <Redirect href="/(setup)/profile-setup" />;
  }

  if (societiesStatus === 'ready') {
    if (memberships.length === 0) {
      return <Redirect href="/(setup)/society-choice" />;
    }
    if (memberships.every((membership) => membership.status === 'pending')) {
      return <Redirect href="/(setup)/join-pending" />;
    }
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
      {/* The More tab owns a nested stack (app/(app)/more/_layout.tsx), which
          renders its own header — so the tab header is switched off here. */}
      <Tabs.Screen
        name="more"
        options={{ ...tabScreen('More', 'settings', 'settings-outline'), headerShown: false }}
      />
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
