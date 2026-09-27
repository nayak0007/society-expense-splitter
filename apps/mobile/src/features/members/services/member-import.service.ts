import { csvImportPreviewResponseSchema, csvImportResultResponseSchema } from '@ses/contracts';
import type { CsvImportPreviewResponseDto, CsvImportResultResponseDto } from '@ses/contracts';

import { apiRequest } from '@/lib/api/api-client';
import { useAuthStore } from '@/stores/auth.store';
import { useSocietyStore } from '@/stores/society.store';

/**
 * The bulk member import service (Roadmap T048) — the mobile side of the CSV flow.
 *
 * ## The server is the parser
 *
 * The device reads the file to **UTF-8 text** and sends it; the RFC 4180 grammar, the
 * header contract, the row cap and every validation rule run server-side through the
 * same `@ses/domain` code the API route uses. Parsing and persisting on-device would
 * make the client authoritative over memberships, which is exactly backwards — the
 * phone's job here is picking a file, showing the preview and confirming.
 *
 * ## Two calls, one flow
 *
 * `previewImport` (`POST /members/import/preview`) writes nothing; the screen renders
 * its row classifications and the summary, and only after the admin presses Confirm
 * does `importMembers` (`POST /members/import`) run. The response is contract-validated
 * like every other service in this app, so a shape drift fails loudly here rather than
 * rendering half a screen.
 */

const IMPORT_PREVIEW_PATH = 'members/import/preview';
const IMPORT_PATH = 'members/import';

/** One picked file, already read to text by the screen (expo-document-picker + FileReader). */
export interface PickedCsv {
  /** The file's name, for the confirm screen's "importing members.csv" line. */
  readonly fileName: string;
  /** The whole file as UTF-8 text. */
  readonly text: string;
}

function sessionIds(): { actorId: string; societyId: string } {
  const actorId = useAuthStore.getState().user?.id ?? null;
  const societyId = useSocietyStore.getState().activeSocietyId;
  if (actorId === null || societyId === null) {
    throw new Error('Sign in and choose a society first.');
  }
  return { actorId, societyId };
}

/** Validate and classify every row. Side-effect free — the server writes nothing. */
export async function previewMemberImport(file: PickedCsv): Promise<CsvImportPreviewResponseDto> {
  const { societyId } = sessionIds();
  return apiRequest('POST', IMPORT_PREVIEW_PATH, {
    body: { csv: file.text },
    schema: csvImportPreviewResponseSchema,
    societyId,
  });
}

/** The confirmed import. Partial success: per-row failures come back in the result. */
export async function importMembersFromCsv(file: PickedCsv): Promise<CsvImportResultResponseDto> {
  const { societyId } = sessionIds();
  return apiRequest('POST', IMPORT_PATH, {
    body: { csv: file.text },
    schema: csvImportResultResponseSchema,
    societyId,
  });
}

/**
 * Copy per error code, for the row-error list.
 *
 * The server's `message` is already user-facing and is rendered as the detail; this map
 * is the one-line *headline* per code, so a screen groups rows by what the admin must do
 * rather than by raw code. Codes the API added later fall through to the message itself.
 */
const ERROR_HEADLINES: Partial<Record<string, string>> = {
  MISSING_HEADER: 'The header row is wrong',
  UNKNOWN_COLUMN: 'Unexpected column',
  DUPLICATE_COLUMN: 'Column repeated',
  TOO_MANY_ROWS: 'Too many rows',
  RAGGED_ROW: 'Wrong number of columns',
  UNTERMINATED_QUOTE: 'Unclosed quote',
  MISSING_NAME: 'Name missing',
  INVALID_NAME: 'Name not usable',
  MISSING_PHONE: 'Phone missing',
  INVALID_PHONE: 'Phone not usable',
  INVALID_EMAIL: 'Email not usable',
  INVALID_OCCUPANCY: 'Occupancy not recognised',
  FORMULA_LIKE_NAME: 'Name looks like a formula',
  FORMULA_LIKE_EMAIL: 'Email looks like a formula',
  APARTMENT_NOT_FOUND: 'Flat not found',
  APARTMENT_CLAIM_CONFLICT: 'Two rows claim the same flat',
  DUPLICATE_IN_FILE: 'Same phone twice in the file',
  ALREADY_MEMBER: 'Already a member',
  INVITATION_PENDING: 'Invitation still open',
  IMPORT_ROW_FAILED: 'Could not save this row',
};

export function csvErrorHeadline(code: string): string {
  return ERROR_HEADLINES[code] ?? 'This row needs attention';
}
