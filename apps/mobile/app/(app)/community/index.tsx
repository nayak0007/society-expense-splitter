import { PlaceholderScreen } from '@/components/layout/PlaceholderScreen';

/** Community tab root — notices, complaints, visitors arrive in Phase 7. */
export default function Community() {
  return (
    <PlaceholderScreen
      title="Community"
      description="Notices, complaints and visitors will live here."
      links={[['More tab', '/(app)/more']]}
    />
  );
}
