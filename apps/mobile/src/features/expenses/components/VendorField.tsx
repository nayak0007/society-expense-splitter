import { View } from 'react-native';
import { Controller } from 'react-hook-form';
import type { Control } from 'react-hook-form';

import { TextInput } from '@/components/ui/TextInput';
import { EXPENSE_DESCRIPTION_MAX_LENGTH, EXPENSE_VENDOR_NAME_MAX_LENGTH } from '@ses/domain';

import type { ExpenseFormValues } from '../schemas/expense-form.schemas';

/**
 * Vendor and notes — the two free-text fields of PRD §3.4's form.
 *
 * ## It owns its `Controller`s, like `MemberFormFields` does
 *
 * Two fields, one component, because they are one decision: neither is required, both share the
 * contract's bounds, and the PRD's "Notes" column *is* the expense's `description` (the mapping
 * the contract records). Taking `control` rather than values+callbacks keeps the screen free of a
 * second nested render-prop for no reason, and it is the shape `MemberFormFields` already
 * established for exactly this case.
 *
 * ## The bounds come from `@ses/domain`
 *
 * The same two constants the contract builds its schema from, so a widened column moves both
 * rather than leaving the form refusing text the database would accept.
 *
 * `multiline` on the notes only: a vendor is a line, and "why did this cost ₹40,000" needs room.
 */
export interface VendorFieldProps {
  readonly control: Control<ExpenseFormValues>;
}

export function VendorField({ control }: VendorFieldProps) {
  return (
    <View className="gap-4">
      <Controller
        control={control}
        name="vendorName"
        render={({ field, fieldState }) => (
          <TextInput
            label="Vendor"
            value={field.value}
            variant="outlined"
            maxLength={EXPENSE_VENDOR_NAME_MAX_LENGTH}
            placeholder="Who was paid"
            autoCapitalize="words"
            error={fieldState.error !== undefined}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            {...(fieldState.error?.message === undefined
              ? {}
              : { helperText: fieldState.error.message })}
          />
        )}
      />
      <Controller
        control={control}
        name="description"
        render={({ field, fieldState }) => (
          <TextInput
            label="Notes"
            value={field.value}
            variant="outlined"
            multiline
            numberOfLines={3}
            maxLength={EXPENSE_DESCRIPTION_MAX_LENGTH}
            placeholder="Anything the society should know about this expense"
            error={fieldState.error !== undefined}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            {...(fieldState.error?.message === undefined
              ? {}
              : { helperText: fieldState.error.message })}
          />
        )}
      />
    </View>
  );
}
