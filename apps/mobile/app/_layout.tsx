import '../global.css';

import { AppProviders, RootNavigator, RootStatusBar } from '@/providers/app-providers';

/**
 * Root layout — a thin composition of the global providers (React Query +
 * SafeArea) and the root navigator (SAD §4.2: this file stays under 20 lines;
 * providers and navigation structure live in `src/providers/`).
 *
 * They live in `src/`, not `app/`, because everything under `app/` is a route as
 * far as Expo Router is concerned: a component module there is rejected with
 * "Route … is missing the required default export". Found on the first device
 * run (2026-10-18); the warning was the only clue to why the navigator rendered
 * an empty screen.
 */
export default function RootLayout() {
  return (
    <AppProviders>
      <RootNavigator />
      <RootStatusBar />
    </AppProviders>
  );
}
