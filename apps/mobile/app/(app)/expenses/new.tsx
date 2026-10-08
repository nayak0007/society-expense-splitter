import ExpenseFormScreen from '@/features/expenses/screens/ExpenseFormScreen';

/**
 * Record an expense — PRD screen #27's create door (Roadmap T074).
 *
 * A route file is deliberately this thin: the screen owns the form, and the route exists so the
 * path is `/expenses/new` (deep-linkable, and reachable from the ledger's New action). Nothing is
 * passed in — the mode is derived from the absence of an `id`, so the two doors cannot be confused
 * by a caller.
 */
export default function NewExpenseRoute() {
  return <ExpenseFormScreen />;
}
