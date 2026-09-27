import { Stack } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ErrorScreen } from '@/components/ui/ErrorScreen';
import { LoadingIndicator } from '@/components/ui/LoadingIndicator';
import { Text } from '@/components/ui/Text';
import { PermissionList } from '@/features/members/components/PermissionList';
import { useMyPermissions, useRoles } from '@/features/members/hooks/use-permissions';
import { MEMBER_ROLE_LABELS } from '@/features/members/schemas/member.schemas';
import { memberErrorMessage } from '@/features/members/services/member.service';

/**
 * Roles and permissions — T046's visibility screen.
 *
 * Two answers, in the order a person asks them:
 *
 *  1. **What may *I* do here?** From `GET /permissions/me`, which folds the membership's status
 *     in — a suspended member sees an empty list and their status beside it, rather than a refusal
 *     that cannot explain itself. This is the screen that turns a missing button into an
 *     explanation.
 *  2. **What does each role mean?** From the role catalogue, in PRD §2.1's order. It is the
 *     server's own declaration, so it cannot describe a grant the guard would refuse, and it is
 *     readable by every role that may view the directory — the people most likely to need it are
 *     the ones who cannot change anything.
 *
 * The catalogue renders one role at a time, collapsed by default: Admin holds most of the 32
 * actions and a screen that opened with all of them listed would be a wall of text before the
 * caller's own answer is visible. The caller's own role starts expanded, because that is the list
 * they came for.
 *
 * Nothing here decides what the caller may do: every line comes from the server's answer, and the
 * capability summary is the same object the other member screens gate their controls on.
 */
export default function PermissionsScreen() {
  const mine = useMyPermissions();
  const roles = useRoles();
  // `null` means "the default": the caller's own role is the one list they came for, and every
  // other role is a tap away. Once they tap anything, the selection is theirs (and may hold
  // several roles at once, which is how a person compares two).
  const [chosenRoles, setChosenRoles] = useState<readonly string[] | null>(null);

  if (mine.isLoading) {
    return <LoadingIndicator message="Loading your permissions…" />;
  }

  if (mine.view === null) {
    return (
      <ErrorScreen
        title="Permissions not available"
        description={
          mine.error != null
            ? memberErrorMessage(mine.error)
            : 'Your membership in this society could not be read. Try again, or switch society.'
        }
        retryLabel="Retry"
        onRetry={mine.refetch}
      />
    );
  }

  const expandedRoles = chosenRoles ?? [mine.view.role];

  const toggleRole = (role: string, isOpen: boolean): void => {
    setChosenRoles(
      isOpen ? expandedRoles.filter((candidate) => candidate !== role) : [...expandedRoles, role],
    );
  };

  return (
    <View className="flex-1 bg-surface">
      <Stack.Screen options={{ title: 'Roles & permissions' }} />
      <ScrollView>
        <View className="gap-4 p-lg">
          <Card variant="filled">
            <View className="gap-2">
              <Text variant="headlineSmall">{MEMBER_ROLE_LABELS[mine.view.role]}</Text>
              <Text variant="bodySmall" color="onSurfaceVariant">
                Your role in this society. It decides which actions the API and this app will allow
                — nothing on any screen grants more than the server does.
              </Text>
            </View>
          </Card>

          <Card variant="outlined">
            <View className="gap-2">
              <Text variant="titleSmall">What you may do</Text>
              {mine.permissions.length === 0 ? (
                <Text variant="bodySmall" color="onSurfaceVariant">
                  Nothing right now. A pending, suspended or removed membership holds no
                  permissions, whatever its role says — ask an Admin if this is unexpected.
                </Text>
              ) : (
                <PermissionList actions={mine.permissions} emptyMessage="Nothing right now." />
              )}
            </View>
          </Card>

          <Card variant="outlined">
            <View className="gap-2">
              <Text variant="titleSmall">What this screen knows about you</Text>
              <Text variant="bodySmall" color="onSurfaceVariant">
                Capabilities travel with every member read, so a control is only rendered when the
                request behind it would be allowed.
              </Text>
              <View className="gap-1">
                {capabilityLines(mine.view.capabilities).map((line) => (
                  <Text key={line.label} variant="bodySmall" color="onSurfaceVariant">
                    {`${line.allowed ? '✓' : '·'}  ${line.label}`}
                  </Text>
                ))}
              </View>
            </View>
          </Card>

          <View className="gap-3">
            <Text variant="titleSmall">Roles in this society</Text>
            <Text variant="bodySmall" color="onSurfaceVariant">
              Every role and everything it may ever do, in PRD order. Caps apply to Admin (3) and
              Treasurer (2), and nobody may change their own role.
            </Text>

            {roles.isLoading ? (
              <Text variant="bodySmall" color="onSurfaceVariant">
                Loading roles…
              </Text>
            ) : roles.error != null ? (
              <View className="gap-2">
                <Text variant="bodySmall" color="error">
                  {memberErrorMessage(roles.error)}
                </Text>
                <Button variant="outlined" size="sm" onPress={roles.refetch}>
                  Retry
                </Button>
              </View>
            ) : (
              roles.roles.map((definition) => {
                const isOpen = expandedRoles.includes(definition.role);
                return (
                  <Card key={definition.role} variant="outlined">
                    <View className="gap-2">
                      <View className="flex-row items-center justify-between gap-2">
                        <Text variant="titleSmall">{MEMBER_ROLE_LABELS[definition.role]}</Text>
                        <Text variant="labelSmall" color="onSurfaceVariant">
                          {`${String(definition.permissions.length)} actions`}
                        </Text>
                      </View>

                      {isOpen ? (
                        <PermissionList
                          actions={definition.permissions}
                          emptyMessage="This role holds no actions."
                        />
                      ) : null}

                      <Button
                        variant="text"
                        size="sm"
                        onPress={() => toggleRole(definition.role, isOpen)}
                      >
                        {isOpen ? 'Hide' : 'Show actions'}
                      </Button>
                    </View>
                  </Card>
                );
              })
            )}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

/**
 * The capability flags as sentences.
 *
 * Copy, not rules: each line is a boolean the server computed, and the labels are the six things
 * they mean. This is the one place a label is allowed to describe a capability, because the
 * capability's *name* — `canAdd` — is not something a screen should show a user.
 */
function capabilityLines(capabilities: {
  readonly canView: boolean;
  readonly canAdd: boolean;
  readonly canEdit: boolean;
  readonly canSuspend: boolean;
  readonly canRemove: boolean;
  readonly canChangeRoles: boolean;
}): readonly { readonly label: string; readonly allowed: boolean }[] {
  return [
    { label: 'View the member directory', allowed: capabilities.canView },
    { label: 'Add members', allowed: capabilities.canAdd },
    { label: 'Edit member details', allowed: capabilities.canEdit },
    { label: 'Suspend or reactivate members', allowed: capabilities.canSuspend },
    { label: 'Remove members', allowed: capabilities.canRemove },
    { label: 'Assign, change or revoke roles', allowed: capabilities.canChangeRoles },
  ];
}
