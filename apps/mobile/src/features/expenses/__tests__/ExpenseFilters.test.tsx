import { render, screen, fireEvent } from '@testing-library/react-native';

import {
  EMPTY_EXPENSE_FILTERS,
  ExpenseFilters,
  hasActiveFilters,
  toExpenseListQuery,
} from '../components/ExpenseFilters';

const CATEGORIES = [
  { id: 'cat-1', name: 'Maintenance' },
  { id: 'cat-2', name: 'Utilities' },
];
const BUILDINGS = [{ id: 'bld-1', name: 'North Block' }];

describe('ExpenseFilters', () => {
  it('renders the status, category and building controls', async () => {
    await render(
      <ExpenseFilters
        values={EMPTY_EXPENSE_FILTERS}
        onChange={jest.fn()}
        categoryOptions={CATEGORIES}
        buildingOptions={BUILDINGS}
      />,
    );

    expect(screen.getByText('Status')).toBeTruthy();
    expect(screen.getByText('Category')).toBeTruthy();
    expect(screen.getByText('Building')).toBeTruthy();
    expect(screen.getByText('All categories')).toBeTruthy();
    expect(screen.getByText('North Block')).toBeTruthy();
  });

  it('reports a changed search term', async () => {
    const onChange = jest.fn();
    await render(
      <ExpenseFilters
        values={EMPTY_EXPENSE_FILTERS}
        onChange={onChange}
        categoryOptions={CATEGORIES}
        buildingOptions={BUILDINGS}
      />,
    );

    await fireEvent.changeText(screen.getByLabelText('Search'), 'lift');
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_EXPENSE_FILTERS, q: 'lift' });
  });

  it('reports a chosen status chip', async () => {
    const onChange = jest.fn();
    await render(
      <ExpenseFilters
        values={EMPTY_EXPENSE_FILTERS}
        onChange={onChange}
        categoryOptions={CATEGORIES}
        buildingOptions={BUILDINGS}
      />,
    );

    await fireEvent.press(screen.getByLabelText('Published'));
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_EXPENSE_FILTERS, status: 'published' });
  });

  it('reports a chosen category and building, and clears them with "All"', async () => {
    const onChange = jest.fn();
    await render(
      <ExpenseFilters
        values={{ ...EMPTY_EXPENSE_FILTERS, categoryId: 'cat-1', buildingId: 'bld-1' }}
        onChange={onChange}
        categoryOptions={CATEGORIES}
        buildingOptions={BUILDINGS}
      />,
    );

    await fireEvent.press(screen.getByLabelText('Utilities'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ categoryId: 'cat-2' }));

    await fireEvent.press(screen.getByLabelText('All buildings'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ buildingId: null }));
  });

  it('shows a clear control only when a filter is active, and resets', async () => {
    await render(
      <ExpenseFilters
        values={EMPTY_EXPENSE_FILTERS}
        onChange={jest.fn()}
        categoryOptions={CATEGORIES}
        buildingOptions={BUILDINGS}
      />,
    );
    expect(screen.queryByText('Clear filters')).toBeNull();

    const onChange = jest.fn();
    await render(
      <ExpenseFilters
        values={{ ...EMPTY_EXPENSE_FILTERS, q: 'x' }}
        onChange={onChange}
        categoryOptions={CATEGORIES}
        buildingOptions={BUILDINGS}
      />,
    );
    await fireEvent.press(screen.getByText('Clear filters'));
    expect(onChange).toHaveBeenCalledWith(EMPTY_EXPENSE_FILTERS);
  });
});

describe('toExpenseListQuery', () => {
  it('omits every unset field, so "no filter" is no filter', () => {
    expect(toExpenseListQuery(EMPTY_EXPENSE_FILTERS)).toEqual({});
  });

  it('maps the chips and the search term', () => {
    expect(
      toExpenseListQuery({
        ...EMPTY_EXPENSE_FILTERS,
        q: '  lift ',
        status: 'published',
        categoryId: 'cat-1',
        buildingId: 'bld-1',
      }),
    ).toEqual({
      q: 'lift',
      status: 'published',
      categoryId: 'cat-1',
      buildingId: 'bld-1',
    });
  });

  it('drops an incomplete date and a non-numeric amount rather than sending garbage', () => {
    expect(
      toExpenseListQuery({
        ...EMPTY_EXPENSE_FILTERS,
        dateFrom: '2026-1',
        dateTo: '2026-09-30',
        amountMin: '12a',
        amountMax: '500000',
      }),
    ).toEqual({ dateTo: '2026-09-30', amountPaiseMax: 500_000 });
  });

  it('keeps a syntactically complete date', () => {
    expect(toExpenseListQuery({ ...EMPTY_EXPENSE_FILTERS, dateFrom: '2026-01-01' })).toEqual({
      dateFrom: '2026-01-01',
    });
  });
});

describe('hasActiveFilters', () => {
  it('is false for the empty state and true for any set field', () => {
    expect(hasActiveFilters(EMPTY_EXPENSE_FILTERS)).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_EXPENSE_FILTERS, q: 'x' })).toBe(true);
    expect(hasActiveFilters({ ...EMPTY_EXPENSE_FILTERS, status: 'draft' })).toBe(true);
    expect(hasActiveFilters({ ...EMPTY_EXPENSE_FILTERS, amountMin: '1' })).toBe(true);
  });
});
