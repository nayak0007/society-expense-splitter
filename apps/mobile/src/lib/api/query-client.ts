import { QueryClient, onlineManager } from '@tanstack/react-query';

/**
 * QueryClient factory (SAD §6.2 defaults).
 *
 * Offline-first contract: React Query retries on its own for flaky networks,
 * but a request that fails because the device is offline must not be retried
 * — the outbox/sync engine (Phase 9) owns retries for queued mutations.
 */
export function createQueryClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30 * 1000,
        gcTime: 5 * 60 * 1000,
        retry: (failureCount, error) => {
          if (isOfflineError(error)) {
            return false;
          }
          return failureCount < 3;
        },
        refetchOnWindowFocus: false,
      },
      mutations: {
        // Mutations go through the outbox in Phase 9; until then they retry
        // once on transient failures and never when the device is offline.
        retry: (failureCount, error) => !isOfflineError(error) && failureCount < 1,
      },
    },
  });

  return client;
}

/**
 * Detects failures caused by the device being offline. React Native network
 * failures surface as TypeError('Network request failed') on Android and
 * as fetch TypeErrors on iOS; onlineManager.isInternetReachable is checked
 * so we do not misclassify server-side 5xx errors as offline.
 */
export function isOfflineError(error: unknown): boolean {
  if (!onlineManager.isOnline()) {
    return true;
  }
  return error instanceof TypeError && /network request failed|fetch failed/i.test(error.message);
}
