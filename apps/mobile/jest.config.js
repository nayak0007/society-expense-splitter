/**
 * Jest for `@ses/mobile` — the React Native component-test harness (SAD §15.3, Roadmap T073).
 *
 * ## Why `jest-expo`
 *
 * The workspace's other packages spread `@ses/config/jest-preset/*`, whose transform is SWC
 * and whose environment is plain Node. A React Native *component* test needs more: the RN
 * platform shims, the `react-native` preset's `transformIgnorePatterns` (RN, Expo and NativeWind
 * ship untranspiled sources in `node_modules`), and NativeWind's className → style transform,
 * which runs through `babel-preset-expo` from `babel.config.js`. `jest-expo` supplies exactly
 * those, so this config composes it rather than re-deriving it.
 *
 * ## The workspace packages are mapped to source
 *
 * `@ses/domain`, `@ses/contracts` and the rest resolve to their `src/index.ts` here, so a test
 * run never needs the packages built first — the same reasoning the API's Jest configs record.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  preset: 'jest-expo',
  displayName: 'ses/mobile',

  // Loads the EXPO_PUBLIC_* values `src/constants/config.ts` validates at module load, before
  // any module is imported. The values are synthetic — nothing here reaches a network.
  setupFiles: ['<rootDir>/jest.env.js'],

  // RNTL matchers and the native-module mocks (MMKV, secure store) every suite needs.
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],

  testMatch: ['**/__tests__/**/*.test.ts', '**/__tests__/**/*.test.tsx'],

  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@ses/domain$': '<rootDir>/../../packages/domain/src/index.ts',
    '^@ses/contracts$': '<rootDir>/../../packages/contracts/src/index.ts',
    '^@ses/application$': '<rootDir>/../../packages/application/src/index.ts',
    '^@ses/split-engine$': '<rootDir>/../../packages/split-engine/src/index.ts',
    '^@ses/db-schema$': '<rootDir>/../../packages/db-schema/src/index.ts',
  },

  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    '!src/**/__tests__/**',
    '!src/**/__fixtures__/**',
  ],
  clearMocks: true,
};
