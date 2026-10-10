import { Stack, useLocalSearchParams } from 'expo-router';

import BillScannerScreen from '@/features/expenses/screens/BillScannerScreen';

/**
 * The bill-scanner route — PRD screen #31 (Roadmap T076).
 *
 * A route file this thin on purpose, like `split.tsx` and `participants.tsx`: the screen
 * owns the pickers, the compression and the upload, and the only thing that travels
 * through the URL is the parent expense's id.
 *
 * `expenseId` is **optional**, and the absence is meaningful: `/expenses/scan` reached
 * from the create form has no parent yet, so the screen stages the file instead of
 * uploading it. `/expenses/scan?expenseId=…`, reached from the detail screen or an edit
 * form, uploads against the persisted expense.
 */
export default function ScanRoute() {
  const params = useLocalSearchParams<{ expenseId?: string }>();

  return (
    <>
      <Stack.Screen options={{ title: 'Attach a bill' }} />
      <BillScannerScreen expenseId={params.expenseId ?? null} />
    </>
  );
}
