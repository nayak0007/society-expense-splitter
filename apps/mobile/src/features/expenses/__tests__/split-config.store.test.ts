import { emptySplitState } from '../schemas/split.schemas';
import {
  clearSplitWorkspace,
  ensureSplitWorkspace,
  readSplitWorkspace,
  resetAllSplitWorkspaces,
  resetSplitState,
  subscribeSplitWorkspace,
  updateSplitContext,
  updateSplitState,
} from '../services/split-config.store';

/**
 * The split workspace (T075 §2): the in-session channel that carries a configuration between
 * the form, the configurator and the participant selector without a server write and without a
 * deep-link payload. It is keyed by the *draft key*, so this suite is mostly about isolation:
 * one member's half-configured split must never surface in another's form.
 */

const KEY = 'ses/expense-draft/soc-1/new/user-1';

beforeEach(() => {
  resetAllSplitWorkspaces();
});

describe('readSplitWorkspace', () => {
  it('has nothing for a key nobody seeded, and nothing for a null key', () => {
    expect(readSplitWorkspace(KEY)).toBeNull();
    expect(readSplitWorkspace(null)).toBeNull();
  });
});

describe('ensureSplitWorkspace', () => {
  it('creates a workspace with a neutral state and empty context', () => {
    const workspace = ensureSplitWorkspace(KEY);
    expect(workspace.state.strategy).toBe('equal');
    expect(workspace.context).toEqual({
      amountPaise: null,
      categoryId: null,
      defaultStrategy: null,
    });
    expect(readSplitWorkspace(KEY)).toEqual(workspace);
  });

  it('applies the initial state only on first use', () => {
    ensureSplitWorkspace(KEY, { state: emptySplitState() });
    updateSplitState(KEY, { strategy: 'shares' });
    // A second ensure must not stomp what the configurator has since written.
    ensureSplitWorkspace(KEY, { state: emptySplitState() });
    expect(readSplitWorkspace(KEY)?.state.strategy).toBe('shares');
  });

  it('never stomps a live configuration with a later initial', () => {
    // The §2 hazard: a screen that seeds on mount must not overwrite edits made since.
    ensureSplitWorkspace(KEY);
    updateSplitContext(KEY, { amountPaise: 42, categoryId: 'cat-1', defaultStrategy: 'equal' });
    updateSplitState(KEY, { strategy: 'custom' });

    const returned = ensureSplitWorkspace(KEY, {
      state: emptySplitState(),
      context: { amountPaise: 999, categoryId: null, defaultStrategy: null },
    });

    expect(returned.state.strategy).toBe('custom');
    expect(returned.context.amountPaise).toBe(42);
  });
});

describe('isolation between users, societies and expenses', () => {
  it('keeps four workspaces apart', () => {
    const otherUser = 'ses/expense-draft/soc-1/new/user-2';
    const otherSociety = 'ses/expense-draft/soc-2/new/user-1';
    const otherExpense = 'ses/expense-draft/soc-1/exp-9/user-1';

    updateSplitState(KEY, { strategy: 'percentage' });
    updateSplitState(otherUser, { strategy: 'shares' });
    updateSplitState(otherSociety, { strategy: 'custom' });
    updateSplitState(otherExpense, { strategy: 'apartment', basis: 'per_bhk' });

    expect(readSplitWorkspace(KEY)?.state.strategy).toBe('percentage');
    expect(readSplitWorkspace(otherUser)?.state.strategy).toBe('shares');
    expect(readSplitWorkspace(otherSociety)?.state.strategy).toBe('custom');
    expect(readSplitWorkspace(otherExpense)?.state.basis).toBe('per_bhk');
  });
});

describe('updateSplitState and updateSplitContext leave each other alone', () => {
  it('patches only the field it names', () => {
    updateSplitContext(KEY, {
      amountPaise: 100000,
      categoryId: 'cat-1',
      defaultStrategy: 'shares',
    });
    updateSplitState(KEY, { strategy: 'shares' });

    const workspace = readSplitWorkspace(KEY);
    expect(workspace?.state.strategy).toBe('shares');
    expect(workspace?.state.basis).toBeNull();
    expect(workspace?.context).toEqual({
      amountPaise: 100000,
      categoryId: 'cat-1',
      defaultStrategy: 'shares',
    });
  });
});

describe('reset and clear', () => {
  it('resets the configuration but keeps the context', () => {
    updateSplitContext(KEY, { amountPaise: 42, categoryId: 'cat-1', defaultStrategy: 'equal' });
    updateSplitState(KEY, { strategy: 'custom' });

    resetSplitState(KEY);

    const workspace = readSplitWorkspace(KEY);
    expect(workspace?.state.strategy).toBe('equal');
    expect(workspace?.context.amountPaise).toBe(42);
  });

  it('clears only the addressed workspace, and tolerates a null key', () => {
    const other = 'ses/expense-draft/soc-1/new/user-2';
    updateSplitState(KEY, { strategy: 'custom' });
    updateSplitState(other, { strategy: 'shares' });

    clearSplitWorkspace(KEY);
    clearSplitWorkspace(null);

    expect(readSplitWorkspace(KEY)).toBeNull();
    expect(readSplitWorkspace(other)?.state.strategy).toBe('shares');
  });
});

describe('subscription', () => {
  it('notifies a subscriber on every change to its key', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeSplitWorkspace(KEY, listener);

    updateSplitState(KEY, { strategy: 'shares' });
    updateSplitContext(KEY, { amountPaise: 7 });
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    updateSplitState(KEY, { strategy: 'custom' });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('does not notify another key’s subscriber', () => {
    const other = jest.fn();
    subscribeSplitWorkspace('ses/expense-draft/soc-1/new/user-2', other);

    updateSplitState(KEY, { strategy: 'shares' });

    expect(other).not.toHaveBeenCalled();
  });

  it('notifies on a clear, so a mounted screen can drop its state', () => {
    const listener = jest.fn();
    subscribeSplitWorkspace(KEY, listener);

    clearSplitWorkspace(KEY);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('is a no-op subscribable for a null key', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeSplitWorkspace(null, listener);
    expect(() => {
      unsubscribe();
    }).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
  });
});
