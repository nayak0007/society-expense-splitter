import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';

import { RequirePermission } from '@/components/layout/RequirePermission';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ErrorScreen } from '@/components/ui/ErrorScreen';
import { LoadingIndicator } from '@/components/ui/LoadingIndicator';
import { Text } from '@/components/ui/Text';
import { MemberRoleCard } from '@/features/members/components/MemberRoleCard';
import {
  useReactivateMember,
  useRemoveMember,
  useSuspendMember,
} from '@/features/members/hooks/use-member-actions';
import { useMember } from '@/features/members/hooks/use-members';
import {
  MEMBER_OCCUPANCY_LABELS,
  MEMBER_ROLE_LABELS,
  MEMBER_STATUS_LABELS,
} from '@/features/members/schemas/member.schemas';
import { memberErrorMessage } from '@/features/members/services/member.service';

/**
 * One member — the details screen, and the two lifecycle actions that live on it (PRD §3.3:
 * suspend and guarded soft removal).
 *
 * ## Suspend and reactivate are one control
 *
 * The button offers the transition that is *available*, not both: a member who is active can
 * be suspended, a suspended member can be reactivated, and a button that offered "Suspend" on
 * an already-suspended row would be a no-op the user has to reason about. Removal is separate
 * and destructive, so it is behind a confirmation *on this screen* rather than a second route —
 * the member's name is already on screen, which is what makes the confirmation meaningful.
 *
 * ## Nothing here decides who may act
 *
 * Every control reads the capabilities the use case returned with the row: `canEdit` for the
 * edit route, `canSuspend` for suspend/reactivate, `canRemove` for removal. They come from the
 * domain's evaluation of *the caller's own* membership against the same matrix the API's
 * `PermissionGuard` and the RLS policies read, so a hidden button and a refused request cannot
 * disagree (SAD §9.3).
 *
 * ## What is withheld is said, not omitted
 *
 * When the member has not consented to share contact details, the screen renders that sentence
 * rather than an empty field. `phone: null` alone would be ambiguous between "not recorded" and
 * "not shared", and the domain answers which it is (`contactVisible`) precisely so a screen does
 * not have to guess.
 *
 * ## The role section is a component, not more of this file
 *
 * T046's role management (the picker, revocation and the role's permission list) lives in
 * `MemberRoleCard`, which owns its own mutations and errors. Keeping it out of this screen is not
 * tidiness: the card is the same control wherever a membership is shown, and this file's job —
 * reading one member and gating the lifecycle actions on capabilities — stays readable.
 */
