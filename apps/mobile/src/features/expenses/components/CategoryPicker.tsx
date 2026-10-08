import { View } from 'react-native';

import { ChoiceChips } from '@/components/forms/ChoiceChips';
import { Text } from '@/components/ui/Text';

/**
 * The category picker (PRD screen #28, PRD §3.4's `category_id`).
 *
 * ## Chips, not a modal picker
 *
 * PRD §3.4's categories are "seeded per society… nineteen" names, and the form is filled many
 * times in a sitting. A chip row shows the whole vocabulary at once — one tap, no navigation, no
 * intermediate state to lose — which is the same reason `ChoiceChips` exists for occupancy and
 * society type. It also makes the field testable without a native modal.
 *
 * ## The option list is the society's, read by this feature
 *
 * `categories` comes from `GET /expense-categories` through this feature's own option read
 * (`useExpenseCategoryOptions`), never from the category-management screen's state: a feature
 * may not reach into another feature, and a form must still work when reached by deep link with
 * no screen behind it.
 *
 * Inactive categories are filtered out by the read, not here — a deactivated category is still
 * readable historically but must not be offered on a new expense (T062's `is_active`).
 */
export interface CategoryOption {
  readonly id: string;
  readonly name: string;
}

export interface CategoryPickerProps {
  readonly options: readonly CategoryOption[];
  readonly value: string;
  onChange: (categoryId: string) => void;
  readonly error?: string | undefined;
  /** True while the society's categories are still being read. */
  readonly isLoading?: boolean;
}

export function CategoryPicker({
  options,
  value,
  onChange,
  error,
  isLoading = false,
}: CategoryPickerProps) {
  if (isLoading) {
    return (
      <Text variant="bodyMedium" color="onSurfaceVariant">
        Loading categories…
      </Text>
    );
  }

  if (options.length === 0) {
    return (
      <View className="gap-1">
        <Text variant="bodySmall" color={error === undefined ? 'onSurfaceVariant' : 'error'}>
          Category
        </Text>
        <Text variant="bodyMedium" color="onSurfaceVariant">
          This society has no active expense categories yet. An Admin has to add one.
        </Text>
        {error !== undefined ? (
          <Text variant="bodySmall" color="error">
            {error}
          </Text>
        ) : null}
      </View>
    );
  }

  return (
    <ChoiceChips
      label="Category"
      options={options.map((category) => ({ value: category.id, label: category.name }))}
      value={value}
      onChange={onChange}
      error={error}
    />
  );
}
