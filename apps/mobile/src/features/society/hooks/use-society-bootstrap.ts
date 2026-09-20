import { useEffect } from 'react';

import { useQuery } from '@tanstack/react-query';

import { selectAuthUser, useAuthStore } from '@/stores/auth.store';
import { useSocietyStore } from '@/stores/society.store';

import { loadMemberships } from '../services/society.service';

import { societyKeys } from './society-keys';

/**
 * Loads the signed-in user's memberships once per session and mirrors them
 * into the society store.
 *
 * WHY A BOOTSTRAP HOOK: the resolver (`app/index.tsx`) must decide between
 * `(setup)` and `(app)` before any screen renders (SAD §5.2), so the fetch
 * cannot live inside a screen. It runs from the provider tree instead, and
 * the store it feeds is what routing reads.
 *
 * React Query owns the network lifecycle; the store owns the synchronous
 * routing snapshot. One writer each, no duplication of intent.
 */
export function useSocietyBootstrap(): void {
  const user = useAuthStore(selectAuthUser);
  const userId = user?.id ?? null;
  const setStatus = useSocietyStore((state) => state.setStatus);
  const applyMemberships = useSocietyStore((state) => state.applyMemberships);

  const query = useQuery({
    queryKey: societyKeys.memberships(userId),
    queryFn: () => loadMemberships(userId ?? ''),
    enabled: userId !== null,
  });

  useEffect(() => {
    if (userId === null) {
      setStatus('idle');
      return;
    }
    if (query.isPending) {
      setStatus('loading');
      return;
    }
    if (query.data !== undefined) {
      applyMemberships(query.data);
      return;
    }
    if (query.isError) {
      setStatus('error');
    }
  }, [userId, query.isPending, query.data, query.isError, setStatus, applyMemberships]);
}
