import type { ApartmentRepository } from '@ses/domain';

import { ApiApartmentRepository } from './apartment.repository.api';

/**
 * Apartment repository composition root — the one place that decides which
 * implementation the app uses.
 *
 * **The API is the only implementation, and there is deliberately no mock here.**
 * Same reasoning as the building slice: a local fake would be a second
 * implementation of rules that already live in `@ses/application` and are exercised
 * by the API's e2e suite. Both entry points exist for the same reason the building
 * slice's do — that importing this module must not construct anything, and that a
 * test can swap in a five-line stub without module mocking:
 *
 *     setApartmentRepository(fake);
 */
let apartmentRepository: ApartmentRepository | null = null;

export function getApartmentRepository(): ApartmentRepository {
  apartmentRepository ??= new ApiApartmentRepository();
  return apartmentRepository;
}

/** Test/tooling seam — inject a fake or a stub. */
export function setApartmentRepository(repository: ApartmentRepository | null): void {
  apartmentRepository = repository;
}
