import { useMutation, useQueryClient } from '@tanstack/react-query';

import { selectAuthUser, useAuthStore } from '@/stores/auth.store';
import { selectActiveSocietyId, useSocietyStore } from '@/stores/society.store';

import { importMembersFromCsv, previewMemberImport } from '../services/member-import.service';
import type { PickedCsv } from '../services/member-import.service';

import { memberKeys } from './member-keys';

/**
 * The bulk import's two mutations (T048).
 *
 * ## Neither is optimistic, and there is nothing to be optimistic about
 *
 * An import's outcome is a *summary the server computes* — which rows failed, which
 * conflicted, what landed — and inventing any of it locally would be a lie with a success
 * animation. The preview is a read-shaped call but still a mutation in React Query's
 * terms: it is invoked on demand (file picked), not rendered from a cache key, so it uses
 * `useMutation` like the import does. The screen drives both.
 *
 * ## What is invalidated
 *
 * The whole `member` namespace: an import adds active residents, which changes the
 * directory, the totals and the viewer's own counts — the same invalidation every other
 * member write performs.
 */

function requireScope(
  actorId: string | null,
  societyId: string | null,
): { readonly actorId: string; readonly societyId: string } {
  if (actorId === null) {
    throw new Error('Your session expired. Please sign in again.');
  }
  if (societyId === null) {
    throw new Error('Switch to a society to import its members.');
  }
  return { actorId, societyId };
}

/** The side-effect-free preview: classification of every row, before any write. */
export function usePreviewMemberImport() {
  const actorId = useAuthStore(selectAuthUser)?.id ?? null;
  const societyId = useSocietyStore(selectActiveSocietyId);

  return useMutation({
    mutationFn: (file: PickedCsv) => {
      requireScope(actorId, societyId);
      return previewMemberImport(file);
    },
    // Deliberately no invalidation: the preview writes nothing, so there is nothing
    // to refresh. (Invalidating here would also refetch mid-flow for no reason.)
  });
}

/** The confirmed import. Partial success — the result carries every per-row failure. */
export function useImportMembersFromCsv() {
  const actorId = useAuthStore(selectAuthUser)?.id ?? null;
  const societyId = useSocietyStore(selectActiveSocietyId);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (file: PickedCsv) => {
      requireScope(actorId, societyId);
      return importMembersFromCsv(file);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: memberKeys.all });
    },
  });
}
