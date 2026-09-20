import { SOCIETY_TYPES } from '@ses/domain';
import { Controller } from 'react-hook-form';
import type { Control, FieldErrors } from 'react-hook-form';
import { View } from 'react-native';

import { Text } from '@/components/ui/Text';
import { TextInput } from '@/components/ui/TextInput';

import { SOCIETY_TYPE_LABELS } from '../labels';
import type { SocietyFormValues } from '../schemas/society.schemas';

import { ChoiceChips } from './ChoiceChips';

/**
 * Shared society form body — used by both the create wizard's basics step and
 * the edit screen, so the two can never drift apart (PRD §3.2 steps 1 and 3).
 *
 * RHF stays uncontrolled: every field is registered through a `Controller`
 * so the inputs remain plain `value`/`onChangeText` and typing does not
 * re-render the whole form (SAD §2.1).
 */
export interface SocietyFormFieldsProps {
  readonly control: Control<SocietyFormValues>;
  readonly errors: FieldErrors<SocietyFormValues>;
}

const TYPE_OPTIONS = SOCIETY_TYPES.map((type) => ({
  value: type,
  label: SOCIETY_TYPE_LABELS[type],
}));

export function SocietyFormFields({ control, errors }: SocietyFormFieldsProps) {
  return (
    <View className="gap-4">
      <Text variant="titleSmall">Society details</Text>

      <Controller
        control={control}
        name="name"
        render={({ field, fieldState }) => (
          <TextInput
            label="Society name"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={fieldState.error !== undefined}
            helperText={fieldState.error?.message}
            autoCapitalize="words"
          />
        )}
      />

      <Controller
        control={control}
        name="type"
        render={({ field }) => (
          <ChoiceChips
            label="Society type"
            options={TYPE_OPTIONS}
            value={field.value}
            onChange={field.onChange}
            error={errors.type?.message}
          />
        )}
      />

      <Controller
        control={control}
        name="registrationNumber"
        render={({ field, fieldState }) => (
          <TextInput
            label="Registration number (optional)"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={fieldState.error !== undefined}
            helperText={fieldState.error?.message}
            autoCapitalize="characters"
          />
        )}
      />

      <Controller
        control={control}
        name="addressLine1"
        render={({ field, fieldState }) => (
          <TextInput
            label="Address line 1 (optional)"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={fieldState.error !== undefined}
            helperText={fieldState.error?.message}
          />
        )}
      />

      <Controller
        control={control}
        name="addressLine2"
        render={({ field, fieldState }) => (
          <TextInput
            label="Address line 2 (optional)"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={fieldState.error !== undefined}
            helperText={fieldState.error?.message}
          />
        )}
      />

      <Controller
        control={control}
        name="city"
        render={({ field, fieldState }) => (
          <TextInput
            label="City"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={fieldState.error !== undefined}
            helperText={fieldState.error?.message}
            autoCapitalize="words"
          />
        )}
      />

      <Controller
        control={control}
        name="state"
        render={({ field, fieldState }) => (
          <TextInput
            label="State"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={fieldState.error !== undefined}
            helperText={fieldState.error?.message}
            autoCapitalize="words"
          />
        )}
      />

      <Controller
        control={control}
        name="pincode"
        render={({ field, fieldState }) => (
          <TextInput
            label="PIN code (optional)"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={fieldState.error !== undefined}
            helperText={fieldState.error?.message}
            keyboardType="number-pad"
            maxLength={6}
          />
        )}
      />

      <Text variant="titleSmall">Financial defaults</Text>
      <Text variant="bodySmall" color="onSurfaceVariant">
        Seeded into the society's settings row; the treasurer can change them later.
      </Text>

      <Controller
        control={control}
        name="billingDay"
        render={({ field, fieldState }) => (
          <TextInput
            label="Billing day (1–28)"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={fieldState.error !== undefined}
            helperText={fieldState.error?.message}
            keyboardType="number-pad"
            maxLength={2}
          />
        )}
      />

      <Controller
        control={control}
        name="dueDay"
        render={({ field, fieldState }) => (
          <TextInput
            label="Due day (1–28)"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={fieldState.error !== undefined}
            helperText={fieldState.error?.message}
            keyboardType="number-pad"
            maxLength={2}
          />
        )}
      />

      <Controller
        control={control}
        name="approvalThresholdRupees"
        render={({ field, fieldState }) => (
          <TextInput
            label="Approval threshold (₹)"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={fieldState.error !== undefined}
            helperText={fieldState.error?.message ?? 'Expenses above this need an Admin.'}
            keyboardType="number-pad"
            maxLength={7}
          />
        )}
      />
    </View>
  );
}
