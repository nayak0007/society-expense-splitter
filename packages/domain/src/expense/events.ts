import type { Money } from "../shared/money.vo";
import type { ExpenseId, MemberId, SocietyId } from "../shared/ids";

/**
 * Expense domain events — Roadmap T061, SAD §3.2's "Domain Events".
 *
 * ## Raised, not dispatched
 *
 * A transition returns the events it raised (`publish()` answers with the published
 * event, `void_()` with the voided one) and does nothing else with them. There is no
 * bus here, no queue, no callback: the entity cannot dispatch, because dispatching
 * inside a transaction is the failure mode the SAD names — a notification going out
 * for a bill whose transaction then rolls back. The use case collects the array and
 * the orchestrator dispatches **after commit** (SAD §3.2, T066/T154); this file is
 * the contract those two meet on, not the transport.
 *
 * ## Why plain readonly objects rather than classes
 *
 * The rest of the domain expresses data as interfaces and behaviour as functions
 * (`Invitation`, `Member`, `Society`), and an event is data: it is read, serialised
 * and compared, never asked to behave. Interfaces also make the discriminated union
 * (`ExpenseEvent`) exhaustive for a `switch`, which is exactly how the future event
 * bus will route by `name`.
 */

/** The event names, as the wire will carry them. */
export const EXPENSE_EVENT_NAMES = [
  "expense.published",
  "expense.voided",
] as const;

export type ExpenseEventName = (typeof EXPENSE_EVENT_NAMES)[number];

/**
 * A published expense became billable — SAD §3.2's `ExpensePublished`.
 *
 * `amount` travels with the event because every consumer wants it (a push says
 * "₹4,500 maintenance bill published"); it is the same `Money` the entity holds,
 * exact by construction, and the wire layer converts it with `paiseToWire` at the
 * one permitted crossing point.
 */
export interface ExpensePublishedEvent {
  readonly name: "expense.published";
  readonly expenseId: ExpenseId;
  readonly societyId: SocietyId;
  readonly amount: Money;
  /** ISO-8601 instant, from the injected `Clock` — never `new Date()` inline. */
  readonly occurredAt: string;
}

/**
 * A published expense was voided — SAD §3.2's `ExpenseVoided`.
 *
 * The reason travels because it is the audit record's substance: the row keeps it,
 * and a notification that says "an expense was voided" without saying why would send
 * residents to the app to read the same sentence again. `voidedBy` is the **member**
 * (the row's `voided_by` is a membership, not an account).
 */
export interface ExpenseVoidedEvent {
  readonly name: "expense.voided";
  readonly expenseId: ExpenseId;
  readonly societyId: SocietyId;
  readonly voidedBy: MemberId;
  readonly reason: string;
  readonly occurredAt: string;
}

export type ExpenseEvent = ExpensePublishedEvent | ExpenseVoidedEvent;

/** Constructor for the published event, so the entity and tests agree on the shape. */
export function expensePublishedEvent(
  expenseId: ExpenseId,
  societyId: SocietyId,
  amount: Money,
  occurredAt: string,
): ExpensePublishedEvent {
  return {
    name: "expense.published",
    expenseId,
    societyId,
    amount,
    occurredAt,
  };
}

/** Constructor for the voided event. */
export function expenseVoidedEvent(
  expenseId: ExpenseId,
  societyId: SocietyId,
  voidedBy: MemberId,
  reason: string,
  occurredAt: string,
): ExpenseVoidedEvent {
  return {
    name: "expense.voided",
    expenseId,
    societyId,
    voidedBy,
    reason,
    occurredAt,
  };
}

/** Runtime narrowing for a consumer that received an untyped envelope. */
export function isExpenseEvent(value: unknown): value is ExpenseEvent {
  if (typeof value !== "object" || value === null) return false;
  const name = (value as { readonly name?: unknown }).name;
  return (
    typeof name === "string" &&
    (EXPENSE_EVENT_NAMES as readonly string[]).includes(name)
  );
}
