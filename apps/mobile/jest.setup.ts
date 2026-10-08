/**
 * Runs after the test framework is installed, before each suite.
 *
 * The app's stores persist to MMKV (a synchronous Nitro native module) and its session
 * helpers talk to expo-secure-store. Neither has a JS implementation in Jest, so both are
 * replaced with in-memory doubles — the same seam the real modules expose, so a store or a
 * hook that reads through them behaves identically without a device.
 */

jest.mock('react-native-mmkv', () => {
  class MMKV {
    private readonly store = new Map<string, string>();

    set(key: string, value: string): void {
      this.store.set(key, value);
    }

    getString(key: string): string | undefined {
      return this.store.get(key);
    }

    remove(key: string): void {
      this.store.delete(key);
    }

    clearAll(): void {
      this.store.clear();
    }
  }

  return { createMMKV: () => new MMKV(), MMKV };
});

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

/**
 * The Supabase adapter is replaced wholesale: it pulls in `@supabase/supabase-js` and the URL
 * polyfill, neither of which a component test exercises, and the API client is mocked at the
 * seam every test actually uses (a repository stub, or a mocked hook). Nothing in the suite
 * makes a network call.
 */
jest.mock('@/lib/supabase/supabase.client', () => ({
  getSupabaseClient: () => ({
    auth: { refreshSession: async () => ({ data: { session: null } }) },
  }),
  getSupabaseSession: async () => null,
}));
