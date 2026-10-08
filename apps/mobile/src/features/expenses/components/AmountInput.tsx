import { View } from 'react-native';

import { Text } from '@/components/ui/Text';
import { TextInput } from '@/components/ui/TextInput';

import { formatPaiseForInput, parseRupeeText } from '../schemas/expense-amount';

/**
 * The money field (PRD §3.4's sticky amount, SAD §6.4's `AmountInput`).
 *
 * ## It emits paise, and it never emits a float
 *
 * The field is controlled by **text** — that is what a user types, and what has to survive a
 * refusal so the mistake can be corrected rather than erased. On every keystroke it reads that
 * text with `parseRupeeText` and reports the result as **integer paise** through
 * `onAmountChange` (`null` when the text does not parse), so no caller has to parse money itself
 * and no `Number`/`parseFloat` conversion exists anywhere in the form. The display beside the
 * field is the same integer formatted back, which is how a treasurer sees that their grouping
 * was understood.
 *
 * ## Why a preview line instead of a native number keyboard's value
 *
 * `keyboardType="decimal-pad"` gives the right keypad; it does not give grouping, so
 * `1234567.5` stays on screen exactly as typed and the formatted line is what confirms
 * "₹12,34,567.50". A value that does not parse shows nothing rather than a wrong number.
 */
export interface AmountInputProps {
  readonly value: string;
  onChangeText: (text: string) => void;
  /** Integer paise for the current text, or `null` while it does not parse. */
  onAmountChange: (paise: number | null) => void;
  readonly error?: string | undefined;
}

export function AmountInput({ value, onChangeText, onAmountChange, error }: AmountInputProps) {
  const { paise } = parseRupeeText(value);

  const change = (text: string): void => {
    onChangeText(text);
    onAmountChange(parseRupeeText(text).paise);
  };

  return (
    <View className="gap-1">
      <View className="flex-row items-center gap-2">
        <Text variant="titleMedium" color="onSurfaceVariant">
          ₹
        </Text>
        <View className="flex-1">
          <TextInput
            label="Amount"
            value={value}
            variant="outlined"
            keyboardType="decimal-pad"
            inputMode="decimal"
            placeholder="1,23,456.78"
            autoComplete="off"
            // `error` is the resolver's verdict; a non-empty unparsed value is flagged here too so
            // the field turns red as soon as the typing is unsalvageable.
            error={error !== undefined || (value.length > 0 && paise === null)}
            onChangeText={change}
            {...(error === undefined ? {} : { helperText: error })}
          />
        </View>
      </View>
      {/*
        The formatted readback. Deliberately hidden while the value is unparseable — showing the
        last good number next to new text is how a user submits an amount they did not type.
      */}
      <Text variant="bodySmall" color="outline">
        {paise === null ? ' ' : `₹${formatPaiseForInput(paise)}`}
      </Text>
    </View>
  );
}
