import NetInfo from '@react-native-community/netinfo';
import { focusManager, onlineManager } from '@tanstack/react-query';
import type { AppStateStatus } from 'react-native';
import { AppState, Platform } from 'react-native';

/**
 * Wires React Query to React Native's platform events (official RN guide):
 *
 * - `onlineManager` is backed by @react-native-community/netinfo so queries
 *   pause while the device is offline and refetch on reconnect (SAD §6.1:
 *   render from local store first, network second).
 * - `focusManager` is backed by AppState, the RN equivalent of window focus,
 *   so foregrounding the app refetches stale queries.
 *
 * Call once from the root layout. Returns a cleanup function.
 */
export function setupReactQueryNetwork(): () => void {
  // onlineManager defaults to navigator.onLine, which does not exist in RN.
  // setEventListener replaces the listener; NetInfo's own unsubscribe tears
  // the wiring down.
  let unsubscribeNetInfo: (() => void) | undefined;
  onlineManager.setEventListener((setOnline) => {
    unsubscribeNetInfo = NetInfo.addEventListener((state) => {
      setOnline(state.isConnected ?? false);
    });
  });

  const appStateSubscription = AppState.addEventListener('change', (status: AppStateStatus) => {
    if (Platform.OS !== 'web') {
      focusManager.setFocused(status === 'active');
    }
  });

  return () => {
    unsubscribeNetInfo?.();
    appStateSubscription.remove();
  };
}
