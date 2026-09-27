import {
  asApartmentId,
  asMemberError,
  err,
  memberError,
  ok,
  parseAndValidateCsv,
  templateCsv,
  toMemberView,
  type CsvImportSummary,
  type CsvMemberRow,
  type CsvRowError,
  type MemberError,
  type MemberView,
  type Result,
  type SocietyId,
  type UserId,
} from "@ses/domain";

import { loadMemberContext, requireMemberCapability } from "./support";

/**
 * Bulk CSV member import (Roadmap T048) — the two operations over the parser:
 *
 *   previewImport   parse → validate → resolve flats → check storage conflicts. **No write.**
 *   importMembers   the same pass, then one direct-add-shaped create per valid row.
 *
 * ## The rules are the direct-add path's rules, replayed per row
 *
 * Field validation runs through the same value objects the form uses
 * (`validateCsvMemberRow` → `createDisplayName`/`createPhone`/`createEmail`/
 * `createMemberOccupancy`), and each import writes through the **same storage method**
 * `addMember` uses (`MemberRepository.create`). What this module deliberately does not
 * grow is a second membership grammar: no role column (role assignment is T046's guarded
 * operation — a CSV column that could mint a Treasurer would be an escalation surface
 * the matrix never granted), no status column (rows import as active residents, which is
 * the only shape the INSERT policy accepts), no update semantics (an import is not an
 * edit; changing an existing member is the directory's PATCH).
 *
 * ## Partial success, not all-or-nothing — the Roadmap decides
 *
 * *"Valid rows import even when others fail; nothing is silently dropped."* A 500-flat
 * society whose file has three typos should not have to re-key 497 rows. The preview
 * shows the admin every row that will fail, and pressing Import after reading it *is*
 * the explicit confirmation. Storage-level refusals after that are per-row failures in
 * the result — and the database's uniqueness constraints are the final word, so a
 * retried import cannot double-create.
 */

/** What one row can be, once the whole pass has spoken. */
export type CsvRowOutcome =
  | {
      readonly status: "valid";
      readonly line: number;
      readonly displayName: string;
      readonly phone: string;
      readonly email: string | null;
      readonly apartmentNumber: string | null;
      /** Resolved only when `apartmentNumber` is set and the flat exists. */
      readonly apartmentId: string | null;
      readonly occupancy: string;
    }
  | {
      readonly status: "invalid";
      readonly line: number;
      readonly error: CsvRowError;
    }
  | {
      readonly status: "conflict";
      readonly line: number;
      readonly error: CsvRowError;
    };

/** The preview: what the admin reads before confirming. */
export interface CsvImportPreview {
  readonly rows: readonly CsvRowOutcome[];
  readonly summary: CsvImportSummary;
  /** The caller's full capability set — the screen renders its affordances from it. */
  readonly capabilities: import("@ses/domain").MemberCapabilities;
}

/** The import result: what happened, per row. */
export interface CsvImportResult {
  readonly summary: CsvImportSummary;
  /** Every created member, redacted exactly like the directory reads. */
  readonly imported: readonly MemberView[];
  /** Per-row failures in file order — nothing silently dropped. */
  readonly failed: readonly {
    readonly line: number;
    readonly error: CsvRowError;
  }[];
  readonly capabilities: import("@ses/domain").MemberCapabilities;
}

export interface CsvImportCommand {
  /** The whole file as UTF-8 text. */
  readonly csv: string;
}

/** One live flat, as far as the import is concerned. */
export interface ImportFlat {
  readonly id: string;
  readonly apartmentNumber: string;
}

/**
 * The reference-data reader for flat resolution.
 *
 * Declared by the module that needs it and satisfied by the structure module's
 * `ApartmentRepository` — the same shape `StructureMembershipReader` uses in the other
 * direction. The import asks one question ("which live flat is `A-101`?") and asks it
 * once per file, not once per row; the reader's own RLS identity (the acting admin's)
 * scopes every answer to this society, so another society's flat is simply not in the
 * index — which is `APARTMENT_NOT_FOUND`, never a cross-tenant read.
 */
