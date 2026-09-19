import { PlaceholderScreen } from '@/components/layout/PlaceholderScreen';

/** Payments tab root — dues and history arrive in Phase 5. */
export default function Payments() {
  return (
    <PlaceholderScreen
      title="Payments"
      description="Your dues and payment history will live here."
      links={[['Community tab', '/(app)/community']]}
    />
  );
}
