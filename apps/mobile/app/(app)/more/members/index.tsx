import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';

import { ChoiceChips } from '@/components/forms/ChoiceChips';
import { RequirePermission } from '@/components/layout/RequirePermission';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorScreen } from '@/components/ui/ErrorScreen';
import { LoadingIndicator } from '@/components/ui/LoadingIndicator';
import { Text } from '@/components/ui/Text';
import { TextInput } from '@/components/ui/TextInput';
import { MemberCard } from '@/features/members/components/MemberCard';
import { useMembers } from '@/features/members/hooks/use-members';
import { MEMBER_STATUS_LABELS } from '@/features/members/schemas/member.schemas';
import { memberErrorMessage } from '@/features/members/services/member.service';
import type { MemberDirectoryFilters } from '@/features/members/services/member.service';
import type { MemberStatus } from '@ses/domain';

/**
 * Member directory (PRD §3.3: a searchable list with flat number, role badge and occupancy).
 *
 * ## Read from the query, decide from the capabilities
 *
 * The screen never looks at a role. `capabilities.canAdd` — evaluated in the domain against
 * the same matrix `PermissionGuard` and the RLS policies use — decides whether the add
 * affordance exists at all (SAD §9.3: a hidden button and a refused request must not be able
 * to disagree). A Guest, or a member whose membership is not active, is stopped by
 * `RequirePermission` before the list renders rather than by a failed request.
 *
 * ## The filters are the server's, not a local `filter()`
 *
 * Search, status and paging are passed to the API and come back as one page plus a total. The
 * alternative — fetching the roster and filtering in memory — is what breaks the moment a
 * society has 400 members, and it is also the version that gets the *count* wrong (a local
 * filter knows how many rows it has, not how many the filter matches).
 *
 * ## `pending` here is browsing; the queue is where decisions happen
 *
 * `pending` is one of the status chips, so an approver can see who is waiting in the same list
 * as everybody else. The *decision* screen is separate (`join-requests`, T049) for two reasons
 * the directory cannot supply: the queue is `member.approve` rather than `member.view`, and each
 * of its rows carries the other members claiming the same flat — the collision PRD §3.2 says to
 * show the Admin rather than auto-reject, which a paginated roster row has no way to display.
 * The button below is the link between the two; it appears only when the capability does.
 *
 * ## The search is debounced, the rows are not blanked
 *
 * A keystroke does not send a request: the term is debounced by a beat, and the previous page
 * stays on screen while the next one lands (`useMembers` keeps the last result as placeholder
 * data). A list that empties on the first character reads as broken, and a request per
 * keystroke is a request per keystroke.
 */
const PAGE_SIZE = 50;

/** The chip list is `all` plus every status — "removed" included, on request (PRD §3.3). */
const STATUS_OPTIONS: readonly { readonly value: string; readonly label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: MEMBER_STATUS_LABELS.active },
  { value: 'pending', label: MEMBER_STATUS_LABELS.pending },
  { value: 'inactive', label: MEMBER_STATUS_LABELS.inactive },
  { value: 'removed', label: MEMBER_STATUS_LABELS.removed },
];

export default function MembersScreen() {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<string>('all');
  const [page, setPage] = useState(0);

  // One beat behind the keyboard. The term the request is made with is separate state, so a
  // request is only sent when typing pauses — not on every character.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // A changed filter invalidates the page number: page 4 of "active" is not page 4 of "all".
  useEffect(() => {
    setPage(0);
  }, [query, status]);

  const filters: MemberDirectoryFilters = {
    ...(query.trim().length === 0 ? {} : { q: query.trim() }),
    ...(status === 'all' ? {} : { status: status as MemberStatus }),
    sort: 'name',
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  };

  const { members, total, capabilities, isLoading, isRefreshing, error, refetch } =
    useMembers(filters);

  if (isLoading) {
    return <LoadingIndicator message="Loading members…" />;
  }

  // Only when there is nothing to show: a failed *refetch* over cached rows keeps the rows on
  // screen, because a stale directory is more useful than an error page.
  if (error != null && members.length === 0) {
    return (
      <ErrorScreen
        title="Could not load members"
        description={memberErrorMessage(error)}
        onRetry={refetch}
      />
    );
  }

  const canAdd = capabilities?.canAdd === true;
  const first = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const last = page * PAGE_SIZE + members.length;
  const canGoBack = page > 0;
  const canGoForward = last < total;
  const filtered = query.trim().length > 0 || status !== 'all';

  const emptyAction = canAdd
    ? {
        actionLabel: 'Add member',
        onAction: () => router.push('/(app)/more/members/new'),
      }
    : {};

  return (
    <View className="flex-1 bg-surface">
      <Stack.Screen options={{ title: 'Members' }} />
      <RequirePermission action="member.view" authorized={capabilities?.canView ?? true}>
        <ScrollView keyboardShouldPersistTaps="handled">
          <View className="gap-3 p-lg">
            <TextInput
              label="Search"
              value={search}
              onChangeText={setSearch}
              helperText="By name, phone number or flat number"
              autoCapitalize="none"
              keyboardType="default"
            />

            <ChoiceChips
              label="Status"
              options={STATUS_OPTIONS}
              value={status}
              onChange={setStatus}
            />

            {capabilities?.canApprove === true ? (
              <Button
                variant="tonal"
                onPress={() => router.push('/(app)/more/members/join-requests')}
              >
                Review join requests
              </Button>
            ) : null}

            {capabilities?.canAdd === true ? (
              <Button variant="tonal" onPress={() => router.push('/(app)/more/members/import')}>
                Import members from CSV
              </Button>
            ) : null}

            {members.length === 0 ? (
              <EmptyState
                icon={<Ionicons name="people-outline" size={48} />}
                title={filtered ? 'No members match' : 'No members yet'}
                description={
                  filtered
                    ? 'Try a different search term or status.'
                    : 'Add the residents of each flat. Somebody who never installs the app can still be recorded and billed.'
                }
                {...(filtered ? {} : emptyAction)}
              />
            ) : (
              <>
                <Text variant="bodySmall" color="onSurfaceVariant">
                  {`Showing ${first}–${last} of ${total}`}
                </Text>

                {members.map((member) => (
                  <MemberCard
                    key={member.id}
                    member={member}
                    onPress={() =>
                      router.push({
                        pathname: '/(app)/more/members/[memberId]',
                        params: { memberId: member.id },
                      })
                    }
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

                {canAdd ? (
                  <View className="mt-2">
                    <Button variant="tonal" onPress={() => router.push('/(app)/more/members/new')}>
                      Add member
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
