import { Stack, useLocalSearchParams } from 'expo-router';

import AttachmentViewerScreen from '@/features/expenses/screens/AttachmentViewerScreen';

/**
 * The attachment viewer route — PRD screen #34 (Roadmap T076).
 *
 * Presented as a modal, so closing it returns to the bill list it was opened from rather
 * than pushing a viewer onto the expense stack. The id is the only parameter, and the
 * screen never receives an object key or a URL: the bytes are fetched through the
 * authorised download route from inside the screen.
 */
export default function AttachmentViewerRoute() {
  const params = useLocalSearchParams<{ id?: string }>();

  return (
    <>
      <Stack.Screen options={{ presentation: 'modal', title: 'Bill' }} />
      <AttachmentViewerScreen attachmentId={params.id ?? null} />
    </>
  );
}
