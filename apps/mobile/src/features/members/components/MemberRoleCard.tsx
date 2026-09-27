import { ROLE_ORDER } from '@ses/domain';
import type { MemberRole } from '@ses/domain';
import { useState } from 'react';
import { View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Text } from '@/components/ui/Text';

import { useAssignRole, useRevokeRole } from '../hooks/use-role-actions';
import { useMemberPermissions } from '../hooks/use-permissions';
import { MEMBER_ROLE_LABELS } from '../schemas/member.schemas';
import { memberErrorMessage } from '../services/member.service';

import { PermissionList } from './PermissionList';

/**
 * The role section of a member's detail screen (T046).
 *
 * ## The picker is on this screen, not behind a route
 *
 * A role change is a decision about the member whose name is already on the screen, and the
 * screen is where the consequences are visible (their permissions, listed right below). A
 * separate route would put a navigation between the decision and the outcome — and the two
 * dialogs the task named are this control: *Assign role* when the member holds nothing special,
 * *Change role* once they do, one list either way.
 *
 * ## What the caller may do comes from capabilities, never from comparing roles
 *
 * `canChangeRoles` is the domain's evaluation of the caller's own membership against the same
 * matrix the API's `PermissionGuard` reads. A screen that checked `role === 'admin'` would be a
 * second copy of the rule, and its failure mode is a visible control over a refused request.
 *
 * ## Revocation is offered as its own action
 *
 * Shown only when the member holds a role above the default, and phrased as what it does — return
 * them to `resident` — because "Revoke" alone reads as removal from the society, which it is not:
 * the row, the flat and the history all stay. PRD §2.3 has it as the Admin's row on the
 * transition table, so it is a governance act rather than a dropdown value.
 */
export function MemberRoleCard({
  memberId,
  role,
  canChangeRoles,
  canViewPermissions,
}: {
  readonly memberId: string;
  readonly role: MemberRole;
  readonly canChangeRoles: boolean;
  readonly canViewPermissions: boolean;
}) {
  const assign = useAssignRole(memberId);
  const revoke = useRevokeRole(memberId);
  const [isPicking, setIsPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only asked for when the caller may read it: the route allows the member themselves and an
  // Admin, and a request that can only produce a 403 is one not to make.
  const permissions = useMemberPermissions(memberId, { enabled: canViewPermissions });

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setError(null);
    try {
      await action();
      setIsPicking(false);
    } catch (caught: unknown) {
      setError(memberErrorMessage(caught));
    }
  };

  return (
    <Card variant="outlined">
      <View className="gap-3">
        <Text variant="titleSmall">Role</Text>
        <Text variant="bodyMedium">{MEMBER_ROLE_LABELS[role]}</Text>
        <Text variant="bodySmall" color="onSurfaceVariant">
          A role belongs to this membership, not to the person&apos;s account: it decides what they
          may do in this society, and the same person may hold a different role elsewhere.
        </Text>

        {error !== null ? (
          <Text variant="bodyMedium" color="error">
            {error}
          </Text>
        ) : null}

        {canChangeRoles ? (
          isPicking ? (
            <View className="gap-2">
              {ROLE_ORDER.map((candidate) => (
                <Button
                  key={candidate}
                  variant={candidate === role ? 'outlined' : 'tonal'}
                  disabled={candidate === role}
                  loading={assign.isPending && assign.variables === candidate}
                  onPress={() => void run(() => assign.mutateAsync(candidate))}
                >
                  {candidate === role
                    ? `${MEMBER_ROLE_LABELS[candidate]} — current role`
                    : `Assign ${MEMBER_ROLE_LABELS[candidate]}`}
                </Button>
              ))}

              {role === 'resident' ? null : (
                <Button
                  variant="outlined"
                  loading={revoke.isPending}
                  onPress={() => void run(() => revoke.mutateAsync())}
                >
                  Revoke the role — return to Resident
                </Button>
              )}

              <Button variant="text" onPress={() => setIsPicking(false)}>
                Cancel
              </Button>
            </View>
          ) : (
            <Button variant="tonal" onPress={() => setIsPicking(true)}>
              Change role…
            </Button>
          )
        ) : null}

        {canViewPermissions ? (
          <View className="gap-2">
            <Text variant="titleSmall">Permissions</Text>
            {permissions.isLoading ? (
              <Text variant="bodySmall" color="onSurfaceVariant">
                Loading permissions…
              </Text>
            ) : (
              <PermissionList
                actions={permissions.permissions}
                emptyMessage="This membership is not active, so its role grants nothing right now."
              />
            )}
          </View>
        ) : null}
      </View>
    </Card>
  );
}
