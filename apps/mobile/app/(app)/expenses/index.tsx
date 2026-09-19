import { PlaceholderScreen } from '@/components/layout/PlaceholderScreen';

/** Expenses tab root — the expense list arrives in Phase 4. */
export default function Expenses() {
  return (
    <PlaceholderScreen
      title="Expenses"
      description="The society ledger will live here."
      links={[['Payments tab', '/(app)/payments']]}
    />
  );
}
