import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { ScrollView, View } from 'react-native';

import { RequirePermission } from '@/components/layout/RequirePermission';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ErrorScreen } from '@/components/ui/ErrorScreen';
import { LoadingIndicator } from '@/components/ui/LoadingIndicator';
import { Text } from '@/components/ui/Text';
import { MemberFormFields } from '@/features/members/components/MemberFormFields';
import {
  useReactivateMember,
  useRemoveMember,
  useSuspendMember,
  useUpdateMember,
} from '@/features/members/hooks/use-member-actions';
import { useMember } from '@/features/members/hooks/use-members';
import {
  emptyMemberForm,
  formFieldOfError,
  formValuesToUpdatePayload,
  memberFormResolver,
  memberToFormValues,
} from '@/features/members/schemas/member.schemas';
import type { MemberFormValues } from '@/features/members/schemas/member.schemas';
import { memberErrorMessage } from '@/features/members/services/member.service';
import { useFlatOptions } from '@/features/structure/hooks/use-flat-options';

/**
 * Edit a member, and the two lifecycle actions that never belong in a form
 * (PRD §3.3: suspend, guarded soft removal).
 *
 * ## One screen for the edit and the actions
 *
 * Suspend, reactivate and remove live *inside* the record they change: the user is already
 * looking at the member, the name is on screen, and a second route would be a second place to
 * keep the confirmation copy in step. Removal is guarded by a confirmation *here*, not by a
 * modal route — unlike society deletion, which destroys a tenant (the session, the routing and
 * every cached query change with it) and does navigate the user elsewhere.
 *
 * ## Emptying a field is an edit, not an omission
 *
 * An emptied phone, email, lease date or flat becomes an explicit `null` in the payload
 * (`formValuesToUpdatePayload`). That matters most for the phone: it is a shadow member's only
 * identifier, so "we recorded the wrong number, take it off" has to be expressible. A form that
 * simply omitted an empty field would leave the wrong number on the row and collide with the
 * next attempt to record the right one.
 *
 * ## Nothing here decides who may write
 *
 * `RequirePermission` renders in place of the form for a caller without `member.invite`, and the
 * lifecycle controls are offered only with `canSuspend`/`canRemove`. Both read the domain's
 * evaluated capabilities, and both are *explanations*: the API's `PermissionGuard` and the RLS
 * policies refuse the same operations underneath whatever this screen renders (SAD §5.5, §9.3).
 */
export default function MemberEditScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ memberId?: string }>();
  const memberId = params.memberId ?? null;

  const { member, capabilities, isLoading, error, refetch } = useMember(memberId);
  const updateMember = useUpdateMember(memberId);
  const suspend = useSuspendMember(memberId);
  const reactivate = useReactivateMember(memberId);
  const remove = useRemoveMember(memberId);
  const [isConfirmingRemove, setIsConfirmingRemove] = useState(false);

  const { control, handleSubmit, formState, setError } = useForm<MemberFormValues>({
    resolver: memberFormResolver,
    // `values` (not `defaultValues`) so the form fills in once the fetch lands.
    values: member === null ? emptyMemberForm() : memberToFormValues(member),
  });

  /*
    The flat lookup is read in the route rather than inside the form body: a feature may not
    import another feature's code, and the flat list belongs to the structure feature. The
    building is watched from the same `control`, so the list follows what the user picked — and
    both hooks are called before the early returns, obeying the rules of hooks.
  */
  const buildingId = useWatch({ control, name: 'buildingId' });
  const flatOptions = useFlatOptions(buildingId);

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

  const run = async (action: () => Promise<unknown>): Promise<boolean> => {
    try {
      await action();
      return true;
    } catch (caught: unknown) {
      setError('root', { message: memberErrorMessage(caught) });
      return false;
    }
  };

  /**
   * A failed save goes to the input the server named, when it named one.
   *
   * An emptied phone is the case that matters: `uq_members_shadow_phone` refuses a number
   * another live shadow member already holds, the API reports it with `field: "phone"`, and the
   * user needs it under the field they are editing rather than as a banner they have to
   * interpret.
   */
  const submit = handleSubmit(async (values) => {
    try {
      await updateMember.mutateAsync(formValuesToUpdatePayload(values));
      router.back();
    } catch (caught: unknown) {
      const field = formFieldOfError(caught);
      const message = memberErrorMessage(caught);
      if (field !== undefined) {
        setError(field, { message });
        return;
      }
      setError('root', { message });
    }
  });

  const toggleStatus = async (): Promise<void> => {
    const changed = await run(() =>
      member.status === 'inactive' ? reactivate.mutateAsync() : suspend.mutateAsync(),
    );
    if (changed) router.back();
  };

  const removeMember = async (): Promise<void> => {
    const removed = await run(() => remove.mutateAsync());
    setIsConfirmingRemove(false);
    if (removed) router.back();
  };

  const rootError = formState.errors.root?.message;
  const canEdit = capabilities?.canEdit === true;

  return (
    <View className="flex-1 bg-surface">
      <Stack.Screen options={{ title: member.displayName }} />
      <RequirePermission action="member.invite" authorized={canEdit}>
        <ScrollView keyboardShouldPersistTaps="handled">
          <View className="gap-6 p-lg">
            <Card variant="outlined">
              <View className="gap-3">
                <Text variant="titleSmall">Flat and occupancy</Text>
                <Text variant="bodySmall" color="onSurfaceVariant">
                  A member can be moved between flats, or have their flat cleared when they leave
                  one. Each flat has at most one primary owner and one primary tenant.
                </Text>
              </View>
            </Card>

            <MemberFormFields
              control={control}
              errors={formState.errors}
              flatOptions={flatOptions}
            />

            {rootError !== undefined ? (
              <Text variant="bodyMedium" color="error">
                {rootError}
              </Text>
            ) : null}

            <Button
              variant="filled"
              size="lg"
              loading={updateMember.isPending}
              onPress={() => void submit()}
            >
              Save changes
            </Button>
            <Button variant="text" onPress={() => router.back()}>
              Cancel
            </Button>

            {capabilities?.canSuspend === true ? (
              <Card variant="outlined">
                <View className="gap-3">
                  <Text variant="titleSmall">
                    {member.status === 'inactive' ? 'Reactivate membership' : 'Suspend membership'}
                  </Text>
                  <Text variant="bodySmall" color="onSurfaceVariant">
                    {member.status === 'inactive'
                      ? 'They regain access to the society and appear as an active member again.'
                      : 'They stay on the roster and keep their flat, but cannot act in the society until they are reactivated.'}
                  </Text>
                  <Button
                    variant="outlined"
                    loading={suspend.isPending || reactivate.isPending}
                    onPress={() => void toggleStatus()}
                  >
                    {member.status === 'inactive' ? 'Reactivate' : 'Suspend'}
                  </Button>
                </View>
              </Card>
            ) : null}

            {capabilities?.canRemove === true ? (
              <Card variant="outlined">
                <View className="gap-3">
                  <Text variant="titleSmall" color="error">
                    Remove from the society
                  </Text>
                  <Text variant="bodySmall" color="onSurfaceVariant">
                    They disappear from the directory and can no longer act here. Their history —
                    every expense and payment they are part of — is kept.
                  </Text>

                  {isConfirmingRemove ? (
                    <View className="gap-2">
                      <Button
                        variant="filled"
                        loading={remove.isPending}
                        onPress={() => void removeMember()}
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
