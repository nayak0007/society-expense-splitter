import type { SocietyRepository } from '@ses/domain';

import { ApiSocietyRepository } from './society.repository.api';

/**
 * Feature composition root: the single place that decides which
 * `SocietyRepository` implementation the app uses.
 *
 * **The API is the default since `/v1/societies` gained the two membership
 * reads**, which was the last thing standing between this app and a single
 * transport. Reads and writes now go through the NestJS API, which owns the
 * rules, applies them over the same `@ses/application` use cases this app could
 * call locally, and reaches the database under the caller's own RLS identity.
 * Supabase is still the infrastructure — it is where the session comes from and
 * where the data lives — but it is no longer an API the app calls directly, so the
 * anon key in the bundle can no longer be pointed at PostgREST to walk the schema.
 *
 * The REST adapter that used to be here is gone rather than kept behind a flag.
 * Two live implementations of one port is how a client and a server start
 * disagreeing: whichever one the flag did not select stops being exercised, and
 * the divergence only shows up in production. The mock stays because it is not a
 * second transport — it is offline storage, with no network and no rules of its
 * own, which is what makes it useful for UI work and tests.
 *
 * `MockSocietyRepository` is deliberately *not* imported here, so it stays out of
 * the bundle until something asks for it:
 * `setSocietyRepository(new MockSocietyRepository())` from a dev menu or a test
 * setup.
 */
let instance: SocietyRepository | null = null;

export function getSocietyRepository(): SocietyRepository {
  instance ??= new ApiSocietyRepository();
  return instance;
}

/** Test/tooling seam — inject a fake, the mock, or a stub. */
export function setSocietyRepository(repository: SocietyRepository | null): void {
  instance = repository;
}
