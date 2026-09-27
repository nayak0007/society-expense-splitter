import { MEMBER_EMAIL_MAX_LENGTH, MEMBER_NAME_MAX_LENGTH, MEMBER_OCCUPANCIES } from '@ses/domain';
import { Controller, useController, useWatch } from 'react-hook-form';
import type { Control, FieldErrors } from 'react-hook-form';
import { Pressable, ScrollView, Switch, View } from 'react-native';

import { ChoiceChips } from '@/components/forms/ChoiceChips';
import { Button } from '@/components/ui/Button';
import { Text } from '@/components/ui/Text';
import { TextInput } from '@/components/ui/TextInput';

import { MEMBER_OCCUPANCY_LABELS } from '../schemas/member.schemas';
import type { MemberFormValues } from '../schemas/member.schemas';

/**
 * Shared member form body — used by both the create and the edit screen, so the two can never
 * drift (the same reason `BuildingFormFields` and `ApartmentFormFields` exist).
 *
 * Every text field takes its error from its own `fieldState`; the two switches are not RHF
 * inputs and read theirs from `errors`, which is why that prop exists here at all. A
 * root-level error (the mutation failed) is the *screen's* to render, next to the submit
 * button, because that is where the user is looking when it happens.
 *
 * ## The phone is required to create and optional to edit
 *
 * That asymmetry is the contract's (`createMemberSchema` requires it, `updateMemberSchema`
 * accepts `null`), and the two screens get it by using different resolvers over this one body
 * — `memberCreateResolver` adds the requirement. It is not a UI convenience: a shadow member's
 * number is the only identifier they have, so an Admin *must* give one when recording them,
 * and must be able to take one off when it was wrong.
 *
 * ## The lease dates are typed, and that is deliberate
 *
 * `YYYY-MM-DD` in a text field, validated as it is typed. A lease window is usually copied off
 * a paper agreement, and a date keyboard beats scrolling a picker to December. The dates matter
 * beyond bookkeeping: they are what a tenant's charges are prorated by (PRD §3.4).
 */
/**
 * The flat lookup, as this feature needs to see it — structurally typed, not imported.
 *
 * The data comes from the **structure** feature, and a feature may not import another feature's
 * code (`no-restricted-imports` in the preset: shared code belongs in `src/lib` or a package).
 * So the route — which is allowed to compose features, and is the composition layer by design —
 * reads the lookup and hands it to this component. Declaring the shape here rather than
 * importing the structure hook's interface is what keeps the dependency one-way and visible: if
 * the two ever diverge, this file is where it shows up.
 */
export interface FlatPickerOptions {
  readonly buildings: readonly { readonly value: string; readonly label: string }[];
  readonly flats: readonly { readonly id: string; readonly label: string }[];
  readonly isLoadingFlats: boolean;
}

export interface MemberFormFieldsProps {
  readonly control: Control<MemberFormValues>;
  readonly errors: FieldErrors<MemberFormValues>;
  /** Buildings and flats to choose from, supplied by the route. */
  readonly flatOptions: FlatPickerOptions;
}

/** The enum as chip options, in the enum's declared order. */
const OCCUPANCY_OPTIONS = MEMBER_OCCUPANCIES.map((occupancy) => ({
  value: occupancy,
  label: MEMBER_OCCUPANCY_LABELS[occupancy],
}));

