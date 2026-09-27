import { TOTAL_FLOORS_MAX } from '@ses/domain';
import { Controller } from 'react-hook-form';
import type { Control } from 'react-hook-form';
import { View } from 'react-native';

import { Text } from '@/components/ui/Text';
import { TextInput } from '@/components/ui/TextInput';

import type { BuildingFormValues } from '../schemas/building.schemas';

/**
 * Shared building form body — used by both the create and the edit screen, so the
 * two can never drift (the same reason `SocietyFormFields` exists).
 *
 * Every field takes its error from its own `fieldState`, so there is no `errors`
 * prop: `SocietyFormFields` needs one only because its choice chips are not RHF
 * inputs and have nowhere else to read a message from. A root-level error (`the
 * mutation failed`) is the *screen's* to render, next to the submit button, because
 * that is where the user is looking when it happens.
 *
 * RHF stays uncontrolled: each field is registered through a `Controller`, so the
 * inputs remain plain `value`/`onChangeText` and typing does not re-render the
 * whole form (SAD §2.1).
 *
 * The floor count is a **text field** allowed to be empty, not a number field.
 * `keyboardType="number-pad"` gives the numeric keyboard without the coercion a
 * `number` input would force — and empty is a meaningful value here: it means the
 * count has not been recorded, which is not the same as zero.
 */
export interface BuildingFormFieldsProps {
  readonly control: Control<BuildingFormValues>;
}

export function BuildingFormFields({ control }: BuildingFormFieldsProps) {
  return (
    <View className="gap-4">
      <Text variant="titleSmall">Building details</Text>

      <Controller
        control={control}
        name="name"
        render={({ field, fieldState }) => (
          <TextInput
            label="Building name"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={fieldState.error !== undefined}
            helperText={fieldState.error?.message ?? 'e.g. Tower A, Block 2, Main Building'}
            autoCapitalize="words"
          />
        )}
      />

      <Controller
        control={control}
        name="totalFloors"
        render={({ field, fieldState }) => (
          <TextInput
            label="Floors (optional)"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={fieldState.error !== undefined}
            helperText={
              fieldState.error?.message ??
              `Leave blank if it has not been counted yet · up to ${TOTAL_FLOORS_MAX}`
            }
            keyboardType="number-pad"
            maxLength={3}
          />
        )}
      />

      <Controller
        control={control}
        name="displayOrder"
        render={({ field, fieldState }) => (
          <TextInput
            label="Display order"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={fieldState.error !== undefined}
            helperText={fieldState.error?.message ?? 'Lower numbers are listed first'}
            keyboardType="number-pad"
            maxLength={3}
          />
        )}
      />
    </View>
  );
}
