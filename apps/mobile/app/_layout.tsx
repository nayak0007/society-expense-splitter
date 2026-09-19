import '../global.css';

import { AppProviders, RootNavigator, RootStatusBar } from './providers/app-providers';

/**
 * Root layout — a thin composition of the global providers (React Query +
 * SafeArea) and the root navigator (SAD §4.2: this file stays under 20 lines;
 * providers and navigation structure live in app/providers/).
 */
export default function RootLayout() {
  return (
    <AppProviders>
      <RootNavigator />
      <RootStatusBar />
    </AppProviders>
  );
}
