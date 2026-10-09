import { fireEvent, render, screen } from '@testing-library/react-native';

import { CustomAmountEditor } from '../components/CustomAmountEditor';
import { FloorBandEditor } from '../components/FloorBandEditor';
import { ParticipantValueRow } from '../components/ParticipantValueRow';
import { PercentageEditor } from '../components/PercentageEditor';
import { SharesEditor, shareEntryProblem } from '../components/SharesEditor';
import { StrategySelector } from '../components/StrategySelector';
import type { RosterEntry } from '../hooks/use-split-preview';
import type { FloorBandForm } from '../schemas/split.schemas';

/**
 * The split editors (T075 §8). These are presentation over the pure logic in
 * `split.schemas.ts`; the assertions are about what a treasurer sees and what a change
 * reports, including the two honesty rules that must not regress: a custom remainder is
 * never clamped, and a zero floor-band multiplier is exempt-but-listed rather than empty.
 */

const ROSTER: readonly RosterEntry[] = [
  { apartmentId: 'ap1', apartmentNumber: 'A-101', memberId: 'm1' },
  { apartmentId: 'ap2', apartmentNumber: 'A-102', memberId: 'm2' },
];

describe('StrategySelector', () => {
  it('offers all five strategies', async () => {
    await render(
      <StrategySelector
        strategy="equal"
        basis={null}
        onChangeStrategy={jest.fn()}
        onChangeBasis={jest.fn()}
      />,
    );
    for (const label of ['Equal', 'Percentage', 'Shares', 'By apartment', 'Custom amounts']) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
  });

  it('hides the basis chips until apartment is chosen', async () => {
    await render(
      <StrategySelector
        strategy="equal"
        basis={null}
        onChangeStrategy={jest.fn()}
        onChangeBasis={jest.fn()}
      />,
    );
    expect(screen.queryByText('Weight flats by')).toBeNull();
  });

  it('shows the six bases for an apartment split', async () => {
    await render(
      <StrategySelector
        strategy="apartment"
        basis="per_flat"
        onChangeStrategy={jest.fn()}
        onChangeBasis={jest.fn()}
      />,
    );
    expect(screen.getByText('Weight flats by')).toBeTruthy();
    expect(screen.getByLabelText('Per flat')).toBeTruthy();
    expect(screen.getByLabelText('Per parking slot')).toBeTruthy();
    // `occupied_only` is a participation question, not a basis (split-vocabulary.ts).
    expect(screen.queryByLabelText('Occupied only')).toBeNull();
  });

  it('reports a strategy and a basis change', async () => {
    const onChangeStrategy = jest.fn();
    const onChangeBasis = jest.fn();
    await render(
      <StrategySelector
        strategy="apartment"
        basis="per_flat"
        onChangeStrategy={onChangeStrategy}
        onChangeBasis={onChangeBasis}
      />,
    );

    await fireEvent.press(screen.getByLabelText('Percentage'));
    expect(onChangeStrategy).toHaveBeenCalledWith('percentage');

    await fireEvent.press(screen.getByLabelText('By BHK'));
    expect(onChangeBasis).toHaveBeenCalledWith('per_bhk');
  });
});

describe('PercentageEditor', () => {
  it('renders the running total in basis points and one field per flat', async () => {
    await render(
      <PercentageEditor
        roster={ROSTER}
        values={{ ap1: '40' }}
        totalBasisPoints={4000}
        totalOk={false}
        onChange={jest.fn()}
      />,
    );
    expect(screen.getByText('40.00%')).toBeTruthy();
    expect(screen.getByTestId('percentage-ap1')).toBeTruthy();
    expect(screen.getByTestId('percentage-ap2')).toBeTruthy();
    expect(
      screen.getByText('Percentages must total 100.00% before the expense can be saved.'),
    ).toBeTruthy();
  });

  it('hides the blocking sentence once the total is acceptable', async () => {
    await render(
      <PercentageEditor
        roster={ROSTER}
        values={{}}
        totalBasisPoints={10000}
        totalOk
        onChange={jest.fn()}
      />,
    );
    expect(screen.getByText('100.00%')).toBeTruthy();
    expect(screen.queryByText(/must total 100.00% before/)).toBeNull();
  });

  it('reports an edit against the flat it belongs to', async () => {
    const onChange = jest.fn();
    await render(
      <PercentageEditor
        roster={ROSTER}
        values={{}}
        totalBasisPoints={0}
        totalOk={false}
        onChange={onChange}
      />,
    );
    await fireEvent.changeText(screen.getByTestId('percentage-ap2'), '25');
    expect(onChange).toHaveBeenCalledWith('ap2', '25');
  });
});

describe('SharesEditor', () => {
  it('treats a blank entry as "use the flat’s recorded share"', () => {
    expect(shareEntryProblem('')).toBeNull();
    expect(shareEntryProblem('   ')).toBeNull();
  });

  it('refuses a malformed or non-positive share', () => {
    expect(shareEntryProblem('1.2345')).toMatch(/like 1.5/);
    expect(shareEntryProblem('0')).toMatch(/greater than zero/);
  });

  it('accepts a decimal share and the engine ceiling', () => {
    expect(shareEntryProblem('1.5')).toBeNull();
    expect(shareEntryProblem('10000')).toBeNull();
  });

  it('renders a field per flat and shows an entry’s own error', async () => {
    await render(<SharesEditor roster={ROSTER} values={{ ap1: '0' }} onChange={jest.fn()} />);
    expect(screen.getByTestId('share-ap1')).toBeTruthy();
    expect(screen.getByText('A share must be greater than zero')).toBeTruthy();
  });

  it('reports an edit against the flat it belongs to', async () => {
    const onChange = jest.fn();
    await render(<SharesEditor roster={ROSTER} values={{}} onChange={onChange} />);
    await fireEvent.changeText(screen.getByTestId('share-ap1'), '2');
    expect(onChange).toHaveBeenCalledWith('ap1', '2');
  });
});

