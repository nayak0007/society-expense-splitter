import { Ionicons } from '@expo/vector-icons';
import { Stack } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';

import { RequirePermission } from '@/components/layout/RequirePermission';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorScreen } from '@/components/ui/ErrorScreen';
import { LoadingIndicator } from '@/components/ui/LoadingIndicator';
import { Text } from '@/components/ui/Text';
import { JoinRequestCard } from '@/features/members/components/JoinRequestCard';
import { useJoinRequests } from '@/features/members/hooks/use-join-requests';
import { memberErrorMessage } from '@/features/members/services/member.service';

/**
 * Join requests — the approval queue (Roadmap T049, PRD §3.2).
 *
 * ## Why this is its own screen and not the directory's `pending` filter
 *
 * The directory's chip answers "who is pending"; this screen answers "what do I do about it".
 * The difference is the `claims`: two people asking for one flat have to be visible *together*,
 * and a paginated directory row carries no such context. The permission differs too — the
 * directory is `member.view` (everyone but a Guest) and the queue is `member.approve` (Admin and
 * Treasurer) — so a Resident browsing the roster is never handed a decision UI. Both facts are
 * the server's: the API's queue read resolves the claims in the same statement as the page and
 * refuses the permission itself, and `RequirePermission` is the route-level mirror of that
 * refusal rather than a second rule.
 *
 * ## The decisions are not optimistic
 *
 * A decision settles the role, the occupancy, the flat and the approval stamps in the database's
 * own function, and the answer that comes back is the only true row. It also has states this
 * screen cannot predict — a request somebody else decided a moment ago is a `409`, not an
 * approved row — so the card shows the refusal (or the row simply leaves, because the queue is
 * invalidated on settle).
 */
const PAGE_SIZE = 50;

export default function JoinRequestsScreen() {
  const [page, setPage] = useState(0);
  const { requests, total, capabilities, isLoading, isRefreshing, error, refetch } =
    useJoinRequests(page);

  if (isLoading) {
    return <LoadingIndicator message="Loading join requests…" />;
  }

  // Only when there is nothing to show: a failed refetch over cached rows keeps the rows on
  // screen, because a stale queue is more useful than an error page.
  if (error != null && requests.length === 0) {
    return (
      <ErrorScreen
        title="Could not load join requests"
        description={memberErrorMessage(error)}
        onRetry={refetch}
      />
    );
  }

  const first = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const last = page * PAGE_SIZE + requests.length;
  const canGoBack = page > 0;
  const canGoForward = last < total;

  return (
    <View className="flex-1 bg-surface">
      <Stack.Screen options={{ title: 'Join requests' }} />
      <RequirePermission action="member.approve" authorized={capabilities?.canApprove ?? true}>
        <ScrollView>
          <View className="gap-3 p-lg">
            {requests.length === 0 ? (
              <EmptyState
                icon={<Ionicons name="person-add-outline" size={48} />}
                title="No requests waiting"
                description="When somebody joins with your society's code they appear here, with the flat they claim, until an Admin or Treasurer decides."
              />
            ) : (
              <>
                <Text variant="bodySmall" color="onSurfaceVariant">
                  {`Showing ${first}–${last} of ${total}`}
                </Text>

                {requests.map((request) => (
                  <JoinRequestCard
                    key={request.member.id}
                    request={request}
                    canChangeRoles={capabilities?.canChangeRoles === true}
                  />
                ))}

                {canGoBack || canGoForward ? (
                  <View className="mt-2 flex-row justify-between gap-3">
                    <Button
                      variant="outlined"
                      disabled={!canGoBack}
                      onPress={() => setPage((current) => Math.max(0, current - 1))}
                    >
                      Previous
                    </Button>
                    <Button
                      variant="outlined"
                      disabled={!canGoForward}
                      onPress={() => setPage((current) => current + 1)}
                    >
                      Next
                    </Button>
                  </View>
                ) : null}
              </>
            )}

            {isRefreshing ? (
              <Text variant="bodySmall" color="outline" align="center">
                Refreshing…
              </Text>
            ) : null}
          </View>
        </ScrollView>
      </RequirePermission>
    </View>
  );
}
