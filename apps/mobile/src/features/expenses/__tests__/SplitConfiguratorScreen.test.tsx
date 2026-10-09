import { fireEvent, render, screen } from '@testing-library/react-native';
import { asSocietyId } from '@ses/domain';

import { useAuthStore } from '@/stores/auth.store';
import { useSocietyStore } from '@/stores/society.store';

import type { RosterResult } from '../hooks/use-split-preview';
import type { SplitPreviewState } from '../hooks/use-split-preview';

/**
 * The split configurator (T075 §3–§5, §12).
 *
 * The preview *hooks* are mocked because a component test must not touch the network or the
 * online manager; everything the screen owns is real — the shared split workspace (seeded here
 * exactly as the form seeds it), the pure validation, and the routing calls. So "Save is blocked
 * while the percentages are off 100%" and "Done returns without a server write" are assertions
 * about production code.
 */
const mockBack = jest.fn();
const mockPush = jest.fn();
const mockParams: { expenseId?: string } = {};

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ back: mockBack, push: mockPush }),
}));

/** Rebuilt per test so one case's warnings/offline state can never leak into the next. */
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

function makePreview(overrides: Partial<SplitPreviewState> = {}): SplitPreviewState {
  return {
    preview: {
      totalPaise: 10_000,
      participantCount: 2,
      allocations: [
        {
          memberId: 'm1',
          apartmentId: 'ap1',
          apartmentNumber: 'A-101',
          weight: 5000,
          amountPaise: 5000,
        },
        {
          memberId: 'm2',
          apartmentId: 'ap2',
          apartmentNumber: 'A-102',
          weight: 5000,
          amountPaise: 5000,
        },
      ],
      residualPaise: 0,
      warnings: [],
      unassigned: [],
    },
    isLoading: false,
    stale: false,
    error: null,
    offlineNotice: null,
    source: 'online',
    retry: () => undefined,
    ...overrides,
  };
}

// The hook mocks read these late-bound holders, so each test installs a fresh fixture.
let mockRoster: RosterResult = makeRoster();
let mockPreview: SplitPreviewState = makePreview();

jest.mock('../hooks/use-split-preview', () => ({
  useParticipantRoster: () => mockRoster,
  useSplitPreview: () => mockPreview,
}));

import SplitConfiguratorScreen from '../screens/SplitConfiguratorScreen';
import { emptySplitState } from '../schemas/split.schemas';
import type { SplitFormState } from '../schemas/split.schemas';
import { expenseDraftKey } from '../services/expense-draft.store';
import { ensureSplitWorkspace, resetAllSplitWorkspaces } from '../services/split-config.store';

const KEY =
  expenseDraftKey({ userId: 'user-1', societyId: asSocietyId('soc-1'), expenseId: null }) ?? '';

/** Seed the workspace the way the parent form does, then mount the configurator. */
function seed(state: Partial<SplitFormState>, amountPaise: number | null): void {
  ensureSplitWorkspace(KEY, {
    state: { ...emptySplitState(), ...state },
    context: { amountPaise, categoryId: 'cat-1', defaultStrategy: 'equal' },
  });
}

beforeEach(() => {
  mockBack.mockClear();
  mockPush.mockClear();
  delete mockParams.expenseId;
  resetAllSplitWorkspaces();
  useAuthStore.setState({ user: { id: 'user-1', email: null } });
  useSocietyStore.setState({ memberships: [], activeSocietyId: asSocietyId('soc-1') });
  mockRoster = makeRoster();
  mockPreview = makePreview();
});

describe('SplitConfiguratorScreen', () => {
  it('shows the current method, the roster count and the editing controls', async () => {
    seed({ strategy: 'shares' }, 10_000);
    await render(<SplitConfiguratorScreen />);

    // "Shares" appears both as the header summary and as a chip in the method selector.
    expect(screen.getAllByText('Shares').length).toBeGreaterThan(0);
    expect(screen.getByText('2 flats matched')).toBeTruthy();
    expect(screen.getByText('Shares per flat')).toBeTruthy();
    expect(screen.getByText('Done')).toBeTruthy();
  });

  it('shows the percentage total and blocks Done until it reaches 100%', async () => {
    seed({ strategy: 'percentage', percentages: { ap1: '40' } }, 10_000);
    await render(<SplitConfiguratorScreen />);

    expect(screen.getByText('40.00%')).toBeTruthy();
    // The sentence appears both in the percentage editor and in the screen-level notice.
    expect(screen.getAllByText(/Percentages must total 100.00%/).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();
  });

  it('lets Done return once the configuration is coherent, without a server write', async () => {
    seed({ strategy: 'percentage', percentages: { ap1: '40', ap2: '60' } }, 10_000);
    await render(<SplitConfiguratorScreen />);

    expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
    await fireEvent.press(screen.getByText('Done'));

    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it('asks for an amount first when the form has none', async () => {
    seed({ strategy: 'equal' }, null);
    await render(<SplitConfiguratorScreen />);

    expect(
      screen.getByText('Enter an amount on the expense form first — the preview needs it.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();
  });

  it('opens the participant selector', async () => {
    seed({ strategy: 'equal' }, 10_000);
    await render(<SplitConfiguratorScreen />);

    await fireEvent.press(screen.getByText('Edit selection'));

    expect(mockPush).toHaveBeenCalledWith({ pathname: '/(app)/expenses/participants', params: {} });
  });

  it('renders the engine warnings and the unassigned flats', async () => {
    mockPreview = makePreview({
      preview: {
        ...makePreview().preview!,
        warnings: [
          { code: 'MISSING_AREA', message: 'A-109 has no area recorded.', apartmentIds: ['ap9'] },
        ],
        unassigned: [
          { apartmentId: 'ap3', apartmentNumber: 'A-103', reason: 'unassigned_no_owner' },
        ],
      },
    });
    seed({ strategy: 'equal' }, 10_000);
    await render(<SplitConfiguratorScreen />);

    expect(screen.getByText('Warnings')).toBeTruthy();
    expect(screen.getByText('MISSING_AREA: A-109 has no area recorded.')).toBeTruthy();
    expect(screen.getByText('Unassigned flats')).toBeTruthy();
    expect(screen.getByText('A-103 — no owner on record')).toBeTruthy();
  });

  it('surfaces the explicit offline state instead of inventing numbers', async () => {
    mockPreview = makePreview({
      preview: null,
      offlineNotice:
        'Offline preview unavailable — no resolved participant snapshot is held on this device.',
    });
    seed({ strategy: 'equal' }, 10_000);
    await render(<SplitConfiguratorScreen />);

    expect(
      screen.getByText(
        'Offline preview unavailable — no resolved participant snapshot is held on this device.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('Preview')).toBeNull();
  });

  it('shows the refresh cue while a newer preview is in flight over an older one', async () => {
    mockPreview = makePreview({ stale: true });
    seed({ strategy: 'equal' }, 10_000);
    await render(<SplitConfiguratorScreen />);

    expect(screen.getByText('Refreshing the preview…')).toBeTruthy();
    expect(screen.getByText('Preview')).toBeTruthy();
  });
});
