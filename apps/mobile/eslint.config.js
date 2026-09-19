// @ts-check
const preset = require('../../packages/config/eslint-preset/react-native');
const globals = require('globals');

module.exports = [
  ...preset,
  // CommonJS config files at the app root run in Node.
  {
    files: ['*.config.js', '*.config.ts', '*.cjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    ignores: [
      '**/node_modules/**',
      '.expo/**',
      '.expo/types/**',
      'expo-env.d.ts',
      'nativewind-env.d.ts',
      '.turbo/**',
    ],
  },
];
