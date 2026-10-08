import { fireEvent, render, screen } from '@testing-library/react-native';

import { AmountInput } from '../components/AmountInput';

/**
 * `AmountInput` (Roadmap T074 §4): the component emits **integer paise** for the text typed, shows
 * the formatted readback, and never reports a number it could not parse.
 *
 * The parser's own boundaries are `expense-amount.test.ts`; what is asserted here is the contract
 * between the field and its caller — that the value crossing the boundary is an integer paise
 * value, and that a refusal is a `null` rather than a rounded guess.
 *
 * (RNTL v14's `render`/`fireEvent` are async, so every call here is awaited.)
 */
async function renderInput(value = ''): Promise<{
  readonly onAmountChange: jest.Mock;
  readonly setText: (text: string) => Promise<void>;
}> {
  const onAmountChange = jest.fn();
  const onChangeText = jest.fn();
  await render(
    <AmountInput value={value} onChangeText={onChangeText} onAmountChange={onAmountChange} />,
  );
  return {
    onAmountChange,
    setText: async (text) => {
      await fireEvent.changeText(screen.getByLabelText('Amount'), text);
    },
  };
}

describe('AmountInput', () => {
  it('emits integer paise for Indian-grouped rupees', async () => {
    const { onAmountChange, setText } = await renderInput();
    await setText('1,23,456.78');

    expect(onAmountChange).toHaveBeenLastCalledWith(12_345_678);
    expect(Number.isInteger(onAmountChange.mock.calls.at(-1)?.[0])).toBe(true);
  });

  it('emits paise for a whole-rupee amount without a decimal point', async () => {
    const { onAmountChange, setText } = await renderInput();
    await setText('60000');
    expect(onAmountChange).toHaveBeenLastCalledWith(6_000_000);
  });

  it('emits null while the text does not parse, never a rounded value', async () => {
    const { onAmountChange, setText } = await renderInput();
    await setText('12,3');
    expect(onAmountChange).toHaveBeenLastCalledWith(null);
    await setText('123,456');
    expect(onAmountChange).toHaveBeenLastCalledWith(null);
  });

  it('shows the formatted amount as it is understood', async () => {
    await render(
      <AmountInput
        value="1,23,456.78"
        onChangeText={() => undefined}
        onAmountChange={() => undefined}
      />,
    );
    expect(screen.getByText('₹1,23,456.78')).toBeTruthy();
  });

  it('shows no readback for text it cannot read, only the bare currency prefix', async () => {
    await render(
      <AmountInput value="12,3" onChangeText={() => undefined} onAmountChange={() => undefined} />,
    );
    // The prefix `₹` is always drawn; the readback is a number after it, and there is none.
    expect(screen.queryByText(/₹\d/)).toBeNull();
  });

  it('renders the resolver error in the supporting slot', async () => {
    await render(
      <AmountInput
        value=""
        onChangeText={() => undefined}
        onAmountChange={() => undefined}
        error="Enter an amount"
      />,
    );
    expect(screen.getByText('Enter an amount')).toBeTruthy();
  });
});