export function MemberFormFields({ control, errors, flatOptions }: MemberFormFieldsProps) {
  /*
    Watched at the top level, not inside a `Controller` render prop: a hook inside a render
    callback would be called a different number of times per render, and React's rules of hooks
    are not a style preference. The primary flag depends on it, because a claim to be a flat's
    main occupant is meaningless without a flat.
  */
  const apartmentId = useWatch({ control, name: 'apartmentId' });

  return (
    <View className="gap-4">
      <Text variant="titleSmall">Member details</Text>

      <Controller
        control={control}
        name="displayName"
        render={({ field, fieldState }) => (
          <TextInput
            label="Name"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={fieldState.error !== undefined}
            helperText={
              fieldState.error?.message ??
              `How they will appear in every list · up to ${MEMBER_NAME_MAX_LENGTH} characters`
            }
            autoCapitalize="words"
            maxLength={MEMBER_NAME_MAX_LENGTH}
          />
        )}
      />

      <Controller
        control={control}
        name="phone"
        render={({ field, fieldState }) => (
          <TextInput
            label="Phone"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={fieldState.error !== undefined}
            helperText={
              fieldState.error?.message ??
              'A 10-digit number, or include the country code — e.g. +91 98765 43210'
            }
            keyboardType="phone-pad"
            maxLength={24}
          />
        )}
      />

      <Controller
        control={control}
        name="email"
        render={({ field, fieldState }) => (
          <TextInput
            label="Email (optional)"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={fieldState.error !== undefined}
            helperText={
              fieldState.error?.message ??
              `Used for notices and to match them when they sign up · up to ${MEMBER_EMAIL_MAX_LENGTH} characters`
            }
            keyboardType="email-address"
            autoCapitalize="none"
            maxLength={MEMBER_EMAIL_MAX_LENGTH}
          />
        )}
      />

      <Controller
        control={control}
        name="occupancy"
        render={({ field, fieldState }) => (
          <ChoiceChips
            label="Occupancy"
            options={OCCUPANCY_OPTIONS}
            value={field.value}
            onChange={field.onChange}
            error={fieldState.error?.message}
          />
        )}
      />

      <FlatPicker control={control} options={flatOptions} />

      <Controller
        control={control}
        name="isPrimary"
        render={({ field }) => (
          <ToggleRow
            label="Primary occupant"
            description={
              apartmentId === null
                ? 'Choose a flat first — the primary claim is about a flat, and each flat has at most one primary owner and one primary tenant.'
                : 'The person the flat’s notices and dues are addressed to.'
            }
            value={field.value}
            onChange={field.onChange}
            // Not merely disabled: the contract *refuses* a primary claim without a flat, so
            // letting the switch be flipped would produce a `400` the form could have known
            // about. A switch that cannot be turned on, with the reason beside it, is the
            // honest version.
            disabled={apartmentId === null}
            error={errors.isPrimary?.message}
          />
        )}
      />

      <Controller
        control={control}
        name="leaseStart"
        render={({ field, fieldState }) => (
          <TextInput
            label="Lease start (optional)"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={fieldState.error !== undefined}
            helperText={
              fieldState.error?.message ?? 'YYYY-MM-DD · leave blank if there is no lease'
            }
            autoCapitalize="none"
            maxLength={10}
          />
        )}
      />

      <Controller
        control={control}
        name="leaseEnd"
        render={({ field, fieldState }) => (
          <TextInput
            label="Lease end (optional)"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={fieldState.error !== undefined}
            helperText={
              fieldState.error?.message ??
              'YYYY-MM-DD · charges for a tenant are prorated by this window'
            }
            autoCapitalize="none"
            maxLength={10}
          />
        )}
      />

      <Controller
        control={control}
        name="shareContact"
        render={({ field }) => (
          <ToggleRow
            label="Share contact details"
            description="Off by default. When it is off, other residents cannot see this member’s phone or email — the managers and the member themselves always can."
            value={field.value}
            onChange={field.onChange}
            error={errors.shareContact?.message}
          />
        )}
      />
    </View>
  );
}

/**
 * The flat picker: a building, then a flat inside it.
 *
 * Two steps rather than one list, because the API's flat list is **per building** — a society
 * with four towers and 300 flats cannot offer one flat list, and fetching all of them to build
 * one would be the N+1 the Roadmap's criteria name.
 *
 * Both fields are written here in one component, which is why this is not two `Controller`s in
 * the body above: "clear the flat" has to clear the building as well, or the next time the form
 * is opened the section would render a chosen building with nothing selected.
 *
 * Choosing a building **clears the flat**, deliberately. Moving a member from A-101 to Tower B
 * means picking a flat in Tower B; leaving the old flat selected while showing another
 * building's list would silently keep the member where they were.
 */
