import { Injectable, Logger } from "@nestjs/common";
import type { ExpenseEvent, ExpenseEventPublisher } from "@ses/domain";

/**
 * The dispatch seam's shipped binding — Roadmap T066, SAD §3.2.
 *
 * ## What it is, and what it deliberately is not
 *
 * It **is** the place a committed publication's event leaves the request: the use
 * case calls it strictly after the publishing transaction has returned, for a fresh
 * publication only, and swallows its failure so a notification can never un-publish
 * a bill. It is **not** the event bus: SAD §3.2's orchestrator, the job queue and the
 * dedupe by `(eventId, userId, channel)` are T107's, and inventing a queue here would
 * ship an untested transport for a consumer that does not exist yet.
 *
 * What ships today is the honest minimum: each event is recorded on the application
 * log, one line per event, with the ids an operator needs to reconcile "the bill was
 * published" against "nobody was told". Replacing this class with the queue's
 * producer changes one binding in `expenses.module.ts` and no caller — the ordering
 * guarantee, which is the part the acceptance criteria are about, lives in
 * `PublishExpenseUseCase` and does not move.
 */
@Injectable()
export class LoggingExpenseEventPublisher implements ExpenseEventPublisher {
  private readonly logger = new Logger(LoggingExpenseEventPublisher.name);

  /** Records each event. Never throws for a log line; T107 owns real delivery. */
  dispatch(events: readonly ExpenseEvent[]): Promise<void> {
    for (const event of events) {
      this.logger.log(
        `expense.event dispatched name=${event.name} society=${event.societyId} expense=${event.expenseId} occurredAt=${event.occurredAt}`,
      );
    }
    return Promise.resolve();
  }
}
