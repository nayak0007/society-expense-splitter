import type { SocietyRepository } from '@ses/domain';

import { SupabaseSocietyRepository } from './society.repository.supabase';

/**
 * Feature composition root: the single place that decides which
 * `SocietyRepository` implementation the app uses.
 *
 * **Supabase is the default since the society schema landed**
 * (`supabase/migrations/2026092013*.sql`): the app is already Supabase-backed for
 * auth, so a society that lives only on one device has no reason left to exist.
 * Reads and writes go through the RLS-protected tables and the functions in
 * `20260920130200_society_rpc.sql` — see the adapter's own header for why RLS, and
 * not this layer, is the security boundary.
 *
 * The other two implementations of the same port stay available:
 *
 *  - `MockSocietyRepository` — device-local, MMKV-persisted, no network. Useful
 *    for working on the UI without a project, and for tests. It is deliberately
 *    *not* imported here, so it stays out of the bundle until something asks for
 *    it: `setSocietyRepository(new MockSocietyRepository())` from a dev menu or a
 *    test setup.
 *  - the API-backed adapter (Roadmap T040, `features/society/api/society.api.ts`)
 *    — the end state, where `/societies` owns the rules and the mobile client is
 *    one of two consumers. It is a one-line swap here; no service, hook or screen
 *    changes, because they only ever see the port
 *    (`packages/domain/src/society/ports.ts`).
 */
let instance: SocietyRepository | null = null;

export function getSocietyRepository(): SocietyRepository {
  instance ??= new SupabaseSocietyRepository();
  return instance;
}

/** Test/tooling seam — inject a fake, the mock or the API repository. */
export function setSocietyRepository(repository: SocietyRepository | null): void {
  instance = repository;
}