export interface ImportApartmentReader {
  /** Every live flat of the society the actor may see. */
  listSocietyFlats(
    societyId: SocietyId,
    actor: UserId,
  ): Promise<readonly ImportFlat[]>;
}

/** A live invitation, as far as the collision check is concerned. */
export interface ImportInvitation {
  readonly email: string | null;
  readonly phone: string | null;
  readonly status: "sent" | "opened" | "accepted" | "expired" | "revoked";
}

/**
 * The invitation list the import's collision check reads — declared here so the API
 * binds the invitations module's repository to a narrow shape rather than the whole
 * invitation port.
 */
export interface ImportInvitationList {
  list(
    societyId: SocietyId,
    actor: UserId,
    query: {
      readonly limit?: number | undefined;
      readonly offset?: number | undefined;
    },
  ): Promise<{ readonly invitations: readonly ImportInvitation[] }>;
}

/** What the import reads beyond the member table. Both ports are optional at the edge. */
export interface BulkImportDeps {
  readonly members: import("@ses/domain").MemberRepository;
  readonly flats?: ImportApartmentReader | undefined;
  readonly invitations?: ImportInvitationList | undefined;
}

const CONTEXT = "Only an Admin or Treasurer can import members.";

/**
 * The preview. Side-effect free with respect to membership state: the only I/O is reads.
 * The row cap and every field rule are the domain parser's, so a client cannot preview
 * one file and import another under the same rules.
 */
export async function previewImport(
  deps: BulkImportDeps,
  actor: UserId,
  societyId: SocietyId,
  command: CsvImportCommand,
): Promise<Result<CsvImportPreview, MemberError>> {
  const loaded = await loadMemberContext(deps, actor, societyId);
  if (!loaded.ok) return loaded;

  const guard = requireMemberCapability(
    loaded.value.capabilities,
    "canAdd",
    CONTEXT,
  );
  if (!guard.ok) return guard;

  const pass = parseAndValidateCsv(command.csv);
  if (!pass.ok) {
    // A fatal header problem: no honest "rows" exist, so the answer is the error list
    // with a zero summary. There is no preview to render beneath it.
    return ok({
      rows: pass.error.map((error) => ({
        status: "invalid" as const,
        line: error.line,
        error,
      })),
      summary: {
        totalRows: 0,
        validRows: 0,
        invalidRows: pass.error.length,
        conflicts: 0,
        skipped: pass.error.length,
        imported: 0,
      },
      capabilities: loaded.value.capabilities,
    });
  }

  const { outcomes, totalRows } = await resolveRows(
    deps,
    actor,
    societyId,
    pass.value.rows,
    pass.value.errors,
  );

  return ok({
    rows: outcomes,
    summary: summarize(
      totalRows,
      countValid(outcomes),
      countConflicts(outcomes),
      0,
    ),
    capabilities: loaded.value.capabilities,
  });
}

/**
 * The import. Same pass as the preview, then a create per valid row. Storage refusals
 * (`uq_members_shadow_phone`, `uq_primary_occupant` — the constraints a concurrent admin
 * or a racing join approval can trigger between preview and import) become per-row
 * failures, not a thrown error: the Roadmap's "nothing silently dropped" is what that
 * buys, and determinism under concurrency is what the constraints buy.
 */
