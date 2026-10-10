import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { act, renderHook } from '@testing-library/react-native';
import { asSocietyId } from '@ses/domain';

import { useAuthStore } from '@/stores/auth.store';
import { useSocietyStore } from '@/stores/society.store';

import { useAttachmentScope, useAttachmentUploader } from '../hooks/use-attachment-upload';
import {
  hasActiveUpload,
  readUpload,
  resetAllUploads,
  uploadsSnapshot,
} from '../services/attachment-upload.store';
import { registerExpenseAttachmentsInvalidator } from '../services/expense-query-invalidation';
import type { PreparedAttachment } from '../services/attachment.service';

/**
 * The capture/upload controller (T076 §4/§6/§7).
 *
 * The pipeline itself is covered by its own suites; what only this file can prove is the
 * *flow*: a cancelled picker uploads nothing, a denied permission explains itself instead of
 * throwing, picking a file leaves it **ready** rather than sending it, a double tap cannot
 * enqueue two uploads, and a society switch cannot carry another tenant's file across.
 */

const mockPrepareImage = jest.fn();
const mockPrepareDocument = jest.fn();
// Annotated as `jest.Mock` so its `any`-parameter shape accepts the two-argument runner
// signature the hook composes, rather than the zero-argument shape `jest.fn()` infers.
const mockRun: jest.Mock = jest.fn(async () => undefined);
const mockCancel: jest.Mock = jest.fn();

jest.mock('../services/attachment.service', () => {
  const actual = jest.requireActual('../services/attachment.service');
  return {
    ...actual,
    preparePickedImage: (...args: unknown[]) => mockPrepareImage(...args),
    preparePickedDocument: (...args: unknown[]) => mockPrepareDocument(...args),
  };
});

jest.mock('../services/attachment-upload.service', () => {
  const actual = jest.requireActual('../services/attachment-upload.service');
  return {
    ...actual,
    runAttachmentUpload: (...args: unknown[]) => mockRun(...args),
    cancelAttachmentUpload: (...args: unknown[]) => mockCancel(...args),
  };
});

const picker = ImagePicker as unknown as {
  requestCameraPermissionsAsync: jest.Mock;
  launchCameraAsync: jest.Mock;
  launchImageLibraryAsync: jest.Mock;
};
const documents = DocumentPicker as unknown as { getDocumentAsync: jest.Mock };

function prepared(overrides: Partial<PreparedAttachment> = {}): PreparedAttachment {
  return {
    uri: 'file:///cache/out.jpg',
    fileName: 'bill.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 120_000,
    checksum: 'a'.repeat(64),
    isImage: true,
    width: 1600,
    height: 1200,
    ...overrides,
  };
}

beforeEach(() => {
  resetAllUploads();
  registerExpenseAttachmentsInvalidator(null);
  mockPrepareImage.mockReset().mockResolvedValue(prepared());
  mockPrepareDocument.mockReset().mockResolvedValue(
    prepared({
      uri: 'file:///cache/invoice.pdf',
      fileName: 'invoice.pdf',
      mimeType: 'application/pdf',
      isImage: false,
      width: null,
      height: null,
    }),
  );
  mockRun.mockReset().mockResolvedValue(undefined);
  mockCancel.mockReset();

  picker.requestCameraPermissionsAsync.mockResolvedValue({ granted: true, status: 'granted' });
  picker.launchCameraAsync.mockResolvedValue({ canceled: true, assets: null });
  picker.launchImageLibraryAsync.mockResolvedValue({ canceled: true, assets: null });
  documents.getDocumentAsync.mockResolvedValue({ canceled: true, assets: null });

  useAuthStore.setState({ user: { id: 'user-1', email: null } });
  useSocietyStore.setState({ memberships: [], activeSocietyId: asSocietyId('soc-1') });
});

afterEach(() => {
  registerExpenseAttachmentsInvalidator(null);
});

describe('useAttachmentScope', () => {
  it('keys the session by society and user', async () => {
    const { result } = await renderHook(() => useAttachmentScope());
    expect(result.current).toBe('soc-1:user-1');
  });

  it('has no scope without a session', async () => {
    useAuthStore.setState({ user: null });
    const { result } = await renderHook(() => useAttachmentScope());
    expect(result.current).toBeNull();
  });
});

