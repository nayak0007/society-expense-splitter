import {
  asStructureError,
  err,
  generateApartmentNumbers,
  ok,
  structureError,
} from "@ses/domain";
import type {
  BuildingId,
  Result,
  SocietyId,
  StructureError,
  UserId,
} from "@ses/domain";

import { loadBuildingContext, requireStructureCapability } from "./support";
import type { StructureDeps } from "./support";

/**
 * Generate apartments from a numbering pattern, with a dry-run preview
 * (Roadmap T044).
 *
 * The two modes share one expansion pass — `generateApartmentNumbers` in the
 * domain — so the batch the admin previews is provably the batch that gets
 * created. `dryRun: true` performs **no write**: the only I/O is the read that
 * resolves what already exists, which is what makes it a preview rather than a
 * slow import.
 *
 * ## "Existing numbers are skipped and reported", not silently dropped
 *
 * The Roadmap's re-run criterion — "Re-running skips existing and creates only
 * the new" — is a *report* the caller reads, so it is produced here rather than
 * left to storage. A number is skipped when a live flat in this building
 * already carries it: skipped rows come back in the result with their labels,
 * and the created rows carry theirs. The database's partial unique index stays
 * the final word on a collision the read could not see (a concurrent creator
 * landing between the read and the write): `createMany` reports those labels
 * rather than failing the batch, so the answer stays deterministic —
 * one active flat per number, every input accounted for.
 */

export interface GenerateApartmentsWing {
  /** The wing row's id, attached to every flat generated for it. */
  readonly id: string | null;
  /** The label the `{wing}` token renders. */
  readonly label: string;
}

export interface GenerateApartmentsCommand {
  readonly pattern: string;
  /** The floors to expand across, in numbering order. */
  readonly floors: readonly number[];
  /** Flats per floor. */
  readonly unitsPerFloor: number;
  /** Required when the pattern carries `{wing}`. */
  readonly wings?: readonly GenerateApartmentsWing[] | undefined;
  readonly prefix?: string | undefined;
  readonly suffix?: string | undefined;
  /**
   * `true` → report what *would* be created and write nothing.
   * `false` → create everything that does not already exist.
   */
  readonly dryRun: boolean;
}

/** One line of the preview or the result, in generation order. */
export interface GeneratedApartmentOutcome {
  readonly apartmentNumber: string;
  readonly floor: number | null;
  readonly wingId: string | null;
  /** `created` (commit mode only) or `skipped` — a live flat already has the number. */
  readonly status: "created" | "skipped";
}

export interface GenerateApartmentsResult {
  readonly dryRun: boolean;
  readonly total: number;
  readonly createdCount: number;
  readonly skippedCount: number;
  readonly rows: readonly GeneratedApartmentOutcome[];
}

export async function generateApartments(
  deps: StructureDeps,
  actor: UserId,
  societyId: SocietyId,
  buildingId: BuildingId,
  command: GenerateApartmentsCommand,
): Promise<Result<GenerateApartmentsResult, StructureError>> {
  // The parent is the tenancy check: a building of another society is
  // `not_found` before a single label is expanded.
  const loaded = await loadBuildingContext(deps, actor, societyId, buildingId);
  if (!loaded.ok) return loaded;

  const guard = requireStructureCapability(
    loaded.value.capabilities,
    "canManage",
    "Only a society Admin can generate apartments.",
  );
  if (!guard.ok) return guard;

  // ── the one expansion pass, shared by preview and commit ───────────────────
  const expanded = generateApartmentNumbers({
    pattern: command.pattern,
    floors: command.floors,
    unitsPerFloor: command.unitsPerFloor,
    wings: command.wings?.map((wing) => ({ id: wing.id, label: wing.label })),
    prefix: command.prefix,
    suffix: command.suffix,
  });
  if (!expanded.ok) return expanded;

  try {
    // What already exists: one read of the building's live flats, not one
    // query per label — the same N+1 discipline the member import holds.
    const existing = new Set(
      (await deps.apartments.listApartments(buildingId, societyId, actor)).map(
        (apartment) => apartment.apartmentNumber,
      ),
    );

    const rows: GeneratedApartmentOutcome[] = [];

    if (command.dryRun) {
      for (const flat of expanded.value) {
        rows.push({
          ...flat,
          status: existing.has(flat.apartmentNumber) ? "skipped" : "created",
        });
      }
      return ok(summarize(command.dryRun, rows));
    }

    // ── commit: skip what the read saw, then let the batch decide the rest ──
    for (const flat of expanded.value) {
      if (existing.has(flat.apartmentNumber)) {
        rows.push({ ...flat, status: "skipped" });
      }
    }
    const pending = expanded.value.filter(
      (flat) => !existing.has(flat.apartmentNumber),
    );

    const batch = await deps.apartments.createMany(
      buildingId,
      societyId,
      pending.map((flat) => ({
        apartmentNumber: flat.apartmentNumber,
        wingId: flat.wingId,
        floor: flat.floor,
      })),
      actor,
    );

    // A label the index refused (a concurrent creator won the race) is a
    // skipped row, not a failed batch: the report stays complete.
    const raced = new Set(batch.duplicateLabelsSkipped);
    for (const flat of pending) {
      rows.push({
        ...flat,
        status: raced.has(flat.apartmentNumber) ? "skipped" : "created",
      });
    }

    return ok(summarize(command.dryRun, rows));
  } catch (error: unknown) {
    return err(asStructureError(error));
  }
}

function summarize(
  dryRun: boolean,
  rows: readonly GeneratedApartmentOutcome[],
): GenerateApartmentsResult {
  return {
    dryRun,
    total: rows.length,
    createdCount: rows.filter((row) => row.status === "created").length,
    skippedCount: rows.filter((row) => row.status === "skipped").length,
    rows,
  };
}

// Re-exported for the operations layer's typing convenience.
export { structureError };