export default function MemberDetailScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ memberId?: string }>();
  const memberId = params.memberId ?? null;

  const { member, capabilities, isLoading, error, refetch } = useMember(memberId);
  const suspend = useSuspendMember(memberId);
  const reactivate = useReactivateMember(memberId);
  const remove = useRemoveMember(memberId);
  const [isConfirmingRemove, setIsConfirmingRemove] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  if (isLoading) {
    return <LoadingIndicator message="Loading member…" />;
  }

  if (member === null) {
    return (
      <ErrorScreen
        title="Member not available"
        description={
          error != null
            ? memberErrorMessage(error)
            : 'This member may have been removed. Check the directory for the current roster.'
        }
        retryLabel="Reload"
        onRetry={refetch}
      />
    );
  }

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setActionError(null);
    try {
      await action();
    } catch (caught: unknown) {
      setActionError(memberErrorMessage(caught));
      setIsConfirmingRemove(false);
    }
  };

  const flat = member.apartment;
  const canSuspend = capabilities?.canSuspend === true;
  const isSuspended = member.status === 'inactive';

  return (
    <View className="flex-1 bg-surface">
      <Stack.Screen options={{ title: member.displayName }} />
      <RequirePermission action="member.view" authorized={capabilities?.canView ?? true}>
        <ScrollView>
          <View className="gap-4 p-lg">
            <Card variant="filled">
              <View className="gap-2">
                <Text variant="headlineSmall">{member.displayName}</Text>
                <Text variant="bodyMedium" color="onSurfaceVariant">
                  {`${MEMBER_ROLE_LABELS[member.role]} · ${MEMBER_STATUS_LABELS[member.status]}`}
                </Text>
                <Text variant="bodySmall" color="onSurfaceVariant">
                  {flat === null
                    ? 'No flat recorded'
                    : `${flat.buildingName === null ? '' : `${flat.buildingName} · `}${flat.number}${
                        flat.floor === null ? '' : ` · floor ${String(flat.floor)}`
                      }`}
                </Text>
              </View>
            </Card>

            <Card variant="outlined">
              <View className="gap-2">
                <Text variant="titleSmall">Contact</Text>
                <Field
                  label="Phone"
                  value={member.contactVisible ? (member.phone ?? 'Not recorded') : 'Not shared'}
                />
                <Field
                  label="Email"
                  value={member.contactVisible ? (member.email ?? 'Not recorded') : 'Not shared'}
                />
                <Field
                  label="Contact sharing"
                  value={
                    member.shareContact
                      ? 'Shared with other residents'
                      : 'Private — managers and the member only'
                  }
                />
              </View>
            </Card>

            <Card variant="outlined">
              <View className="gap-2">
                <Text variant="titleSmall">Occupancy</Text>
                <Field label="Occupancy" value={MEMBER_OCCUPANCY_LABELS[member.occupancy]} />
                <Field
                  label="Primary occupant"
                  value={member.isPrimary ? 'Yes — this flat is addressed to them' : 'No'}
                />
                <Field label="Lease starts" value={member.leaseStart ?? 'Not recorded'} />
                <Field label="Lease ends" value={member.leaseEnd ?? 'Not recorded'} />
              </View>
            </Card>

            <Card variant="outlined">
              <View className="gap-2">
                <Text variant="titleSmall">Membership</Text>
                <Field
                  label="Account"
                  value={
                    member.userId === null
                      ? 'None yet — they will be matched by phone when they sign up'
                      : 'Linked to a signed-in account'
                  }
                />
                <Field label="Joined" value={member.joinedAt ?? 'Not recorded'} />
                <Field
                  label="Removed"
                  value={member.removedAt === null ? 'Still a member' : member.removedAt}
                />
              </View>
            </Card>

            {/*
              Both halves of the role section are gated by the same capability today: changing a
              role and reading one member's permissions are the two sides of role management, and
              the API refuses the second to anyone but the member themselves or an Admin. The
              member reads their own on the permissions screen, which needs no member id — so this
              card never has to guess whether "you" is on screen.
            */}
            <MemberRoleCard
              memberId={member.id}
              role={member.role}
              canChangeRoles={capabilities?.canChangeRoles === true}
              canViewPermissions={capabilities?.canChangeRoles === true}
            />

            {actionError !== null ? (
              <Text variant="bodyMedium" color="error">
                {actionError}
              </Text>
            ) : null}

            {capabilities?.canEdit === true ? (
              <Button
                variant="tonal"
                onPress={() =>
                  router.push({
                    pathname: '/(app)/more/members/[memberId]/edit',
                    params: { memberId: member.id },
                  })
                }
              >
                Edit details
              </Button>
            ) : null}

            {canSuspend ? (
              <Button
                variant="outlined"
                loading={suspend.isPending || reactivate.isPending}
                onPress={() =>
                  void run(() => (isSuspended ? reactivate.mutateAsync() : suspend.mutateAsync()))
                }
              >
                {isSuspended ? 'Reactivate membership' : 'Suspend membership'}
              </Button>
            ) : null}

            {capabilities?.canRemove === true ? (
              <Card variant="outlined">
                <View className="gap-3">
                  <Text variant="titleSmall" color="error">
                    Remove from the society
                  </Text>
                  <Text variant="bodySmall" color="onSurfaceVariant">
                    They disappear from the directory and can no longer act in this society. Their
                    flat and every record they are part of are kept — money already recorded is
                    never deleted.
                  </Text>

                  {isConfirmingRemove ? (
                    <View className="gap-2">
                      <Button
                        variant="filled"
                        loading={remove.isPending}
                        onPress={() => void run(() => remove.mutateAsync())}
                      >
                        {`Remove ${member.displayName}`}
                      </Button>
                      <Button variant="text" onPress={() => setIsConfirmingRemove(false)}>
                        Keep them
                      </Button>
                    </View>
                  ) : (
                    <Button variant="outlined" onPress={() => setIsConfirmingRemove(true)}>
                      Remove member…
                    </Button>
                  )}
                </View>
              </Card>
            ) : null}
          </View>
        </ScrollView>
      </RequirePermission>
    </View>
  );
}

/** A label/value row — this screen shows read-only facts, so a form control would be wrong. */
function Field({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <View className="flex-row items-start justify-between gap-4">
      <Text variant="bodyMedium" color="onSurfaceVariant">
        {label}
      </Text>
      <View className="flex-1">
        <Text variant="bodyMedium" align="right">
          {value}
        </Text>
      </View>
    </View>
  );
}
