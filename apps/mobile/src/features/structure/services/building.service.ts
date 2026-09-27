import {
  createBuilding as createBuildingUseCase,
  deleteBuilding as deleteBuildingUseCase,
  getBuilding as getBuildingUseCase,
  listBuildings as listBuildingsUseCase,
  updateBuilding as updateBuildingUseCase,
} from '@ses/application';
import type { BuildingList, BuildingView } from '@ses/application';
import { createBuildingSchema, updateBuildingSchema } from '@ses/contracts';
import type { CreateBuildingPayload, UpdateBuildingPayload } from '@ses/contracts';
import { asBuildingId, asSocietyId, asUserId, isStructureError, StructureError } from '@ses/domain';
import type { Building, Result } from '@ses/domain';
import type { ZodError } from 'zod';

import { structureDeps } from '../repository/structure.deps';

/**
 * Structure service — the app's adapter over the building application layer.
 *
 * The same three responsibilities the society service holds, and nothing else:
 *
 *  1. **Wire-shape validation** against the shared contract, so the rule applied
 *     here is the rule the API applies.
 *  2. **`Result` → throw.** Use cases return `Result` because a library must not
 *     decide how a caller reports failure; the app's hooks are written against
 *     thrown `StructureError`s, so the conversion happens once, here.
 *  3. **Dependency wiring** — the repository and the membership reader are
 *     resolved per call, never imported by the use cases, which is what keeps
 *     `@ses/application` free of any dependency on this app.
 *
 * There are no session side effects to keep, unlike the society service: a
 * building is not a tenant, so nothing about routing or the active society changes
 * when one is created or removed. That absence is the point — it is why this file
 * is shorter.
 *
 * Every capability check — `canManage`, `canView` — runs **inside** the use cases,
 * against the domain's own evaluator. Nothing here re-implements one from a role
 * string, so a hidden button and a rejected request cannot disagree (SAD §9.3).
 *
 * The dependencies come from `repository/structure.deps.ts` rather than being
 * assembled here, because `deleteBuilding` counts the building's flats through the
 * **apartments** port: a `deps` object built from the buildings repository alone
 * would typecheck in this file and fail at the first delete.
 */

/** `Result` → value, or throw. One place, so no screen ever inspects `.ok`. */
function unwrap<TValue>(result: Result<TValue, StructureError>): TValue {
  if (!result.ok) throw result.error;
  return result.value;
}

/**
 * The society's buildings plus the caller's capabilities (PRD §5: structure is
 * the first thing a new society sets up, and it is not a member-facing list).
 *
 * Returns the capabilities with the list rather than leaving the screen to derive
 * them, because that is where they are used: `canManage` decides whether the
 * "Add building" affordance and each row's edit action exist at all.
 */
export async function loadBuildings(actorId: string, societyId: string): Promise<BuildingList> {
  return unwrap(
    await listBuildingsUseCase(structureDeps(), asUserId(actorId), asSocietyId(societyId)),
  );
}

export async function loadBuilding(
  actorId: string,
  societyId: string,
  buildingId: string,
): Promise<BuildingView> {
  return unwrap(
    await getBuildingUseCase(
      structureDeps(),
      asUserId(actorId),
      asSocietyId(societyId),
      asBuildingId(buildingId),
    ),
  );
}

export async function createBuilding(
  actorId: string,
  societyId: string,
  payload: CreateBuildingPayload,
): Promise<Building> {
  const parsed = createBuildingSchema.safeParse(payload);
  if (!parsed.success) {
    throw new StructureError('validation', firstIssueMessage(parsed.error));
  }

  return unwrap(
    await createBuildingUseCase(
      structureDeps(),
      asUserId(actorId),
      asSocietyId(societyId),
      parsed.data,
    ),
  );
}

export async function updateBuilding(
  actorId: string,
  societyId: string,
  buildingId: string,
  patch: UpdateBuildingPayload,
): Promise<Building> {
  const parsed = updateBuildingSchema.safeParse(patch);
  if (!parsed.success) {
    throw new StructureError('validation', firstIssueMessage(parsed.error));
  }

  return unwrap(
    await updateBuildingUseCase(
      structureDeps(),
      asUserId(actorId),
      asSocietyId(societyId),
      asBuildingId(buildingId),
      parsed.data,
    ),
  );
}

/** Soft delete. Admin-only, and the use case is what enforces that. */
export async function deleteBuilding(
  actorId: string,
  societyId: string,
  buildingId: string,
): Promise<void> {
  unwrap(
    await deleteBuildingUseCase(
      structureDeps(),
      asUserId(actorId),
      asSocietyId(societyId),
      asBuildingId(buildingId),
    ),
  );
}

function firstIssueMessage(error: ZodError): string {
  return error.issues[0]?.message ?? 'Please check the details and try again.';
}

/**
 * Error → copy the UI can render.
 *
 * `StructureError` messages are written for users and are rendered verbatim;
 * anything else is an unexpected failure and gets a safe generic line rather than
 * a raw `Error.message` that could name a table or a column.
 */
export function buildingErrorMessage(error: unknown): string {
  if (isStructureError(error)) return error.message;
  return 'Something went wrong. Please try again.';
}
