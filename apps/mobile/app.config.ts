import type { ExpoConfig } from 'expo/config';

/**
 * Typed, validated app config. Replaces the static app.json so environment-
 * driven values resolve per channel (Roadmap T009).
 *
 * Naming per docs: name "Resident 360", slug `resident-360`, deep-link scheme
 * `resident360` (PRD §3.2: resident360://join?code=XXXXXX).
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
  name: 'Resident 360',
  slug: 'resident-360',
  scheme: 'resident360',
  version: '1.0.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'automatic',
  backgroundColor: '#ffffff',
  // Splash is configured via the expo-splash-screen config plugin when the
  // screen/splash design phase lands (SDK 57 removed the top-level splash key).
  ios: {
    supportsTablet: true,
    bundleIdentifier: 'com.resident360.app',
  },
  android: {
    package: 'com.resident360.app',
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
  plugins: [
    'expo-router',
    // T076: the bill scanner captures through the camera, so iOS needs an
    // NSCameraUsageDescription and Android needs CAMERA. Nothing else is
    // requested: the gallery and PDF flows use the OS pickers, which hand back
    // the one chosen item without granting this app the library — hence
    // `photosPermission: false` and `microphonePermission: false`.
    [
      'expo-image-picker',
      {
        cameraPermission:
          'Resident 360 uses the camera so you can photograph a bill or receipt to attach to an expense.',
        photosPermission: false,
        microphonePermission: false,
      },
    ],
  ],
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
