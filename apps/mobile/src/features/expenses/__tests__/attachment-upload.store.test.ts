import {
  abandonOtherScopes,
  bindStagedToExpense,
  clearScope,
  createUpload,
  failUpload,
  hasActiveUpload,
  listStaged,
  listUploads,
  patchUpload,
  readUpload,
  registerUploadAbort,
  removeUpload,
  resetAllUploads,
  subscribeUploads,
  uploadsSnapshot,
} from '../services/attachment-upload.store';
import type { NewAttachmentUpload } from '../services/attachment-upload.store';

/**
 * The upload register (T076 §7/§8).
 *
 * The store is the only thing that knows how far an upload got, so these tests are about
 * **recovery and isolation**: an item remembers its step, a retry resumes from it, a
 * society switch cannot leave another tenant's item behind, and a staged file is adopted
 * exactly once.
 */
function newItem(overrides: Partial<NewAttachmentUpload> = {}): NewAttachmentUpload {
  return {
    scope: 'soc-1:user-1',
    expenseId: 'exp-1',
    fileName: 'bill.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 120_000,
    checksum: 'a'.repeat(64),
    uri: 'file:///cache/bill.jpg',
    isImage: true,
    width: 1600,
    height: 1200,
    state: 'ready',
    step: 'reserve',
    ...overrides,
  };
}

beforeEach(() => {
  resetAllUploads();
});

describe('attachment upload store', () => {
  it('records an item with its starting progress and no reservation', () => {
    const key = createUpload(newItem());
    const item = readUpload(key);

    expect(item).not.toBeNull();
    expect(item?.state).toBe('ready');
    expect(item?.progress).toBe(0);
    expect(item?.attachmentId).toBeNull();
    expect(item?.error).toBeNull();
    expect(item?.reservation).toBeNull();
  });

  it('gives every item its own key, even when two files share a name', () => {
    const first = createUpload(newItem());
    const second = createUpload(newItem());
    expect(first).not.toBe(second);
    expect(uploadsSnapshot()).toHaveLength(2);
  });

  it('keeps the snapshot reference stable between mutations', () => {
    createUpload(newItem());
    const before = uploadsSnapshot();
    expect(uploadsSnapshot()).toBe(before);
  });

  it('notifies subscribers on a change and stops after an unsubscribe', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeUploads(listener);

    const key = createUpload(newItem());
    expect(listener).toHaveBeenCalledTimes(1);

    patchUpload(key, { progress: 0.5 });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(readUpload(key)?.progress).toBe(0.5);

    unsubscribe();
    patchUpload(key, { progress: 0.9 });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('remembers the failed step so a retry can resume rather than restart', () => {
    const key = createUpload(newItem());
    patchUpload(key, { state: 'confirming', attachmentId: 'att-1' });
    failUpload(key, 'confirm', 'Verification failed.');

    const item = readUpload(key);
    expect(item?.state).toBe('failed');
    expect(item?.step).toBe('confirm');
    expect(item?.error).toBe('Verification failed.');
    // The reservation identity survives a failure — that is what makes the retry safe.
    expect(item?.attachmentId).toBe('att-1');
    expect(item?.progress).toBe(0);
  });

  it('lists only the items of one expense in one scope', () => {
    createUpload(newItem());
    createUpload(newItem({ expenseId: 'exp-2' }));
    createUpload(newItem({ scope: 'soc-2:user-9' }));

    expect(listUploads('soc-1:user-1', 'exp-1')).toHaveLength(1);
    expect(listUploads('soc-1:user-1', 'exp-2')).toHaveLength(1);
    expect(listUploads(null, 'exp-1')).toHaveLength(0);
  });

  describe('scope isolation', () => {
    it('drops one scope and leaves the other alone', () => {
      createUpload(newItem());
      createUpload(newItem({ scope: 'soc-2:user-9' }));

      clearScope('soc-1:user-1');

      expect(uploadsSnapshot()).toHaveLength(1);
      expect(uploadsSnapshot()[0]?.scope).toBe('soc-2:user-9');
    });

    it('abandons every scope except the active one on a switch', () => {
      createUpload(newItem());
      createUpload(newItem({ scope: 'soc-2:user-9' }));

      abandonOtherScopes('soc-2:user-9');

      expect(uploadsSnapshot()).toHaveLength(1);
      expect(uploadsSnapshot()[0]?.scope).toBe('soc-2:user-9');
    });

    it('aborts an in-flight transport when its scope is cleared', () => {
      const key = createUpload(newItem());
      const controller = new AbortController();
      registerUploadAbort(key, controller);

      clearScope('soc-1:user-1');

      expect(controller.signal.aborted).toBe(true);
    });

    it('aborts an in-flight transport when the item is removed directly', () => {
      const key = createUpload(newItem());
      const controller = new AbortController();
      registerUploadAbort(key, controller);

      removeUpload(key);

      expect(controller.signal.aborted).toBe(true);
      expect(readUpload(key)).toBeNull();
    });
  });

  describe('staged files for an unsaved expense', () => {
    it('starts with no parent and is adopted exactly once', () => {
      createUpload(newItem({ expenseId: null }));

      expect(listStaged('soc-1:user-1')).toHaveLength(1);

      const adopted = bindStagedToExpense('soc-1:user-1', 'exp-new');

      expect(adopted).toHaveLength(1);
      expect(adopted[0]?.expenseId).toBe('exp-new');
      expect(listStaged('soc-1:user-1')).toHaveLength(0);
      expect(listUploads('soc-1:user-1', 'exp-new')).toHaveLength(1);

      // A second call adopts nothing: the file now belongs to one expense.
      expect(bindStagedToExpense('soc-1:user-1', 'exp-other')).toHaveLength(0);
    });

    it('never adopts another scope’s staged file', () => {
      createUpload(newItem({ expenseId: null, scope: 'soc-2:user-9' }));
      expect(bindStagedToExpense('soc-1:user-1', 'exp-new')).toHaveLength(0);
    });
  });

  describe('duplicate prevention', () => {
    it('treats the same checksum as the same upload while it is in flight', () => {
      createUpload(newItem());

      expect(
        hasActiveUpload('soc-1:user-1', 'exp-1', {
          uri: 'file:///cache/other.jpg',
          checksum: 'a'.repeat(64),
        }),
      ).toBe(true);
    });

    it('permits re-attaching a file after a success or a failure', () => {
      const key = createUpload(newItem());
      patchUpload(key, { state: 'completed' });
      expect(
        hasActiveUpload('soc-1:user-1', 'exp-1', {
          uri: 'file:///x.jpg',
          checksum: 'a'.repeat(64),
        }),
      ).toBe(false);

      patchUpload(key, { state: 'failed' });
      expect(
        hasActiveUpload('soc-1:user-1', 'exp-1', {
          uri: 'file:///x.jpg',
          checksum: 'a'.repeat(64),
        }),
      ).toBe(false);
    });

    it('falls back to the URI when no checksum is known yet', () => {
      createUpload(newItem({ checksum: null, uri: 'file:///cache/bill.jpg' }));
      expect(
        hasActiveUpload('soc-1:user-1', 'exp-1', {
          uri: 'file:///cache/bill.jpg',
          checksum: null,
        }),
      ).toBe(true);
    });

    it('does not confuse two different expenses', () => {
      createUpload(newItem());
      expect(
        hasActiveUpload('soc-1:user-1', 'exp-2', {
          uri: 'file:///x.jpg',
          checksum: 'a'.repeat(64),
        }),
      ).toBe(false);
    });
  });
});
