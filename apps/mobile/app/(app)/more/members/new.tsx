import { Stack, useRouter } from 'expo-router';
import { useForm, useWatch } from 'react-hook-form';
import { ScrollView, View } from 'react-native';

import { RequirePermission } from '@/components/layout/RequirePermission';
import { Button } from '@/components/ui/Button';
import { LoadingIndicator } from '@/components/ui/LoadingIndicator';
import { Text } from '@/components/ui/Text';
import { MemberFormFields } from '@/features/members/components/MemberFormFields';
import { useAddMember } from '@/features/members/hooks/use-member-actions';
import { useViewer } from '@/features/members/hooks/use-members';
import {
  emptyMemberForm,
  formFieldOfError,
  formValuesToCreatePayload,
  memberCreateResolver,
} from '@/features/members/schemas/member.schemas';
import type { MemberFormValues } from '@/features/members/schemas/member.schemas';
import { memberErrorMessage } from '@/features/members/services/member.service';
import { useFlatOptions } from '@/features/structure/hooks/use-flat-options';

/**
 * Add a member (PRD §3.3: "direct add by Admin (name + phone, creates a *shadow member* with no
 * login until they sign up — essential, since many owners never install the app but must still
 * be billed)").
 *
 * ## The gate is `canAdd`, and its source is the caller's own row
 *
 * `useViewer` reads `GET /members/me` — the one member read that needs no id, which is what a
 * create screen can have. Reading the capability from the caller's own membership rather than
 * from a cached directory means the gate is still right when this screen is reached by a deep
 * link with no list behind it. As everywhere in this app, it is an *explanation*, not the
 * boundary: the API's `PermissionGuard` and the RLS insert policy refuse the same operation
 * underneath whatever this screen renders (SAD §5.5).
 *
 * ## Why the phone is required *here* and not on the edit screen
 *
 * The form body is shared; the resolver is not. `memberCreateResolver` adds the one rule the
 * create contract has and the update contract does not — a shadow member's number is their only
 * identifier, so it cannot be omitted when recording them, and it must be removable when it was
 * wrong. That is one schema plus one refinement rather than two forms that could drift.
 *
 * ## Success goes back rather than forward
 *
 * The server mints the id, so this screen never learns it: there is no detail route to navigate
 * to from here. The list is where the user confirms what was recorded, and it refetches because
 * the mutation invalidates the whole member namespace.
 */
export default function MemberCreateScreen() {
  const router = useRouter();
  const { capabilities, isLoading } = useViewer();
  const addMember = useAddMember();

  const { control, handleSubmit, formState, setError } = useForm<MemberFormValues>({
    resolver: memberCreateResolver,
    defaultValues: emptyMemberForm(),
  });

  /*
    The flat lookup is read **here**, in the route, not inside the form body.

    A feature may not import another feature's code, and the flat list is the structure
    feature's — so the composition belongs to the route, which is the layer allowed to know
    about both. The building comes from the form being watched (`useWatch` on the same
    `control`), which is what makes the list follow the building the user picked.

    Called before the early return, obeying the rules of hooks: a query hook must not be
    skipped on the way to a loading state.
  */
  const buildingId = useWatch({ control, name: 'buildingId' });
  const flatOptions = useFlatOptions(buildingId);

  if (isLoading) {
    return <LoadingIndicator message="Loading members…" />;
  }

  const submit = handleSubmit(async (values) => {
    try {
      await addMember.mutateAsync(formValuesToCreatePayload(values));
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

  const rootError = formState.errors.root?.message;

  return (
    <View className="flex-1 bg-surface">
      <Stack.Screen options={{ title: 'Add member' }} />
      <RequirePermission action="member.invite" authorized={capabilities?.canAdd ?? true}>
        <ScrollView keyboardShouldPersistTaps="handled">
          <View className="gap-6 p-lg">
            <Text variant="bodyMedium" color="onSurfaceVariant">
              Record an occupant directly, whether or not they have an account. Their phone number
              is how they will be matched when they do sign up, so it has to be right — and no two
              members can share one.
            </Text>

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
              loading={addMember.isPending}
              onPress={() => void submit()}
            >
              Add member
            </Button>
            <Button variant="text" onPress={() => router.back()}>
              Cancel
            </Button>
          </View>
        </ScrollView>
      </RequirePermission>
    </View>
  );
}
