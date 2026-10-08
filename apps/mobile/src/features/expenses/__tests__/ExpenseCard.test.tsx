import { render, screen, fireEvent } from '@testing-library/react-native';

import { makeExpense } from '../__fixtures__/expense-fixtures';
import { ExpenseCard } from '../components/ExpenseCard';

describe('ExpenseCard', () => {
  it('renders the amount formatted from integer paise, the title and the date', async () => {
    await render(<ExpenseCard expense={makeExpense()} />);

    expect(screen.getByText('Lift AMC')).toBeTruthy();
    expect(screen.getByText('₹45,000.00')).toBeTruthy();
    expect(screen.getByText('30 Sep 2026')).toBeTruthy();
  });

  it('renders the status label from the closed vocabulary', async () => {
    await render(<ExpenseCard expense={makeExpense({ status: 'pending_approval' })} />);
    expect(screen.getByText('Awaiting approval')).toBeTruthy();
  });

  it('shows the category name when one is resolved', async () => {
    await render(<ExpenseCard expense={makeExpense()} categoryName="Maintenance" />);
    expect(screen.getByText('30 Sep 2026 · Maintenance')).toBeTruthy();
  });

  it('shows an edited chip only when the version is above one', async () => {
    const view = await render(<ExpenseCard expense={makeExpense({ version: 1 })} />);
    expect(screen.queryByText(/Edited/)).toBeNull();

    await view.rerender(<ExpenseCard expense={makeExpense({ version: 3 })} />);
    expect(screen.getByText('Edited · v3')).toBeTruthy();
  });

  it('calls onPress when the row is tapped', async () => {
    const onPress = jest.fn();
    await render(<ExpenseCard expense={makeExpense()} onPress={onPress} />);

    await fireEvent.press(screen.getByText('Lift AMC'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
