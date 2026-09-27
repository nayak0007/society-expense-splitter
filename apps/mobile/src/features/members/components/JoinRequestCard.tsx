import type { JoinQueueRequest } from '@ses/application';
import { ROLE_ORDER } from '@ses/domain';
import type { MemberRole, MemberView } from '@ses/domain';
import { useState } from 'react';
import { View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Text } from '@/components/ui/Text';
import { TextInput } from '@/components/ui/TextInput';

import { useApproveJoinRequest, useRejectJoinRequest } from '../hooks/use-join-requests';
import {
  MEMBER_OCCUPANCY_LABELS,
  MEMBER_ROLE_LABELS,
  MEMBER_STATUS_LABELS,
} from '../schemas/member.schemas';
import { memberErrorMessage } from '../services/member.service';

/**
 * One pending request on the join queue (T049).
 *
 * ## Both claims are visible, before the decision
 *
 * PRD §3.2's rule is the reason `claims` exists on the response: when two people ask for one
 * flat the Admin sees them together and decides, rather than discovering the collision at the
 * database's `uq_primary_occupant` refusal. The card therefore renders the *other* live members
 * naming the same flat as a distinct block — not a warning badge that hides the detail, and
 * never an automatic rejection. A request with no flat has no claims, which is not a conflict:
 * it is somebody who will be assigned one.
 *
 * ## What the approver sends
 *
 * Absent means "as requested" — the requester's own occupancy and flat — so the confirm step
 * sends nothing but the role. Handing out a role above Resident is `member.role_change` (Admin
 * only), which is why the picker appears only with `canChangeRoles`: a Treasurer may admit a
 * Resident and may not appoint an Admin, and the API refuses either way.
 *
 * ## Rejection carries the reason
 *
 * Inline rather than a system dialog, matching the app's other confirmations. The reason is
 * bounded by the contract's own rule, so a one-word refusal is a field error here instead of a
 * `422` the user has to decode — and the requester is a person waiting for an answer.
 */
export function JoinRequestCard({
  request,
  canChangeRoles,
}: {
  readonly request: JoinQueueRequest;
  /** `capabilities.canChangeRoles` — Admin only, and only this may name a role above Resident. */
  readonly canChangeRoles: boolean;
}) {
  const member = request.member;
  const approve = useApproveJoinRequest(member.id);
  const reject = useRejectJoinRequest(member.id);

  const [mode, setMode] = useState<'idle' | 'approving' | 'rejecting'>('idle');
  const [role, setRole] = useState<MemberRole | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const others = request.claims.filter((claim) => claim.id !== member.id);

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setError(null);
    try {
      await action();
      // The queue is invalidated on settle, so a decided request leaves the list; the card
      // does not need a success state of its own.
    } catch (caught: unknown) {
      setError(memberErrorMessage(caught));
    }
  };

  return (
    <Card variant="outlined">
      <View className="gap-3">
        <View className="gap-1">
          <Text variant="titleMedium">{member.displayName}</Text>
          <Text variant="bodySmall" color="onSurfaceVariant">
            {member.apartment === null
              ? 'No flat chosen — assign one when you approve'
              : `${member.apartment.buildingName} · ${member.apartment.number}`}
            {' · '}
            {MEMBER_OCCUPANCY_LABELS[member.occupancy]}
          </Text>
          <Text variant="bodySmall" color="onSurfaceVariant">
            {member.phone === null
              ? 'Contact not shared'
              : `${member.phone}${member.contactVisible ? '' : ' (visible to managers only)'}`}
          </Text>
        </View>

        {member.requestNote === null ? null : (
          <View className="rounded-card bg-surface-container-low p-3">
            <Text variant="bodySmall" color="onSurfaceVariant">
              Their note
            </Text>
            <Text variant="bodyMedium">{member.requestNote}</Text>
          </View>
        )}

        {others.length > 0 ? (
          <View className="gap-2 rounded-card bg-secondary-container p-3">
            <Text variant="titleSmall">{request.claims.length} people claim this flat</Text>
            {others.map((claim) => (
              <ClaimRow key={claim.id} claim={claim} />
            ))}
            <Text variant="bodySmall" color="onSurfaceVariant">
              Confirm the one who really lives there. The others can still be admitted without being
              the flat&apos;s primary occupant, or rejected with a reason.
            </Text>
          </View>
        ) : null}

        {error !== null ? (
          <Text variant="bodyMedium" color="error">
            {error}
          </Text>
        ) : null}

        {mode === 'approving' ? (
          <View className="gap-2">
            {canChangeRoles ? (
              <>
                <Text variant="bodySmall" color="onSurfaceVariant">
                  Admit as
                </Text>
                <Button
                  variant={role === null ? 'tonal' : 'outlined'}
                  loading={approve.isPending && role === null}
                  onPress={() => void run(() => approve.mutateAsync({}))}
                >
                  {`As requested — ${MEMBER_ROLE_LABELS[member.role]}`}
                </Button>
                {ROLE_ORDER.filter((candidate) => candidate !== member.role).map((candidate) => (
                  <Button
                    key={candidate}
                    variant="outlined"
                    loading={approve.isPending && role === candidate}
                    onPress={() => {
                      setRole(candidate);
                      void run(() => approve.mutateAsync({ role: candidate }));
                    }}
                  >
                    {MEMBER_ROLE_LABELS[candidate]}
                  </Button>
                ))}
              </>
            ) : (
              <Button
                variant="filled"
                loading={approve.isPending}
                onPress={() => void run(() => approve.mutateAsync({}))}
              >
                Approve request
              </Button>
            )}
            <Button variant="text" onPress={() => setMode('idle')}>
              Cancel
            </Button>
          </View>
        ) : null}

        {mode === 'rejecting' ? (
          <View className="gap-2">
            <TextInput
              label="Why is this request refused?"
              value={reason}
              onChangeText={setReason}
              helperText="The requester sees this. Give them something they can act on."
              multiline
              numberOfLines={3}
              maxLength={500}
            />
            <Button
              variant="filled"
              loading={reject.isPending}
              onPress={() => void run(() => reject.mutateAsync(reason))}
            >
              Reject request
            </Button>
            <Button variant="text" onPress={() => setMode('idle')}>
              Cancel
            </Button>
          </View>
        ) : null}

        {mode === 'idle' ? (
          <View className="flex-row gap-2">
            <Button variant="filled" onPress={() => setMode('approving')}>
              Approve
            </Button>
            <Button variant="outlined" onPress={() => setMode('rejecting')}>
              Reject
            </Button>
          </View>
        ) : null}
      </View>
    </Card>
  );
}

/** One other member claiming the same flat — a read row, not a decision of its own. */
function ClaimRow({ claim }: { readonly claim: MemberView }) {
  return (
    <View className="gap-0.5">
      <Text variant="bodyMedium">{claim.displayName}</Text>
      <Text variant="bodySmall" color="onSurfaceVariant">
        {MEMBER_STATUS_LABELS[claim.status]} · {MEMBER_OCCUPANCY_LABELS[claim.occupancy]}
        {claim.apartment === null ? '' : ` · ${claim.apartment.number}`}
      </Text>
      {claim.requestNote === null ? null : (
        <Text variant="bodySmall" color="onSurfaceVariant">
          {claim.requestNote}
        </Text>
      )}
    </View>
  );
}
