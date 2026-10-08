/// <reference types="jest" />

/**
 * Pulls `@types/jest`'s globals (`describe`, `it`, `expect`, `jest`, …) into the mobile
 * program. The automatic `node_modules/@types` inclusion is not resolved from the app's
 * `extends` chain here, so the reference is stated once, in a file `tsconfig.json` already
 * includes, rather than repeated as a triple-slash line in every test file.
 */
