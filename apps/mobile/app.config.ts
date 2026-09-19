import type { ExpoConfig } from 'expo/config';

/**
 * Typed, validated app config. Replaces the static app.json so environment-
 * driven values resolve per channel (Roadmap T009).
 *
 * Naming per docs: name "Society Expense Splitter", slug
 * `society-expense-splitter`, deep-link scheme `societyexpense`
 * (PRD §3.2: societyexpense://join?code=XXXXXX).
 */

const trims = (v: string | undefined): string | undefined =>
  v === undefined ? undefined : v.trim();

const raw = {
  apiUrl: trims(process.env.EXPO_PUBLIC_API_URL),
  razorpayKeyId: trims(process.env.EXPO_PUBLIC_RAZORPAY_KEY_ID),
  sentryDsn: trims(process.env.EXPO_PUBLIC_SENTRY_DSN),
  posthogKey: trims(process.env.EXPO_PUBLIC_POSTHOG_KEY),
};

/**
 * The only four variables allowed to ship in the client bundle (SAD §19.2).
 * Everything else belongs in EAS Secrets and must never be prefixed
 * EXPO_PUBLIC_. Optional for now — validated in src/constants/config.ts at
 * module load when the API client starts consuming them.
 */
const EXPO_PUBLIC_VARS = {
  EXPO_PUBLIC_API_URL: raw.apiUrl,
  EXPO_PUBLIC_RAZORPAY_KEY_ID: raw.razorpayKeyId,
  EXPO_PUBLIC_SENTRY_DSN: raw.sentryDsn,
  EXPO_PUBLIC_POSTHOG_KEY: raw.posthogKey,
} as const;

const appConfig: ExpoConfig = {
  name: 'Society Expense Splitter',
  slug: 'society-expense-splitter',
  scheme: 'societyexpense',
  version: '1.0.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'automatic',
  backgroundColor: '#ffffff',
  // Splash is configured via the expo-splash-screen config plugin when the
  // screen/splash design phase lands (SDK 57 removed the top-level splash key).
  ios: {
    supportsTablet: true,
    bundleIdentifier: 'com.societyexpensesplitter.app',
  },
  android: {
    package: 'com.societyexpensesplitter.app',
    adaptiveIcon: {
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
      backgroundColor: '#E6F4FE',
    },
  },
  web: {
    bundler: 'metro',
    favicon: './assets/favicon.png',
  },
  experiments: {
    typedRoutes: true,
  },
  plugins: ['expo-router'],
  extra: {
    ...EXPO_PUBLIC_VARS,
    eas: {
      projectId: '00000000-0000-0000-0000-000000000000',
    },
  },
  _internal: {
    isDebug: false,
  },
};

export default appConfig;
export { EXPO_PUBLIC_VARS };
