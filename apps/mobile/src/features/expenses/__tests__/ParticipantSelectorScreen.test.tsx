import { fireEvent, render, screen } from '@testing-library/react-native';
import { asSocietyId } from '@ses/domain';

import { useAuthStore } from '@/stores/auth.store';
import { useSocietyStore } from '@/stores/society.store';

import type { RosterResult } from '../hooks/use-split-preview';

/**
 * The participant selector (T075 §7, PRD §3.5.4).
 *
 * The two read hooks are mocked (the building list and the server's roster); everything the
 * screen owns is real — the selector lives in the shared split workspace, so every assertion
 * below is "the edit landed in the workspace the parent form reads", and Done is asserted to
 * return without a server write.
 */
const mockBack = jest.fn();
const mockPush = jest.fn();
const mockParams: { expenseId?: string } = {};

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ back: mockBack, push: mockPush }),
}));

jest.mock('../hooks/use-expenses', () => ({
  useExpenseBuildingOptions: () => ({
    buildings: [
      { id: 'b1', name: 'Tower A' },
      { id: 'b2', name: 'Tower B' },
    ],
  }),
}));

let mockRoster: RosterResult = makeRoster();

function makeRoster(): RosterResult {
  return {
    roster: [
      { apartmentId: 'ap1', apartmentNumber: 'A-101', memberId: 'm1' },
      { apartmentId: 'ap2', apartmentNumber: 'A-102', memberId: 'm2' },
    ],
    isLoading: false,
    error: null,
  };
}

jest.mock('../hooks/use-split-preview', () => ({
  useParticipantRoster: () => mockRoster,
}));

import ParticipantSelectorScreen from '../screens/ParticipantSelectorScreen';
import { emptySplitState } from '../schemas/split.schemas';
import type { ParticipantSelectorForm, SplitFormState } from '../schemas/split.schemas';
import { expenseDraftKey } from '../services/expense-draft.store';
import {
  ensureSplitWorkspace,
  readSplitWorkspace,
  resetAllSplitWorkspaces,
} from '../services/split-config.store';

const KEY =
  expenseDraftKey({ userId: 'user-1', societyId: asSocietyId('soc-1'), expenseId: null }) ?? '';

function seed(state: Partial<SplitFormState> = {}): void {
  ensureSplitWorkspace(KEY, {
    state: { ...emptySplitState(), ...state },
    context: { amountPaise: 10_000, categoryId: 'cat-1', defaultStrategy: 'equal' },
  });
}

function selector(): ParticipantSelectorForm {
  const workspace = readSplitWorkspace(KEY);
  if (workspace === null) throw new Error('no workspace');
  return workspace.state.selector;
}

beforeEach(() => {
  mockBack.mockClear();
  mockPush.mockClear();
  delete mockParams.expenseId;
  resetAllSplitWorkspaces();
  useAuthStore.setState({ user: { id: 'user-1', email: null } });
  useSocietyStore.setState({ memberships: [], activeSocietyId: asSocietyId('soc-1') });
  mockRoster = makeRoster();
});

