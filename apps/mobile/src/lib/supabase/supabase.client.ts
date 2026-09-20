import 'react-native-url-polyfill/auto';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';

import { config } from '@/constants/config';

/**
 * Supabase adapter (SAD §1.2 principle 3: "Supabase is infrastructure, not
 * architecture — every Supabase-specific call sits behind an adapter, so the
 * platform is replaceable in weeks rather than being load-bearing").
 *
 * This is the ONLY module in the app allowed to import @supabase/supabase-js.
 * Feature code consumes `src/features/auth/api/auth.api.ts` instead.
 *
 * Tokens live in expo-secure-store — never MMKV or AsyncStorage (SAD §13.5
 * Secure Storage Decision Table). SecureStore values are size-capped (~2 KB),
 * so the documented chunking pattern stores larger session blobs in parts.
 */
class SecureStoreAdapter {
  getItem(key: string): Promise<string | null> {
    return SecureStore.getItemAsync(key);
  }

  async setItem(key: string, value: string): Promise<void> {
    const CHUNK = 2000;
    const parts = Math.ceil(value.length / CHUNK);
    await SecureStore.setItemAsync(key, String(parts));
    for (let i = 0; i < parts; i += 1) {
      await SecureStore.setItemAsync(`${key}-${i}`, value.slice(i * CHUNK, (i + 1) * CHUNK));
    }
  }

  async removeItem(key: string): Promise<void> {
    const partsRaw = await SecureStore.getItemAsync(key);
    if (partsRaw !== null) {
      const parts = Number.parseInt(partsRaw, 10);
      if (!Number.isNaN(parts)) {
        for (let i = 0; i < parts; i += 1) {
          await SecureStore.deleteItemAsync(`${key}-${i}`);
        }
      }
    }
    await SecureStore.deleteItemAsync(key);
  }
}

let client: SupabaseClient | null = null;

/** Lazily-created singleton so import order never matters. */
export function getSupabaseClient(): SupabaseClient {
  client ??= createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: {
      storage: new SecureStoreAdapter(),
      autoRefreshToken: true,
      // Session persistence: tokens survive restarts via SecureStore.
      persistSession: true,
      // Native app — the session never arrives through window.location.
      detectSessionInUrl: false,
    },
  });
  return client;
}

/** Current session or null. Thin adapter helper for the auth API slice. */
export async function getSupabaseSession() {
  const { data, error } = await getSupabaseClient().auth.getSession();
  if (error !== null) throw error;
  return data.session;
}