describe('capture flows', () => {
  it('does nothing at all when the gallery picker is cancelled', async () => {
    const { result } = await renderHook(() => useAttachmentUploader());

    await act(async () => {
      await result.current.chooseImage('exp-1');
    });

    expect(uploadsSnapshot()).toHaveLength(0);
    expect(mockRun).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
  });

  it('prepares a chosen photo into a ready item without uploading it', async () => {
    picker.launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///picked.heic', fileName: 'IMG_9.HEIC', mimeType: 'image/heic' }],
    });
    const { result } = await renderHook(() => useAttachmentUploader());

    await act(async () => {
      await result.current.chooseImage('exp-1');
    });

    const items = uploadsSnapshot();
    expect(items).toHaveLength(1);
    expect(items[0]?.state).toBe('ready');
    expect(items[0]?.expenseId).toBe('exp-1');
    expect(items[0]?.checksum).toBe('a'.repeat(64));
    // The explicit-action rule: a selection is not an upload.
    expect(mockRun).not.toHaveBeenCalled();
    expect(result.current.notice).toBe('Photo ready. Upload it when you are.');
  });

  it('stages a capture for an unsaved expense instead of attaching it', async () => {
    picker.launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///picked.jpg', fileName: 'bill.jpg', mimeType: 'image/jpeg' }],
    });
    const { result } = await renderHook(() => useAttachmentUploader());

    await act(async () => {
      await result.current.chooseImage(null);
    });

    expect(uploadsSnapshot()[0]?.expenseId).toBeNull();
    expect(result.current.notice).toBe(
      'File ready. It will be attached when the expense is saved.',
    );
  });

  it('explains a denied camera permission instead of throwing', async () => {
    picker.requestCameraPermissionsAsync.mockResolvedValue({ granted: false, status: 'denied' });
    const { result } = await renderHook(() => useAttachmentUploader());

    await act(async () => {
      await result.current.takePhoto('exp-1');
    });

    expect(result.current.error).toContain('Camera access is not allowed');
    expect(picker.launchCameraAsync).not.toHaveBeenCalled();
    expect(uploadsSnapshot()).toHaveLength(0);
  });

  it('falls back with a clear message when the camera is unavailable', async () => {
    picker.launchCameraAsync.mockRejectedValue(new Error('no camera'));
    const { result } = await renderHook(() => useAttachmentUploader());

    await act(async () => {
      await result.current.takePhoto('exp-1');
    });

    expect(result.current.error).toBe(
      'The camera is not available on this device. Choose a photo instead.',
    );
  });

  it('captures a photo through the picker, with the crop step the acceptance names', async () => {
    picker.launchCameraAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///shot.jpg', fileName: 'shot.jpg', mimeType: 'image/jpeg' }],
    });
    const { result } = await renderHook(() => useAttachmentUploader());

    await act(async () => {
      await result.current.takePhoto('exp-1');
    });

    expect(picker.launchCameraAsync).toHaveBeenCalledWith(
      expect.objectContaining({ allowsEditing: true, mediaTypes: ['images'] }),
    );
    expect(uploadsSnapshot()).toHaveLength(1);
  });

  it('picks a PDF from the document picker', async () => {
    documents.getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [
        { uri: 'file:///cache/invoice.pdf', name: 'invoice.pdf', mimeType: 'application/pdf' },
      ],
    });
    const { result } = await renderHook(() => useAttachmentUploader());

    await act(async () => {
      await result.current.chooseDocument('exp-1');
    });

    expect(documents.getDocumentAsync).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'application/pdf', copyToCacheDirectory: true }),
    );
    expect(uploadsSnapshot()[0]?.mimeType).toBe('application/pdf');
  });

  it('refuses a file the compressor rejects, without leaving a phantom item', async () => {
    mockPrepareImage.mockRejectedValue(
      Object.assign(new Error('That image could not be read.'), {
        name: 'AttachmentValidationError',
      }),
    );
    picker.launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///broken.jpg', fileName: 'broken.jpg', mimeType: 'image/jpeg' }],
    });
    const { result } = await renderHook(() => useAttachmentUploader());

    await act(async () => {
      await result.current.chooseImage('exp-1');
    });

    // A native failure's raw message is not surfaced — see `preparationFailureMessage`.
    expect(result.current.error).toBe('The upload could not be completed. Please try again.');
    expect(uploadsSnapshot()).toHaveLength(0);
  });
});

