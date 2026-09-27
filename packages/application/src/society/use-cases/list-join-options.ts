import {
  asSocietyError,
  err,
  isValidJoinCode,
  normalizeJoinCode,
  ok,
  societyError,
} from "@ses/domain";
import type {
  Result,
  SocietyError,
  SocietyJoinOptions,
  UserId,
} from "@ses/domain";

import type { SocietyDeps } from "./support";

/**
 * The flats the join screen offers for a code (T049; PRD §3.2's join flow: "preview society
 * → select building/wing/flat from the actual apartment list → declare occupancy").
 *
 * ## Why this is its own use case and not part of the preview
 *
 * `society_join_preview` is reachable **without an identity** (the public
 * `GET /societies/lookup`), and T040's contract for it is "name, city and member count
 * only" — a public endpoint that listed a society's flats would let anyone holding a shared
 * WhatsApp code map the building. The venue is authorised differently, so it is a different
 * read: authenticated, and validated by the code the caller already has.
 *
 * ## What it validates, and what it deliberately leaves alone
 *
 * The code's **shape** — cheap, no I/O, and the same `join_code_invalid` the submission
 * gives — and then the code itself through the repository. **Expiry is not judged here**:
 * `joinSociety` evaluates it against the injected clock, and a code that expires between
 * the options read and the submit has to fail at the submit. One authority for that
 * decision, not two that can disagree by a second.
 */
export interface JoinOptionsQuery {
  /** Free text over flat number and building name; absent means the first page. */
  readonly q?: string | undefined;
  readonly limit?: number | undefined;
}

export async function listJoinOptions(
  deps: SocietyDeps,
  actor: UserId,
  rawCode: string,
  query: JoinOptionsQuery = {},
): Promise<Result<SocietyJoinOptions, SocietyError>> {
  const code = normalizeJoinCode(rawCode);
  if (!isValidJoinCode(code)) {
    return err(
      societyError(
        "join_code_invalid",
        "A join code is 6 characters (no 0, O, 1 or I).",
        { field: "code" },
      ),
    );
  }

  try {
    const options = await deps.repository.joinOptions(
      code,
      {
        ...(query.q === undefined || query.q.trim().length === 0
          ? {}
          : { query: query.q.trim() }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      },
      actor,
    );
    return ok(options);
  } catch (error: unknown) {
    return err(asSocietyError(error));
  }
}
