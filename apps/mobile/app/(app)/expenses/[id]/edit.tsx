import ExpenseFormScreen from '@/features/expenses/screens/ExpenseFormScreen';

/**
 * Edit an expense — PRD screen #27's edit door (Roadmap T074).
 *
 * `/expenses/[id]/edit` is a sibling of `/expenses/[id]` (the detail), which is why the detail moved
 * to `[id]/index.tsx`: the app's established convention for "a detail screen with sub-routes" is a
 * directory with an index (`more/structure/[buildingId]/{index,edit,new}.tsx`), and T073's flat
 * `[id].tsx` would otherwise be a second shape for the same idea.
 *
 * The screen reads `id` from the route itself (`useLocalSearchParams`) rather than through this
 * file, so the tenant and the row are resolved in exactly one place.
 */
export default function EditExpenseRoute() {
  return <ExpenseFormScreen />;
}
