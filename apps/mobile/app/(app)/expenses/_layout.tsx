import { Stack } from 'expo-router';

/**
 * Expenses-tab stack (SAD §5.3: each tab owns an independent stack).
 *
 * The list is the entry point; tapping a row pushes the detail on top of it, so the tab bar
 * stays visible and "back" always returns to the ledger. The Tabs screen for `expenses` sets
 * `headerShown: false` — this stack owns the header so the pushed detail gets a back button
 * and its own title.
 */
export default function ExpensesLayout() {
  return <Stack screenOptions={{ headerShown: true, headerBackTitle: 'Expenses' }} />;
}
