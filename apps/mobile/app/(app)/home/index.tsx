import { PlaceholderScreen } from '@/components/layout/PlaceholderScreen';

/** Home tab root — dashboard arrives with the expenses/payments features. */
export default function Home() {
  return (
    <PlaceholderScreen
      title="Home"
      description="Dues summary, notices and quick actions will live here."
      links={[['Expenses tab', '/(app)/expenses']]}
    />
  );
}
