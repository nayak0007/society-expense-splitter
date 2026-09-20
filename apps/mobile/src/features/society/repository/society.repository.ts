import type { SocietyRepository } from '@ses/domain';

import { MockSocietyRepository } from './society.repository.mock';

/**
 * Feature composition root: the single place that decides which
 * `SocietyRepository` implementation the app uses.
 *
 * Today: the mock (no `/societies` backend yet — Phase 3 is API-coupled).
 * Tomorrow: swap the returned instance for the HTTP implementation in
 * `features/society/api/society.api.ts` and delete this indirection's
 * comment — no service, hook or screen changes (the port is in
 * `packages/domain/src/society/ports.ts`).
 */
let instance: SocietyRepository | null = null;

export function getSocietyRepository(): SocietyRepository {
  instance ??= new MockSocietyRepository();
  return instance;
}

/** Test/tooling seam — inject a fake or the HTTP repository. */
export function setSocietyRepository(repository: SocietyRepository | null): void {
  instance = repository;
}
