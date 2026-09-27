import { APARTMENT_NUMBER_MAX_LENGTH, FLOOR_MAX, FLOOR_MIN, OCCUPANCY_STATUSES } from '@ses/domain';
import { Controller } from 'react-hook-form';
import type { Control, FieldErrors } from 'react-hook-form';
import { Switch, View } from 'react-native';

import { ChoiceChips } from '@/components/forms/ChoiceChips';
import { Text } from '@/components/ui/Text';
import { TextInput } from '@/components/ui/TextInput';

import { OCCUPANCY_STATUS_LABELS } from '../schemas/apartment.schemas';
import type { ApartmentFormValues } from '../schemas/apartment.schemas';

/**
 * Shared flat form body — used by both the create and the edit screen, so the two
 * can never drift (the same reason `BuildingFormFields` exists).
 *
 * Every text field takes its error from its own `fieldState`, so there is no
 * `errors` prop for those; the two switches are not RHF inputs and read theirs from
 * `errors`, which is why that prop exists here at all. A root-level error (the
 * mutation failed) is the *screen's* to render, next to the submit button, because
 * that is where the user is looking when it happens.
 *
 * ## Numbers are text fields, and empty is a value
 *
 * `keyboardType` gives the right keyboard without the coercion a number input would
 * force, because on this entity **empty means something**: `null` in the database
 * is "not recorded" and is not zero. A carpet area of `0` is refused by the domain
 * (PRD §4's per-sqft splits divide by it), while `0` parking slots is ordinary — so
 * the fields must be able to say both, and only a string can.
 *
 * ## The occupancy row uses the shared chip control
 *
 * `ChoiceChips` shows every option at once, which matters here: `owner_occupied` and
 * `rented` are charged differently by more than one rule (PRD §6), so the choice is
 * consequential enough that hiding it behind a modal picker would be the wrong
 * trade for two taps.
 */
export interface ApartmentFormFieldsProps {
  readonly control: Control<ApartmentFormValues>;
  readonly errors: FieldErrors<ApartmentFormValues>;
}

/** The enum as chip options, in the enum's declared order. */
const OCCUPANCY_OPTIONS = OCCUPANCY_STATUSES.map((status) => ({
  value: status,
  label: OCCUPANCY_STATUS_LABELS[status],
}));

export function ApartmentFormFields({ control, errors }: ApartmentFormFieldsProps) {
  return (
    <View className="gap-4">
      <Text variant="titleSmall">Flat details</Text>

      <Controller
        control={control}
        name="apartmentNumber"
        render={({ field, fieldState }) => (
          <TextInput
            label="Flat number"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={fieldState.error !== undefined}
            helperText={
              fieldState.error?.message ??
              `What residents recognise — e.g. A-101 · up to ${APARTMENT_NUMBER_MAX_LENGTH} characters`
            }
            autoCapitalize="characters"
            maxLength={APARTMENT_NUMBER_MAX_LENGTH}
          />
        )}
      />

      <Controller
        control={control}
        name="floor"
        render={({ field, fieldState }) => (
          <TextInput
            label="Floor (optional)"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={fieldState.error !== undefined}
            helperText={
              fieldState.error?.message ??
              `Leave blank if it is not recorded · ${FLOOR_MIN} to ${FLOOR_MAX}, negative for basements`
            }
            keyboardType="number-pad"
            maxLength={4}
          />
        )}
      />

      <Controller
        control={control}
        name="bhk"
        render={({ field, fieldState }) => (
          <TextInput
            label="Configuration (optional)"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={fieldState.error !== undefined}
            helperText={fieldState.error?.message ?? 'In BHK, half steps allowed — e.g. 2 or 1.5'}
            keyboardType="decimal-pad"
            maxLength={4}
          />
        )}
      />

      <Controller
        control={control}
        name="carpetAreaSqft"
        render={({ field, fieldState }) => (
          <TextInput
            label="Carpet area (optional)"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={fieldState.error !== undefined}
            helperText={fieldState.error?.message ?? 'In sq ft · used by per-area split rules'}
            keyboardType="decimal-pad"
            maxLength={9}
          />
        )}
      />

      <Controller
        control={control}
        name="builtupAreaSqft"
        render={({ field, fieldState }) => (
          <TextInput
            label="Built-up area (optional)"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={fieldState.error !== undefined}
            helperText={
              fieldState.error?.message ?? 'In sq ft · cannot be smaller than the carpet area'
            }
            keyboardType="decimal-pad"
            maxLength={9}
          />
        )}
      />

      <Controller
        control={control}
        name="parkingSlots"
        render={({ field, fieldState }) => (
          <TextInput
            label="Parking slots"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={fieldState.error !== undefined}
            helperText={fieldState.error?.message ?? '0 if no slot is allotted'}
            keyboardType="number-pad"
            maxLength={2}
          />
        )}
      />

      <Controller
        control={control}
        name="shareUnits"
        render={({ field, fieldState }) => (
          <TextInput
            label="Share units"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={fieldState.error !== undefined}
            helperText={
              fieldState.error?.message ??
              'Weight for share-based splits · 0 for a flat exempt from them'
            }
            keyboardType="decimal-pad"
            maxLength={8}
          />
        )}
      />

      <Controller
        control={control}
        name="occupancyStatus"
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

      {/*
        The two switches are read from the form's `errors`, not from a `fieldState`:
        RHF does not register a `Switch` as a text input, so the only way a server
        message can reach them is through the form-level error map.
      */}
      <Controller
        control={control}
        name="isCommercial"
        render={({ field }) => (
          <ToggleRow
            label="Commercial unit"
            description="Shops and offices are billed differently and excluded from residential-only rules."
            value={field.value}
            onChange={field.onChange}
            error={errors.isCommercial?.message}
          />
        )}
      />

      <Controller
        control={control}
        name="isBillable"
        render={({ field }) => (
          <ToggleRow
            label="Billable"
            description="Turn this off for a flat that exists but is never charged — a caretaker's quarter, say."
            value={field.value}
            onChange={field.onChange}
            error={errors.isBillable?.message}
          />
        )}
      />
    </View>
  );
}

interface ToggleRowProps {
  readonly label: string;
  readonly description: string;
  readonly value: boolean;
  onChange: (value: boolean) => void;
  readonly error?: string | undefined;
}

/**
 * A labelled switch.
 *
 * A local component rather than a shared `components/ui` one: this is its only
 * consumer, and the society and building forms have no boolean field at all. It is
 * not a candidate for `components/forms/` until a second module needs it — the same
 * judgement that left `ChoiceChips` in the society feature until now.
 */
function ToggleRow({ label, description, value, onChange, error }: ToggleRowProps) {
  return (
    <View className="flex-row items-center justify-between gap-4">
      <View className="flex-1 gap-1">
        <Text variant="bodyMedium">{label}</Text>
        <Text variant="bodySmall" color={error === undefined ? 'onSurfaceVariant' : 'error'}>
          {error ?? description}
        </Text>
      </View>
      <Switch value={value} onValueChange={onChange} accessibilityLabel={label} />
    </View>
  );
}
