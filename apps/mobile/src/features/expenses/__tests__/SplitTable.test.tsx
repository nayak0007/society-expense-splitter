import { render, screen } from '@testing-library/react-native';

import { makeSplit } from '../__fixtures__/expense-fixtures';
import { SplitTable } from '../components/SplitTable';

describe('SplitTable', () => {
  it('renders one row per split with its amount and flat', async () => {
    await render(
      <SplitTable
        amountPaise={3_000_000}
        splits={[
          makeSplit({ id: 's1', apartmentNumber: 'A1', amountPaise: 1_500_000 }),
          makeSplit({
            id: 's2',
            apartmentNumber: 'A2',
            memberName: 'Owner A2',
            amountPaise: 1_500_000,
          }),
        ]}
      />,
    );

    expect(screen.getByText('A1')).toBeTruthy();
    expect(screen.getByText('A2')).toBeTruthy();
    expect(screen.getAllByText('₹15,000.00')).toHaveLength(2);
  });

  it('totals the rows in integer paise', async () => {
    await render(
      <SplitTable
        amountPaise={1_000_003}
        splits={[
          makeSplit({ id: 's1', amountPaise: 333_334 }),
          makeSplit({ id: 's2', amountPaise: 333_334 }),
          makeSplit({ id: 's3', amountPaise: 333_335 }),
        ]}
      />,
    );

    expect(screen.getByText('Total · 3 flats')).toBeTruthy();
    // 333,334 + 333,334 + 333,335 = 1,000,003 paise = ₹10,000.03 — exact.
    expect(screen.getByText('₹10,000.03')).toBeTruthy();
  });

  it('labels an unaddressed row rather than dropping it', async () => {
    await render(
      <SplitTable
        amountPaise={100}
        splits={[
          makeSplit({
            id: 's1',
            apartmentNumber: null,
            memberName: null,
            amountPaise: 100,
          }),
        ]}
      />,
    );

    expect(screen.getByText('Unassigned')).toBeTruthy();
    expect(screen.getByText('No member assigned')).toBeTruthy();
  });

  it('says so when there is no allocation yet', async () => {
    await render(<SplitTable amountPaise={100} splits={[]} />);
    expect(screen.getByText('This expense has not been split yet.')).toBeTruthy();
  });

  it('warns when the rows do not reconcile with the bill amount', async () => {
    await render(<SplitTable amountPaise={999} splits={[makeSplit({ amountPaise: 100 })]} />);
    expect(screen.getByText(/does not match the bill's/)).toBeTruthy();
  });
});
