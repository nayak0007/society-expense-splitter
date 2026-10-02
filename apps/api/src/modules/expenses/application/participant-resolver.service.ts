import { Inject, Injectable } from "@nestjs/common";
import { resolveParticipantsForExpense } from "@ses/application";
import type {
  ExpenseParticipantDeps,
  ResolveExpenseParticipantsCommand,
} from "@ses/application";
import type {
  ExpenseCategoryRepository,
  ExpenseError,
  ExpenseMembershipReader,
  ExpenseParticipantReader,
  ExpenseParticipantResolution,
  ExpenseSocietyReader,
  Result,
  SocietyId,
  UserId,
} from "@ses/domain";

import { MEMBERSHIP_READER } from "../../../common/authorization/membership-reader";
import { toAppError } from "./expense-category-error.mapper";
import {
  EXPENSE_PARTICIPANT_READER,
  EXPENSE_SOCIETY_READER,
} from "./participant.tokens";
import { EXPENSE_CATEGORY_REPOSITORY } from "./expense-category.tokens";

/**
 * The API's participant resolver — the file Roadmap T063 names.
 *
 * **No business rules live here.** Which flats a selector bills, who each charge is
 * addressed to, whether a tenant's share moves to the owner and whether a vacant flat is
 * billed are all decided by `@ses/domain`'s `resolveExpenseParticipants`, composed with
 * the ports by `@ses/application`'s `resolveParticipantsForExpense` — the modules mobile
 * and the worker would call too. This class does the two things that are specific to
 * being a Nest provider:
 *
 *  1. it supplies the dependencies from the container rather than as values;
 *  2. it unwraps `Result` into a value or a thrown `AppError`, so a caller that is a
 *     route (T064's preview) or another use case (T066's publish) never branches on `ok`
 *     itself.
 *
 * ## Why a service rather than the use case directly, and why there is no controller
 *
 * T063's row names this file and `expenses.module.ts`, and no route: resolution is an
 * **internal** service today — the preview (T064) is what exposes it, and publishing
 * (T066) is what persists it. Inventing an endpoint here would be a route nobody asked
 * for, guarded by a permission nobody chose, while both real callers are still
 * unwritten; the wiring in `ExpensesModule` is therefore the whole public surface, and
 * the e2e suite proves the graph resolves.
 *
 * ## The three reads it binds, and why each is where it is
 *
 * ```
 * EXPENSE_PARTICIPANT_READER ──▶ ExpenseParticipantRepositoryPostgres   (this module)
 * EXPENSE_SOCIETY_READER     ──▶ SocietyRepositoryPostgres              (SocietiesModule)
 * EXPENSE_CATEGORY_REPOSITORY ─▶ ExpenseCategoryRepositoryPostgres      (this module, T062)
 * MEMBERSHIP_READER          ──▶ SocietyRepositoryPostgres              (common/, T038)
 * ```
 *
 * The society read is the *borrow* `MEMBERSHIP_READER` already makes: one field
 * (`bill_vacant_flats`) is needed, `SocietyRepositoryPostgres` already answers it under
 * the caller's own identity, and `SocietiesModule` exports that provider — so this
 * module adds an import line rather than a second reader of `society_settings`.
 */
@Injectable()
export class ParticipantResolverService {
  constructor(
    @Inject(EXPENSE_PARTICIPANT_READER)
    private readonly participants: ExpenseParticipantReader,
    @Inject(EXPENSE_SOCIETY_READER)
    private readonly society: ExpenseSocietyReader,
    @Inject(EXPENSE_CATEGORY_REPOSITORY)
    private readonly categories: ExpenseCategoryRepository,
    @Inject(MEMBERSHIP_READER)
    private readonly memberships: ExpenseMembershipReader,
  ) {}

  private get deps(): ExpenseParticipantDeps {
    return {
      participants: this.participants,
      society: this.society,
      categories: this.categories,
      memberships: this.memberships,
    };
  }

  /**
   * Resolves a selector for one society on behalf of one member.
   *
   * `command.selector` is `unknown` because the selector is stored as `jsonb` — the
   * use case validates it — and `command.categoryId` is optional: with it, the
   * category's `is_owner_only` is read and applied (PRD §3.5.4); without it, the
   * selector alone decides.
   */
  async resolve(
    actor: UserId,
    societyId: SocietyId,
    command: ResolveExpenseParticipantsCommand,
  ): Promise<ExpenseParticipantResolution> {
    return unwrap(
      resolveParticipantsForExpense(this.deps, actor, societyId, command),
    );
  }
}

/** Awaits a use case and converts failure into the API's exception. */
async function unwrap<T>(
  pending: Promise<Result<T, ExpenseError>>,
): Promise<T> {
  const result = await pending;
  if (!result.ok) {
    throw toAppError(result.error);
  }
  return result.value;
}