function FlatPicker({
  control,
  options,
}: {
  readonly control: Control<MemberFormValues>;
  readonly options: FlatPickerOptions;
}) {
  const building = useController({ control, name: 'buildingId' });
  const apartment = useController({ control, name: 'apartmentId' });
  const { buildings, flats, isLoadingFlats } = options;

  const clear = (): void => {
    building.field.onChange(null);
    apartment.field.onChange(null);
  };

  return (
    <View className="gap-3">
      <Text variant="bodySmall" color="onSurfaceVariant">
        Flat (optional)
      </Text>
      <Text variant="bodySmall" color="onSurfaceVariant">
        Leave this blank for somebody who is not an occupant — a committee member with no flat, say.
        It can be filled in later.
      </Text>

      {apartment.field.value !== null ? (
        <View className="flex-row items-center justify-between gap-3 rounded-md border border-outline bg-surface p-3">
          <Text variant="bodyMedium">{selectedLabel(flats, apartment.field.value)}</Text>
          <Button variant="text" onPress={clear}>
            Change
          </Button>
        </View>
      ) : buildings.length === 0 ? (
        <Text variant="bodySmall" color="onSurfaceVariant">
          This society has no buildings yet. Add one under Structure, then come back to assign a
          flat.
        </Text>
      ) : building.field.value === null ? (
        <ChoiceChips
          label="Building"
          options={buildings}
          // `''` is not a building id, and the chips need a value to compare against; the
          // label above it makes the state legible, and pressing a building is the only
          // transition out of it.
          value={building.field.value ?? ''}
          onChange={(value) => {
            building.field.onChange(value);
            apartment.field.onChange(null);
          }}
        />
      ) : (
        <View className="gap-2">
          <View className="flex-row items-center justify-between gap-3">
            <Text variant="bodySmall" color="onSurfaceVariant">
              {buildings.find((option) => option.value === building.field.value)?.label ??
                'Building'}
            </Text>
            <Button variant="text" onPress={() => building.field.onChange(null)}>
              Change building
            </Button>
          </View>

          {isLoadingFlats ? (
            <Text variant="bodySmall" color="onSurfaceVariant">
              Loading flats…
            </Text>
          ) : flats.length === 0 ? (
            <Text variant="bodySmall" color="onSurfaceVariant">
              No flats recorded in this building yet.
            </Text>
          ) : (
            /*
              A capped, scrollable list rather than a chip row: a tower can hold a hundred
              flats, and a chip wrap that long would push the submit button off the screen
              (which is exactly what this height is chosen to prevent). The outer form still
              scrolls; this is the only nested one.
            */
            <ScrollView style={{ maxHeight: 220 }} nestedScrollEnabled>
              <View className="gap-2">
                {flats.map((flat) => (
                  <Pressable
                    key={flat.id}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: false }}
                    accessibilityLabel={flat.label}
                    onPress={() => apartment.field.onChange(flat.id)}
                    className="rounded-md border border-outline-variant bg-surface px-4 py-3"
                  >
                    <Text variant="bodyMedium">{flat.label}</Text>
                  </Pressable>
                ))}
              </View>
            </ScrollView>
          )}
        </View>
      )}
    </View>
  );
}

/** The chosen flat's label, or the id itself if the list has not loaded for it. */
function selectedLabel(
  flats: readonly { readonly id: string; readonly label: string }[],
  apartmentId: string,
): string {
  return flats.find((flat) => flat.id === apartmentId)?.label ?? 'Flat selected';
}

interface ToggleRowProps {
  readonly label: string;
  readonly description: string;
  readonly value: boolean;
  onChange: (value: boolean) => void;
  readonly disabled?: boolean | undefined;
  readonly error?: string | undefined;
}

/** A labelled switch — the same local control `ApartmentFormFields` uses, plus a disable state. */
function ToggleRow({
  label,
  description,
  value,
  onChange,
  disabled = false,
  error,
}: ToggleRowProps) {
  return (
    <View className="flex-row items-center justify-between gap-4">
      <View className="flex-1 gap-1">
        <Text variant="bodyMedium">{label}</Text>
        <Text variant="bodySmall" color={error === undefined ? 'onSurfaceVariant' : 'error'}>
          {error ?? description}
        </Text>
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        accessibilityLabel={label}
      />
    </View>
  );
}