export async function importMembers(
  deps: BulkImportDeps,
  actor: UserId,
  societyId: SocietyId,
  command: CsvImportCommand,
): Promise<Result<CsvImportResult, MemberError>> {
  const loaded = await loadMemberContext(deps, actor, societyId);
  if (!loaded.ok) return loaded;

  const guard = requireMemberCapability(
    loaded.value.capabilities,
    "canAdd",
    CONTEXT,
  );
  if (!guard.ok) return guard;

  const pass = parseAndValidateCsv(command.csv);
  if (!pass.ok) {
    return err(
      memberError(
        "validation",
        "That file could not be read as a member import — fix the header first.",
        {
          field: "csv",
          details: pass.error.map((error) => ({
            field: error.field,
            code: error.code,
            message: error.message,
          })),
        },
      ),
    );
  }

  const { outcomes, totalRows } = await resolveRows(
    deps,
    actor,
    societyId,
    pass.value.rows,
    pass.value.errors,
  );

  const imported: MemberView[] = [];
  const failed: { line: number; error: CsvRowError }[] = [];

  for (const outcome of outcomes) {
    if (outcome.status === "invalid") {
      // In the response, not just the preview: "nothing is silently dropped" is a
      // property of the *result*, so a client that skipped the preview still sees
      // every reason row by row.
      failed.push({ line: outcome.line, error: outcome.error });
      continue;
    }
    if (outcome.status === "conflict") {
      failed.push({ line: outcome.line, error: outcome.error });
      continue;
    }
    try {
      const created = await deps.members.create(
        societyId,
        {
          displayName: outcome.displayName,
          phone: outcome.phone,
          email: outcome.email,
          occupancy: outcome.occupancy as CsvMemberRow["occupancy"],
          apartmentId:
            outcome.apartmentId === null
              ? null
              : asApartmentId(outcome.apartmentId),
          isPrimary: false,
        },
        actor,
      );
      imported.push(toMemberView(loaded.value.viewer, created));
    } catch (error: unknown) {
      failed.push({
        line: outcome.line,
        error: {
          line: outcome.line,
          field: "row",
          code: "IMPORT_ROW_FAILED",
          message: asMemberError(error).message,
        },
      });
    }
  }

  return ok({
    summary: summarize(
      totalRows,
      countValid(outcomes),
      countConflicts(outcomes),
      imported.length,
    ),
    imported,
    failed,
    capabilities: loaded.value.capabilities,
  });
}