describe('explicit upload and duplicate prevention', () => {
  async function withReadyItem(): Promise<{
    readonly controller: { current: ReturnType<typeof useAttachmentUploader> };
    readonly key: string;
  }> {
    picker.launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///picked.jpg', fileName: 'bill.jpg', mimeType: 'image/jpeg' }],
    });
    const { result } = await renderHook(() => useAttachmentUploader());
    await act(async () => {
      await result.current.chooseImage('exp-1');
    });
    const key = uploadsSnapshot()[0]?.key ?? '';
    return { controller: result, key };
  }

  it('starts the upload only when asked', async () => {
    const { controller, key } = await withReadyItem();

    expect(mockRun).not.toHaveBeenCalled();
    await act(async () => {
      controller.current.upload(key);
    });

    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(mockRun.mock.calls[0]?.[0]).toBe(key);
    expect(readUpload(key)?.state).toBe('reserving');
  });

  it('ignores a duplicate tap on an item that is already going', async () => {
    const { controller, key } = await withReadyItem();

    await act(async () => {
      controller.current.upload(key);
      controller.current.upload(key);
      controller.current.upload(key);
    });

    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it('does not retry an item that has not failed', async () => {
    const { controller, key } = await withReadyItem();

    await act(async () => {
      controller.current.retryUpload(key);
    });

    expect(mockRun).not.toHaveBeenCalled();
    expect(readUpload(key)?.state).toBe('ready');
  });

  it('cancels and discards through the store', async () => {
    const { controller, key } = await withReadyItem();

    await act(async () => {
      controller.current.cancelUpload(key);
    });
    expect(mockCancel).toHaveBeenCalledWith(key);

    await act(async () => {
      controller.current.discardUpload(key);
    });
    expect(readUpload(key)).toBeNull();
  });
});

describe('after a draft is saved', () => {
  it('adopts staged files onto the new expense and uploads them', async () => {
    picker.launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///picked.jpg', fileName: 'bill.jpg', mimeType: 'image/jpeg' }],
    });
    const { result } = await renderHook(() => useAttachmentUploader());

    await act(async () => {
      await result.current.chooseImage(null);
    });
    expect(uploadsSnapshot()[0]?.expenseId).toBeNull();

    await act(async () => {
      result.current.uploadAllForExpense('exp-new');
    });

    const item = uploadsSnapshot()[0];
    expect(item?.expenseId).toBe('exp-new');
    expect(item?.state).toBe('reserving');
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(
      hasActiveUpload('soc-1:user-1', 'exp-new', {
        uri: 'file:///cache/out.jpg',
        checksum: 'a'.repeat(64),
      }),
    ).toBe(true);
  });
});

describe('cache refresh and tenant isolation', () => {
  it('asks the app to refresh the bill list once the server confirms', async () => {
    const invalidate = jest.fn();
    registerExpenseAttachmentsInvalidator(invalidate);
    mockRun.mockImplementation(
      async (_key: string, context: { onCompleted?: (id: string) => void }) => {
        context.onCompleted?.('att-1');
        return undefined;
      },
    );

    picker.launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///picked.jpg', fileName: 'bill.jpg', mimeType: 'image/jpeg' }],
    });
    const { result } = await renderHook(() => useAttachmentUploader());
    await act(async () => {
      await result.current.chooseImage('exp-1');
    });
    const key = uploadsSnapshot()[0]?.key ?? '';

    await act(async () => {
      result.current.upload(key);
    });

    expect(invalidate).toHaveBeenCalledWith('exp-1');
  });

  it('abandons another tenant’s items when the active society changes', async () => {
    picker.launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///picked.jpg', fileName: 'bill.jpg', mimeType: 'image/jpeg' }],
    });
    const { result } = await renderHook(() => useAttachmentUploader());
    await act(async () => {
      await result.current.chooseImage('exp-1');
    });
    expect(uploadsSnapshot()).toHaveLength(1);

    await act(async () => {
      useSocietyStore.setState({ memberships: [], activeSocietyId: asSocietyId('soc-2') });
    });

    // Nothing captured under the previous society survives the switch.
    expect(uploadsSnapshot()).toHaveLength(0);
  });
});
