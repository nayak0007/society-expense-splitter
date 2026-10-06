import { Inject, Injectable, Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import {
  Expense,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  InvalidTransitionError,
  asExpenseError,
  canOnResource,
  expenseError,
  isExpenseEditableStatus,
  isUsableIdempotencyKey,
  memberSnapshotOf,
  normaliseIdempotencyKey,
} from "@ses/domain";
import type {
  Clock,
  ExpenseEvent,
  ExpenseEventPublisher,
  ExpenseId,
  ExpenseMemberNameReader,
  ExpenseMembershipReader,
  ExpensePublication,
  ExpenseRepository,
  ExpenseSplitRepository,
  SocietyId,
  UserId,
} from "@ses/domain";
import { computeSplit } from "@ses/split-engine";

import { MEMBERSHIP_READER } from "../../../../common/authorization/membership-reader";
import {
  assertAllAssignable,
  persistableAllocations,
} from "../expense-allocation.support";
import { toAppError } from "../expense-category-error.mapper";
import {
  EXPENSE_CLOCK,
  EXPENSE_EVENT_PUBLISHER,
  EXPENSE_MEMBER_NAME_READER,
  EXPENSE_REPOSITORY,
  EXPENSE_SPLIT_REPOSITORY,
} from "../expense.tokens";
import { ParticipantResolverService } from "../participant-resolver.service";
import {
  loadExpenseOrNotFound,
  loadMembershipOrNotFound,
  unwrap,
} from "./expense-draft.support";
import {
  buildSplitInput,
  fromSplitError,
  resolveSplitPlan,
  verifyConservation,
} from "./preview-split.use-case";
import type { PreviewSplitConfig } from "./preview-split.use-case";

/**
 * Publication — Roadmap T066, PRD §3.4/§3.5, SAD §3.2.
 *
 * ## The authoritative recomputation
 *
 * T064's preview *prices* a split; this door **publishes** one, and it does not
 * inherit a single number from a preview. Between a preview and a publish the roster
 * can move (a tenant leaves, a flat's owner is recorded), a category's flags can
 * change, and the draft can be edited — so everything this use case computes from is
 * read **at publish time, from the persisted row and the current society state**:
 *
 * ```
 * publish(actor, societyId, expenseId, { expectedVersion, idempotencyKey })
 *   ├─ usable Idempotency-Key                                    (SAD §7.7 — mandatory)
 *   ├─ membership, then canOnResource("expense.publish", stored record)
 *   ├─ the persisted expense (never a client copy: amount, status, version,
 *   │   category, strategy, basis, splitConfig, participantSelector)
 *   ├─ a replay that already succeeded for this key              (no recomputation)
 *   ├─ lifecycle and version preconditions                       (fail fast)
 *   ├─ resolveParticipantsForExpense(...)                        (T063 — the resolver)
 *   ├─ refuse while any billable flat has nobody to charge       (see below)
 *   ├─ buildSplitInput → computeSplit → verifyConservation       (T064's own path)
 *   ├─ Expense.reconstitute(...).publish(allocations, clock)     (T061 — the machine)
 *   ├─ the participant snapshots (one bounded name read)
 *   ├─ ExpenseSplitRepository.publish(...)                       (one transaction)
 *   └─ dispatch the raised event — **after** the transaction, and never fatally
 * ```
 *
 * The calculation path is *the same code* the preview calls — `resolveSplitPlan`,
 * `buildSplitInput`, `computeSplit`, `verifyConservation` are imported, not
 * re-implemented. There is one algorithm with two consumers, which is what makes
 * "preview output == published output for identical input" a structural property
 * rather than a coincidence two implementations have to maintain.
 *
 * ## Unassigned participants: publication fails closed
 *
 * T063 flags a billable flat with nobody to address the charge to
 * (`unassigned_no_owner` under an owner-only category with no owner membership,
 * `unassigned_no_member` for a flat nobody is linked to). PRD §3.5.4 says what such a
 * charge *is* — "the due attaches to the apartment and shows as 'unassigned' in the
 * Treasurer's queue" — but no contract in this repository can carry it: the engine's
 * participant identity is required (`SplitParticipant.memberId`, T059), the aggregate
 * requires a member per split (`ExpenseSplitAllocation`, T061), and `dues.member_id`
 * is `NOT NULL` in the PRD's own DDL and in T060's table. The only ways to publish
 * anyway would be to **drop** the flat, **redistribute** its share onto the others,
 * **fabricate** a member, or publish a participant set that is **short** of the one
 * the selector resolved — every one of them a silent wrong bill, and the four things
 * T063 chose flagging over.
 *
 * So publication is **refused** while any resolved participant is unassigned: a
 * `unassigned_participants` error naming the flats and their reasons, which the
 * treasurer fixes by recording the owner (a shadow member needs no login — PRD §3.3)
 * or by excluding the flats from the selector. Nothing is lost and no money policy is
 * invented: the expense stays a draft and the same request succeeds once the roster
 * is complete. The decision, the documents it rests on and the alternatives are
 * recorded in the T066 report; the refusal is the product owner's ruling.
 *
 * ## The transaction boundary is the repository's, and the ordering is this file's
 *
 * The write is one `ExpenseSplitRepository.publish` call: splits, transition and
 * retry record commit together (the repository's docstring shows the transaction).
 * What this file owns is *when* the raised `expense.published` event leaves —
 * **after** that call returns, for a fresh publication only, and with its failure
 * caught and logged. A notification that cannot be sent must never un-publish a bill
 * (SAD §3.2), and a rolled-back publication must never announce itself.
 *
 * ## Dues and balances are created by the transaction, not by this file
 *
 * Since T067 the same `expense_publish()` transaction writes the receivable half:
 * one principal `dues` row per persisted split (paisa for paisa, with the due date
 * the migration documents) and the set-based `member_balances` upsert, all before
 * the commit this method waits on. The contract here is unchanged — the request and
 * the response are exactly T066's — and the orchestration deliberately does not
 * move into the application: nothing in this file reads a balance, computes a due
 * or writes either table, so there is no second publication path and no
 * `SELECT balance → JS → UPDATE` to race. The database's own deferred triggers
 * (`chk_split_total()`, `trg_due_billable_write`) judge the committed state.
 *
 * ## What this use case deliberately does not do
 *
 *  - **No revisions.** Editing a published expense writes `expense_revisions` —
 *    T068's recalculation flow.
 *  - **No approval policy of its own.** T070 owns the approval gate (ADR-0011 D4),
 *    and it lives *inside the database*, not here: `expense_publish()` reads the
 *    society's **current** `approval_threshold_paise` after locking the expense and
 *    refuses an at-or-above-threshold publication that is not `pending_approval`
 *    with both approval stamps, raising `APPROVAL_REQUIRED` before any financial
 *    write. The `BEFORE UPDATE` guard re-asserts the same rule for every other
 *    writer. This use case therefore adds no second threshold read and no duplicated
 *    rule — the authoritative answer is the transaction's, and an application-side
 *    copy could only disagree with it. A refused publication arrives here as
 *    `ExpenseError('approval_required')` and is mapped to `409 APPROVAL_REQUIRED`.
 */
@Injectable()
export class PublishExpenseUseCase {
  private readonly logger = new Logger(PublishExpenseUseCase.name);

  constructor(
    @Inject(EXPENSE_REPOSITORY)
    private readonly expenses: ExpenseRepository,
    @Inject(EXPENSE_SPLIT_REPOSITORY)
    private readonly splits: ExpenseSplitRepository,
    @Inject(EXPENSE_MEMBER_NAME_READER)
    private readonly names: ExpenseMemberNameReader,
    @Inject(EXPENSE_EVENT_PUBLISHER)
    private readonly events: ExpenseEventPublisher,
    @Inject(EXPENSE_CLOCK)
    private readonly clock: Clock,
    @Inject(MEMBERSHIP_READER)
    private readonly memberships: ExpenseMembershipReader,
    private readonly participants: ParticipantResolverService,
  ) {}

  /** Publishes one expense, or answers the publication an earlier key produced. */
  async publish(
    actor: UserId,
    societyId: SocietyId,
    expenseId: ExpenseId,
    command: PublishExpenseCommand,
  ): Promise<ExpensePublication> {
    // 1 · The key, before anything is read. Publishing is a money-moving POST
    //     (SAD §7.7), so a caller that cannot state a retry key cannot publish —
    //     and the refusal is a field error the client can act on. The header's
    //     shape is validated by the route's pipe as well (`HeaderParam` +
    //     `idempotencyKeySchema`); this is the use case's own guard for callers
    //     outside the HTTP pipeline. The `field` is the wire header name, the same
    //     spelling the pipe reports and the same convention `SocietyGuard` uses for
    //     `x-society-id`, so the two paths are indistinguishable to a client.
    if (!isUsableIdempotencyKey(command.idempotencyKey)) {
      throw toAppError(
        expenseError(
          "validation",
          `Send an Idempotency-Key header of ${String(IDEMPOTENCY_KEY_MIN_LENGTH)}–${String(IDEMPOTENCY_KEY_MAX_LENGTH)} characters; a retry must be able to name this operation.`,
          { field: "idempotency-key" },
        ),
      );
    }
    const idempotencyKey = normaliseIdempotencyKey(command.idempotencyKey);
    const requestHash = publishRequestHash(expenseId, command.expectedVersion);

    // 2 · Membership and the resource decision. `expense.publish` is a ✅ cell
    //     (Admin/Treasurer, no qualification), so the snapshot's facts are carried
    //     for the same reason every other call site passes them — the decision
    //     function is the one place a role is turned into a permission — but no
    //     rule reads them, and there is deliberately no `NARROWED_ROUTES` entry for
    //     this route (that list is for 🟡 cells).
    const membership = await loadMembershipOrNotFound(
      this.memberships,
      actor,
      societyId,
    );
    const allowed = canOnResource(
      memberSnapshotOf(membership),
      "expense.publish",
      {
        kind: "expense",
        societyId,
        createdByMembershipId: membership.id,
        published: false,
      },
    );
    if (!allowed) {
      throw toAppError(expenseError("forbidden", PUBLISH_FORBIDDEN));
    }

    // 3 · The persisted row is the only description of the expense this path uses:
    //     the id in the URL picks it, and everything else — society, creator,
    //     amount, category, strategy, config, selector, status, version — is read
    //     from it. A cross-society or unknown id is `not_found` (PRD T041).
    const record = await loadExpenseOrNotFound(
      this.expenses,
      actor,
      societyId,
      expenseId,
    );

    // 4 · A retry is answered from the record a *previous* call committed, before
    //     any recomputation: an idempotent replay must not be able to fail because
    //     the roster or the category moved since the original request. The write
    //     path checks again (inside its transaction) for the concurrent case, where
    //     two live requests race and one of them has to lose.
    //
    //     This is deliberately **before** the lifecycle and version preconditions
    //     below, because a successful publication is exactly the state a retry
    //     arrives in: the row is `published` and its version has moved, and both are
    //     facts the original request created rather than reasons to refuse its
    //     retry. Checking them first would make "retry a lost response" — the one
    //     thing SAD §7.7's mandatory key exists for — impossible.
    const replayed = await this.withRepository(
      this.splits.findPublication(
        {
          expectedVersion: command.expectedVersion,
          idempotencyKey,
          requestHash,
        },
        actor,
      ),
    );
    if (replayed !== null) return replayed;

    // 5 · The lifecycle and the lock, checked here so a hopeless request costs no
    //     resolution and no name read. Both are re-checked under the row lock inside
    //     `expense_publish()`: this is the fast refusal, the database's is the one
    //     that cannot be raced. A caller that reached this point with an unseen key
    //     is genuinely asking to publish, so a published or void row is a refusal.
    if (!isExpenseEditableStatus(record.status)) {
      throw toAppError(new InvalidTransitionError(record.status, "published"));
    }
    if (record.version !== command.expectedVersion) {
      throw toAppError(
        versionMismatch(command.expectedVersion, record.version),
      );
    }

    // 6 · The plan comes from the **stored** strategy and basis — a draft always
    //     carries both when the strategy needs one (T065's create/edit ran the same
    //     `resolveSplitPlan`) — so no category default is consulted here, and a
    //     stored `apartment` row without a basis is a field error rather than a
    //     guess. The category is still read by the resolver below, for
    //     `is_owner_only`.
    const plan = await unwrap(
      resolveSplitPlan(
        {
          amountPaise: record.amount.paise,
          selector: record.participantSelector,
          splitStrategy: record.splitStrategy,
          apartmentBasis: record.apartmentBasis,
          // The stored `jsonb`. `buildSplitInput` reads it structurally and
          // defensively (an absent or odd value yields the strategy's own defaults),
          // and `valueEntries` re-validates every reference against the *resolved*
          // participants — which is what makes a stale `splitConfig` a refusal
          // instead of a share attached to a flat nobody is charging.
          splitConfig: record.splitConfig as PreviewSplitConfig | undefined,
        },
        null,
      ),
    );

    // 7 · Resolution — T063's use case, called once. Owner routing, vacancy,
    //     eligibility and ordering are all decided there; nothing here re-derives
    //     them, and the selector is re-validated from the stored `jsonb` through the
    //     same `createParticipantSelector` path the wire uses.
    const resolution = await this.participants.resolve(actor, societyId, {
      selector: record.participantSelector,
      categoryId: record.categoryId,
    });

    // 8 · Fail closed while a billable flat has nobody to charge. Before the
    //     engine runs: there is no honest amount to compute for such a flat, and the
    //     refusal must not depend on arithmetic.
    assertAllAssignable(resolution.unassigned);

    // 9 · The engine input, the engine, and conservation — T064's exported path,
    //     unchanged. `amountPaise` is the row's exact bigint.
    const input = await unwrap(
      buildSplitInput(
        resolution,
        plan,
        record.amount.paise,
        record.splitConfig as PreviewSplitConfig | undefined,
      ),
    );
    const computed = computeSplit(input);
    if (!computed.ok) throw toAppError(fromSplitError(computed.error));
    const verified = await unwrap(verifyConservation(computed.value));

    // 10 · T061's machine on the persisted row: it re-checks the transition, the
    //      exact sum, and raises `expense.published`. Nothing about the expense is
    //      written by the entity — the repository persists what it returned.
    const expense = await unwrap(
      Expense.reconstitute({
        id: record.id,
        societyId: record.societyId,
        categoryId: record.categoryId,
        title: record.title,
        amount: record.amount,
        expenseDate: record.expenseDate,
        createdBy: record.createdBy,
        status: record.status,
        splits: [],
        publishedAt: record.publishedAt,
        voidedAt: record.voidedAt,
        voidedBy: record.voidedBy,
        voidReason: record.voidReason,
        // T070's workflow stamps travel with the row so the rebuilt aggregate is a
        // faithful read. `publish()` does not consult them: the approval gate is the
        // database's, evaluated against the *current* threshold inside
        // `expense_publish()` under the row lock (ADR-0011 D4), which is the only
        // place it cannot be raced or forged.
        approvedBy: record.approvedBy,
        approvedAt: record.approvedAt,
        rejectedBy: record.rejectedBy,
        rejectedAt: record.rejectedAt,
        rejectionReason: record.rejectionReason,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        version: record.version,
      }),
    );
    const events = await unwrap(
      expense.publish(verified.allocations, this.clock),
    );

    // 11 · The persist payload: the engine's allocations, the resolver's routing
    //      reason, and the participant snapshot. One bounded name read — never one
    //      per participant.
    const allocations = await persistableAllocations(
      this.names,
      actor,
      societyId,
      verified.allocations,
      resolution.participants,
      plan.strategy,
    );

    // 12 · One transaction: splits, the transition and the retry record. After this
    //      returns, the bill has committed — never before.
    const publication = await this.withRepository(
      this.splits.publish(
        expenseId,
        societyId,
        {
          expectedVersion: command.expectedVersion,
          idempotencyKey,
          requestHash,
          allocations,
        },
        actor,
      ),
    );

    // 13 · Post-commit, fresh-only, and non-fatal.
    if (!publication.replayed) {
      await this.dispatchAfterCommit(events, expenseId, societyId);
    }

    return publication;
  }

  /**
   * A repository call in the module's HTTP vocabulary.
   *
   * `ExpenseSplitRepository` refuses in the *domain*'s vocabulary — the port's
   * docstring promises `not_found`, `forbidden`, `invalid_transition`,
   * `version_mismatch`, `split_mismatch` and `idempotency_key_reuse` as
   * `ExpenseError`s, and `ExpenseSplitRepositoryPostgres` classifies every SQLSTATE
   * into exactly those. Something has to turn them into the `AppError` the filter
   * renders, and the use case is the only layer that knows both vocabularies: without
   * this, a refused publish would answer `500 INTERNAL` — the one translation the
   * whole error catalogue exists to prevent. The same seam every T065 loader keeps
   * (`loadExpenseOrNotFound` and friends), applied to the two calls that go straight
   * to the port.
   */
  private async withRepository<T>(pending: Promise<T>): Promise<T> {
    try {
      return await pending;
    } catch (error: unknown) {
      throw toAppError(asExpenseError(error));
    }
  }

  /**
   * Dispatch, after the transaction, without letting a failure undo the bill.
   *
   * The catch is the whole point of the method: SAD §3.2's "a failed notification
   * never rolls back the bill" is only true if something swallows the failure, and
   * the place that knows the bill is already committed is this one. The log line
   * carries the ids so an operator can find what was not announced.
   */
  private async dispatchAfterCommit(
    events: readonly ExpenseEvent[],
    expenseId: ExpenseId,
    societyId: SocietyId,
  ): Promise<void> {
    if (events.length === 0) return;
    try {
      await this.events.dispatch(events);
    } catch (error: unknown) {
      this.logger.warn(
        `expense.event.dispatch_failed society=${societyId} expense=${expenseId} events=${events
          .map((event) => event.name)
          .join(
            ",",
          )} reason=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/** What the route hands the use case (the header travels separately). */
export interface PublishExpenseCommand {
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
}

/** One wording, so the refusal cannot drift between the route and this file. */
export const PUBLISH_FORBIDDEN =
  "Only a society Admin or Treasurer can publish an expense.";

/** The request hash a reused key is compared against — SAD §7.7's "different body". */
export function publishRequestHash(
  expenseId: ExpenseId,
  expectedVersion: number,
): string {
  return createHash("sha256")
    .update(
      `POST /v1/expenses/${expenseId}/publish\nexpectedVersion=${String(expectedVersion)}`,
    )
    .digest("hex");
}

/** The optimistic-lock refusal, in T065's shape (SAD §7.11's own example). */
function versionMismatch(
  expectedVersion: number,
  currentVersion: number,
): ReturnType<typeof expenseError> {
  return expenseError(
    "version_mismatch",
    "This expense was changed by someone else. Reload it and try again.",
    { field: "expectedVersion", expectedVersion, currentVersion },
  );
}