/** The template's exact text — the one spelling of the contract, from the domain. */
export function csvImportTemplate(): string {
  return templateCsv();
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

function countValid(outcomes: readonly CsvRowOutcome[]): number {
  return outcomes.filter((outcome) => outcome.status === "valid").length;
}

function countConflicts(outcomes: readonly CsvRowOutcome[]): number {
  return outcomes.filter((outcome) => outcome.status === "conflict").length;
}

/**
 * The Roadmap's arithmetic, stated once: `total = imported + invalid + conflicts`,
 * and `skipped = invalid + conflicts` for a preview (imported 0) or the truth after
 * an import. A row that was valid at preview time and failed at storage time counts
 * as invalid — it was not imported, and the failure list says why.
 */
function summarize(
  totalRows: number,
  validRows: number,
  conflicts: number,
  importedCount: number,
): CsvImportSummary {
  const invalidRows = Math.max(0, totalRows - validRows - conflicts);
  const failedAfterStart = importedCount > 0 ? validRows - importedCount : 0;
  return {
    totalRows,
    validRows,
    invalidRows: invalidRows + failedAfterStart,
    conflicts,
    skipped: invalidRows + conflicts + failedAfterStart,
    imported: importedCount,
  };
}

/**
 * The storage-dependent half: which flat number is which flat, which phone/email is
 * already a member, which contact has an open invitation.
 *
 * Three batched reads for the whole file — one flat listing, one directory page, one
 * invitation page — never one query per row (the Roadmap's own N+1 criterion). Rows are
 * then judged in memory and returned in file order.
 */
async function resolveRows(
  deps: BulkImportDeps,
  actor: UserId,
  societyId: SocietyId,
  rows: readonly CsvMemberRow[],
  fieldErrors: readonly CsvRowError[],
): Promise<{
  readonly outcomes: CsvRowOutcome[];
  readonly totalRows: number;
}> {
  const outcomes: CsvRowOutcome[] = fieldErrors.map((error) => ({
    status: "invalid" as const,
    line: error.line,
    error,
  }));
  const totalRows = fieldErrors.length + rows.length;

  if (rows.length === 0) return { outcomes, totalRows };

  // ── flats: one read, one in-memory index (case-insensitive on the label) ────
  const flatIndex = new Map<string, string>();
  if (deps.flats !== undefined) {
    for (const flat of await deps.flats.listSocietyFlats(societyId, actor)) {
      const key = flat.apartmentNumber.toLowerCase();
      // First live flat wins; a duplicate label across buildings is a structure-level
      // ambiguity the admin resolves by renaming — the import refuses to guess.
      if (!flatIndex.has(key)) flatIndex.set(key, flat.id);
    }
  }

  // ── existing members: one directory page ───────────────────────────────────
  const directory = await deps.members.list(societyId, actor, { limit: 1_000 });
  const memberByPhone = new Map<string, string>();
  const memberByEmail = new Map<string, string>();
  for (const member of directory.members) {
    if (member.status === "removed") continue;
    if (member.phone !== null) memberByPhone.set(member.phone, member.status);
    if (member.email !== null)
      memberByEmail.set(member.email.toLowerCase(), member.status);
  }

  // ── open invitations: one page, matched on the contacts the file offers ────
  const openInvites: ImportInvitation[] =
    deps.invitations === undefined
      ? []
      : (
          await deps.invitations.list(societyId, actor, { limit: 1_000 })
        ).invitations.filter(
          (invitation) =>
            invitation.status === "sent" || invitation.status === "opened",
        );

  for (const row of rows) {
    const flatId =
      row.apartmentNumber === null
        ? null
        : (flatIndex.get(row.apartmentNumber.toLowerCase()) ?? null);
    if (row.apartmentNumber !== null && flatId === null) {
      outcomes.push(
        conflict(
          row.line,
          "flat_no",
          "APARTMENT_NOT_FOUND",
          `No flat numbered ${row.apartmentNumber} exists in this society. Flats are not created by an import.`,
        ),
      );
      continue;
    }

    const byPhone = memberByPhone.get(row.phone);
    if (byPhone !== undefined) {
      outcomes.push(
        conflict(
          row.line,
          "phone",
          "ALREADY_MEMBER",
          byPhone === "pending"
            ? "Someone with that number is already waiting to join. Decide their request in the join queue instead."
            : "A member of this society already has that phone number.",
        ),
      );
      continue;
    }

    if (row.email !== null && memberByEmail.has(row.email.toLowerCase())) {
      outcomes.push(
        conflict(
          row.line,
          "email",
          "ALREADY_MEMBER",
          "A member of this society already has that email address.",
        ),
      );
      continue;
    }

    const invited = openInvites.some(
      (invitation) =>
        (row.email !== null &&
          invitation.email?.toLowerCase() === row.email.toLowerCase()) ||
        (invitation.phone !== null && invitation.phone === row.phone),
    );
    if (invited) {
      outcomes.push(
        conflict(
          row.line,
          row.email !== null ? "email" : "phone",
          "INVITATION_PENDING",
          "An invitation for this person is still open. Revoke it or let them accept it first.",
        ),
      );
      continue;
    }

    outcomes.push({
      status: "valid",
      line: row.line,
      displayName: row.displayName,
      phone: row.phone,
      email: row.email,
      apartmentNumber: row.apartmentNumber,
      apartmentId: flatId,
      occupancy: row.occupancy,
    });
  }

  outcomes.sort((left, right) => left.line - right.line);
  return { outcomes, totalRows };
}

function conflict(
  line: number,
  field: CsvRowError["field"],
  code: CsvRowError["code"],
  message: string,
): CsvRowOutcome {
  return { status: "conflict", line, error: { line, field, code, message } };
}