describe('ParticipantSelectorScreen', () => {
  it('renders the eight dimensions and the server-resolved flat list', async () => {
    seed();
    await render(<ParticipantSelectorScreen />);

    expect(screen.getByText('Who is charged')).toBeTruthy();
    expect(screen.getByText('Scope')).toBeTruthy();
    expect(screen.getByText('Occupancy')).toBeTruthy();
    expect(screen.getByText('Vacant flats')).toBeTruthy();
    // "Owner only" is both the group label and one of its two chips.
    expect(screen.getAllByText('Owner only').length).toBeGreaterThan(0);
    expect(screen.getByText('Floors')).toBeTruthy();
    expect(screen.getByText('Wings')).toBeTruthy();
    expect(screen.getByText('A-101')).toBeTruthy();
    expect(screen.getByText('A-102')).toBeTruthy();
  });

  it('records a scope change in the workspace', async () => {
    seed();
    await render(<ParticipantSelectorScreen />);

    await fireEvent.press(screen.getByLabelText('Selected buildings'));

    expect(selector().scope).toBe('building');
  });

  it('adds and removes buildings from the selection', async () => {
    seed();
    await render(<ParticipantSelectorScreen />);

    await fireEvent.press(screen.getByLabelText('Tower A'));
    expect(selector().buildings).toEqual(['b1']);

    await fireEvent.press(screen.getByLabelText('Tower B'));
    expect(selector().buildings).toEqual(['b1', 'b2']);

    await fireEvent.press(screen.getByLabelText('Tower A'));
    expect(selector().buildings).toEqual(['b2']);
  });

  it('records occupancy toggles', async () => {
    seed();
    await render(<ParticipantSelectorScreen />);

    await fireEvent.press(screen.getByLabelText('Rented'));

    expect(selector().occupancy).toEqual(['rented']);
  });

  it('sets the vacant-flat tri-state, including back to the society default', async () => {
    seed();
    await render(<ParticipantSelectorScreen />);

    await fireEvent.press(screen.getByLabelText('Include'));
    expect(selector().includeVacant).toBe(true);

    await fireEvent.press(screen.getByLabelText('Exclude'));
    expect(selector().includeVacant).toBe(false);

    await fireEvent.press(screen.getByLabelText('Society default'));
    expect(selector().includeVacant).toBeNull();
  });

  it('records the owner-only choice', async () => {
    seed();
    await render(<ParticipantSelectorScreen />);

    await fireEvent.press(screen.getByLabelText('Owner only'));

    expect(selector().ownerOnly).toBe(true);
  });

  it('turns a typed floor range into the selector floors and clears it again', async () => {
    seed();
    await render(<ParticipantSelectorScreen />);

    await fireEvent.changeText(screen.getByTestId('floor-from'), '1');
    await fireEvent.changeText(screen.getByTestId('floor-to'), '3');
    await fireEvent.press(screen.getByText('Apply range'));

    expect(selector().floors).toEqual([1, 2, 3]);

    await fireEvent.press(screen.getByText('Clear (3)'));
    expect(selector().floors).toEqual([]);
  });

  it('ignores an inverted floor range', async () => {
    seed();
    await render(<ParticipantSelectorScreen />);

    await fireEvent.changeText(screen.getByTestId('floor-from'), '4');
    await fireEvent.changeText(screen.getByTestId('floor-to'), '1');
    await fireEvent.press(screen.getByText('Apply range'));

    expect(selector().floors).toEqual([]);
  });

  it('adds a typed wing and removes it again', async () => {
    seed();
    await render(<ParticipantSelectorScreen />);

    await fireEvent.changeText(screen.getByTestId('wing-draft'), 'B');
    await fireEvent.press(screen.getByText('Add'));

    expect(selector().wings).toEqual(['B']);

    await fireEvent.press(screen.getByLabelText('Remove wing B'));
    expect(selector().wings).toEqual([]);
  });

  it('excludes and re-includes a flat from the resolved roster', async () => {
    seed();
    await render(<ParticipantSelectorScreen />);

    await fireEvent.press(screen.getByLabelText('Exclude A-102'));
    expect(selector().excludeApartments).toEqual(['ap2']);

    await fireEvent.press(screen.getByLabelText('Include A-102'));
    expect(selector().excludeApartments).toEqual([]);
  });

  it('reports an empty resolution instead of an empty list', async () => {
    mockRoster = { roster: [], isLoading: false, error: null };
    seed();
    await render(<ParticipantSelectorScreen />);

    expect(screen.getByText('No flats match this selection.')).toBeTruthy();
  });

  it('returns to the form on Done with no server write', async () => {
    seed();
    await render(<ParticipantSelectorScreen />);

    await fireEvent.press(screen.getByLabelText('Exclude A-101'));
    await fireEvent.press(screen.getByText('Done'));

    expect(mockBack).toHaveBeenCalledTimes(1);
    // The edit survives the return — the parent form reads it from the same workspace.
    expect(selector().excludeApartments).toEqual(['ap1']);
  });
});
