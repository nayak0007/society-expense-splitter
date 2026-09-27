import {
  createApartment as createApartmentUseCase,
  deleteApartment as deleteApartmentUseCase,
  getApartment as getApartmentUseCase,
  listApartments as listApartmentsUseCase,
  updateApartment as updateApartmentUseCase,
} from '@ses/application';
import type { ApartmentList, ApartmentView } from '@ses/application';
import { createApartmentSchema, updateApartmentSchema } from '@ses/contracts';
import type { CreateApartmentPayload, UpdateApartmentPayload } from '@ses/contracts';
import {
  asApartmentId,
  asBuildingId,
  asSocietyId,
  asUserId,
  isStructureError,
  StructureError,
} from '@ses/domain';
import type { Apartment, Result } from '@ses/domain';
import type { ZodError } from 'zod';

import { structureDeps } from '../repository/structure.deps';

/**
 * Apartment service — the app's adapter over the flat application layer.
 *
 * The same three responsibilities the building service holds, and nothing else:
 * wire-shape validation against the shared contract, `Result` → throw, and
 * dependency wiring through `structureDeps()`. The use cases reach the network
 * through the `ApartmentRepository` port, which on this platform is the API — so
 * "no direct Supabase data access" is not a convention here, it is the only
 * implementation that exists.
 *
 * Nothing in this file re-implements a capability check: `canManage`, `canView` and
 * the "a building with flats cannot be removed" rule all run inside the use cases,
 * against the domain's own evaluator (SAD §9.3).
 */

function unwrap<TValue>(result: Result<TValue, StructureError>): TValue {
  if (!result.ok) throw result.error;
  return result.value;
}

function firstIssueMessage(error: ZodError): string {
  return error.issues[0]?.message ?? 'Please check the details and try again.';
}

/** The flats of one building, with the caller's capabilities (PRD §2 screen 73). */
export async function loadApartments(
  actorId: string,
  societyId: string,
  buildingId: string,
): Promise<ApartmentList> {
  return unwrap(
    await listApartmentsUseCase(
      structureDeps(),
      asUserId(actorId),
      asSocietyId(societyId),
      asBuildingId(buildingId),
    ),
  );
}

export async function loadApartment(
  actorId: string,
  societyId: string,
  apartmentId: string,
): Promise<ApartmentView> {
  return unwrap(
    await getApartmentUseCase(
      structureDeps(),
      asUserId(actorId),
      asSocietyId(societyId),
      asApartmentId(apartmentId),
    ),
  );
}

export async function createApartment(
  actorId: string,
  societyId: string,
  buildingId: string,
  payload: CreateApartmentPayload,
): Promise<Apartment> {
  const parsed = createApartmentSchema.safeParse(payload);
  if (!parsed.success) {
    throw new StructureError('validation', firstIssueMessage(parsed.error));
  }

  return unwrap(
    await createApartmentUseCase(
      structureDeps(),
      asUserId(actorId),
      asSocietyId(societyId),
      asBuildingId(buildingId),
      parsed.data,
    ),
  );
}

export async function updateApartment(
  actorId: string,
  societyId: string,
  apartmentId: string,
  patch: UpdateApartmentPayload,
): Promise<Apartment> {
  const parsed = updateApartmentSchema.safeParse(patch);
  if (!parsed.success) {
    throw new StructureError('validation', firstIssueMessage(parsed.error));
  }

  return unwrap(
    await updateApartmentUseCase(
      structureDeps(),
      asUserId(actorId),
      asSocietyId(societyId),
      asApartmentId(apartmentId),
      parsed.data,
    ),
  );
}

/**
 * Error → copy the UI can render.
 *
 * `StructureError` messages are written for users and are rendered verbatim;
 * anything else is an unexpected failure and gets a safe generic line rather than a
 * raw `Error.message` that could name a table or a column.
 *
 * The message for `building_has_apartments` is the one worth reading twice: it is
 * raised on a **building** delete, and its text ("this building still has 12
 * flats") is produced by the use case with the count it read, so the screen that
 * shows it is the building edit screen — which is why this formatter is exported
 * beside `buildingErrorMessage` rather than kept private.
 */
export function apartmentErrorMessage(error: unknown): string {
  if (isStructureError(error)) return error.message;
  return 'Something went wrong. Please try again.';
}

/** Soft delete. Admin-only, and the use case is what enforces that. */
export async function deleteApartment(
  actorId: string,
  societyId: string,
  apartmentId: string,
): Promise<void> {
  unwrap(
    await deleteApartmentUseCase(
      structureDeps(),
      asUserId(actorId),
      asSocietyId(societyId),
      asApartmentId(apartmentId),
    ),
  );
}