describe('CustomAmountEditor', () => {
  it('shows the remaining amount and blocks while it is not zero', async () => {
    await render(
      <CustomAmountEditor
        roster={ROSTER}
        values={{ ap1: '300.00' }}
        amountPaise={100_000}
        remainderPaise={70_000}
        onChange={jest.fn()}
      />,
    );
    expect(screen.getByText('₹700.00')).toBeTruthy();
    expect(
      screen.getByText('The amounts must assign the whole expense exactly before it can be saved.'),
    ).toBeTruthy();
  });

  it('shows an over-allocation as a negative remainder, never clamped to ₹0', async () => {
    await render(
      <CustomAmountEditor
        roster={ROSTER}
        values={{}}
        amountPaise={100_000}
        remainderPaise={-10_000}
        onChange={jest.fn()}
      />,
    );
    expect(screen.getByText('-₹100.00')).toBeTruthy();
  });

  it('clears the blocking sentence when the remainder is exactly zero', async () => {
    await render(
      <CustomAmountEditor
        roster={ROSTER}
        values={{}}
        amountPaise={100_000}
        remainderPaise={0}
        onChange={jest.fn()}
      />,
    );
    expect(screen.getByText('₹0.00')).toBeTruthy();
    expect(screen.queryByText(/must assign the whole expense/)).toBeNull();
  });

  it('flags a malformed entry and reports an edit against its flat', async () => {
    const onChange = jest.fn();
    await render(
      <CustomAmountEditor
        roster={ROSTER}
        values={{ ap1: 'nope' }}
        amountPaise={100_000}
        remainderPaise={0}
        onChange={onChange}
      />,
    );
    expect(screen.getByText('Enter an amount like 1,23,456.78')).toBeTruthy();

    await fireEvent.changeText(screen.getByTestId('custom-ap2'), '1,000');
    expect(onChange).toHaveBeenCalledWith('ap2', '1,000');
  });
});

describe('FloorBandEditor', () => {
  const FIRST: FloorBandForm = { from: '0', to: '0', mult: '1' };

  it('renders a band’s three fields', async () => {
    await render(<FloorBandEditor bands={[FIRST]} onChange={jest.fn()} />);
    expect(screen.getByTestId('band-from-0')).toBeTruthy();
    expect(screen.getByTestId('band-to-0')).toBeTruthy();
    expect(screen.getByTestId('band-mult-0')).toBeTruthy();
  });

  it('adds a band that starts just above the last one', async () => {
    const onChange = jest.fn();
    await render(
      <FloorBandEditor bands={[{ from: '0', to: '4', mult: '1' }]} onChange={onChange} />,
    );

    await fireEvent.press(screen.getByText('Add band'));

    expect(onChange).toHaveBeenCalledWith([
      { from: '0', to: '4', mult: '1' },
      { from: '5', to: '5', mult: '1' },
    ]);
  });

  it('removes the band it was pressed on', async () => {
    const onChange = jest.fn();
    await render(<FloorBandEditor bands={[FIRST]} onChange={onChange} />);

    await fireEvent.press(screen.getByText('Remove band'));

    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('reports touching bands as a table problem', async () => {
    await render(
      <FloorBandEditor
        bands={[
          { from: '0', to: '4', mult: '1' },
          { from: '4', to: '6', mult: '1' },
        ]}
        onChange={jest.fn()}
      />,
    );
    expect(screen.getByText('Floor 4 is in more than one band')).toBeTruthy();
  });

  it('reports a single malformed band', async () => {
    await render(
      <FloorBandEditor bands={[{ from: '5', to: '4', mult: '1' }]} onChange={jest.fn()} />,
    );
    expect(screen.getAllByText(/must not be above/).length).toBeGreaterThan(0);
  });

  it('accepts a zero multiplier as exempt, not empty', async () => {
    await render(
      <FloorBandEditor bands={[{ from: '0', to: '0', mult: '0' }]} onChange={jest.fn()} />,
    );
    expect(screen.queryByText(/zero or more/)).toBeNull();
    expect(screen.getByTestId('band-mult-0')).toBeTruthy();
  });
});

describe('ParticipantValueRow', () => {
  it('labels the field with the flat number and shows the member beneath', async () => {
    await render(
      <ParticipantValueRow
        apartmentNumber="A-101"
        memberName="Owner A1"
        value="1"
        onChangeText={jest.fn()}
        testID="row-1"
      />,
    );
    expect(screen.getByLabelText('A-101')).toBeTruthy();
    expect(screen.getByText('Owner A1')).toBeTruthy();
    expect(screen.getByTestId('row-1')).toBeTruthy();
  });

  it('shows the error as supporting text', async () => {
    await render(
      <ParticipantValueRow
        apartmentNumber="A-102"
        value="x"
        error="Invalid"
        onChangeText={jest.fn()}
      />,
    );
    expect(screen.getByText('Invalid')).toBeTruthy();
  });
});
