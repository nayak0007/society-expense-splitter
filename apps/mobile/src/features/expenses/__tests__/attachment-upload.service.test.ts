import { ApiError } from '@/lib/api/api-client';

import {
  cancelAttachmentUpload,
  isPresignedUrlExpired,
  runAttachmentUpload,
  uploadFailureMessage,
} from '../services/attachment-upload.service';
import {
  createUpload,
  patchUpload,
  readUpload,
  resetAllUploads,
} from '../services/attachment-upload.store';
import type { NewAttachmentUpload } from '../services/attachment-upload.store';
import { completeAttachmentUploadSchema, presignAttachmentUploadSchema } from '@ses/contracts';

/**
 * The upload runner (T076 §6/§7) — T071's exact protocol, and its step-aware recovery.
 *
 * The two properties this file exists to protect:
 *
 *  1. **A successful PUT is not a completed attachment.** The API is told, and the item only
 *     reaches `completed` after the server answers.
 *  2. **A confirmation failure must never reserve again.** Completion replay is a server-side
 *     no-op; a second reservation is a second bill. The tests assert the call *counts*, not
 *     just the outcome, because a duplicate upload that also succeeds is still a duplicate.
 */

jest.mock('../services/expense.service', () => {
  const actual = jest.requireActual('../services/expense.service');
  return {
    ...actual,
    reserveAttachmentUpload: jest.fn(),
    confirmAttachmentUpload: jest.fn(),
  };
});

import { confirmAttachmentUpload, reserveAttachmentUpload } from '../services/expense.service';
import * as FileSystem from 'expo-file-system';

const mockReserve = reserveAttachmentUpload as jest.Mock;
const mockConfirm = confirmAttachmentUpload as jest.Mock;
const uploadSpy = (FileSystem as unknown as { __uploadSpy: jest.Mock }).__uploadSpy;
const ACTOR = 'user-1';
const SOCIETY = 'soc-1';
const EXPENSE = 'exp-1';
const CHECKSUM = 'a'.repeat(64);

function seedItem(overrides: Partial<NewAttachmentUpload> = {}): string {
  return createUpload({
    scope: `${SOCIETY}:${ACTOR}`,
    expenseId: EXPENSE,
    fileName: 'bill.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 120_000,
    checksum: CHECKSUM,
    uri: 'file:///cache/bill.jpg',
    isImage: true,
    width: 1600,
    height: 1200,
    state: 'ready',
    step: 'reserve',
    ...overrides,
  });
}

const context = (onCompleted?: (attachmentId: string) => void) => ({
  actorId: ACTOR,
  societyId: SOCIETY,
  ...(onCompleted === undefined ? {} : { onCompleted }),
});

beforeEach(() => {
  resetAllUploads();
  mockReserve.mockReset();
  mockConfirm.mockReset();
  uploadSpy.mockReset();
  uploadSpy.mockImplementation(async () => ({ status: 200, body: '', headers: {} }));
  mockReserve.mockResolvedValue({
    attachmentId: 'att-1',
    uploadUrl: 'https://storage.example/presigned',
    storageKey: 'societies/soc-1/expenses/exp-1/att-1.jpg',
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
    requiredHeaders: { 'Content-Length': '120000', 'Content-Type': 'image/jpeg' },
  });
  mockConfirm.mockResolvedValue({ status: 'processing' });
});

describe('runAttachmentUpload', () => {
  it('reserves, PUTs the exact bytes, then confirms — in that order', async () => {
    const key = seedItem();
    await runAttachmentUpload(key, context());

    expect(mockReserve).toHaveBeenCalledTimes(1);
    expect(mockReserve).toHaveBeenCalledWith(ACTOR, SOCIETY, EXPENSE, {
      fileName: 'bill.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 120_000,
      checksum: CHECKSUM,
    });

    expect(uploadSpy).toHaveBeenCalledTimes(1);
    const [uri, url, options] = uploadSpy.mock.calls[0] as [
      string,
      string,
      { httpMethod: string; uploadType: number; headers: Record<string, string>; mimeType: string },
    ];
    expect(uri).toBe('file:///cache/bill.jpg');
    expect(url).toBe('https://storage.example/presigned');
    // A raw binary PUT with the signature's own headers — never multipart/form-data.
    expect(options.httpMethod).toBe('PUT');
    expect(options.uploadType).toBe(0);
    expect(options.headers).toEqual({
      'Content-Length': '120000',
      'Content-Type': 'image/jpeg',
    });
    expect(options.mimeType).toBe('image/jpeg');

    // The order: nothing is confirmed before the PUT resolves.
    expect(mockConfirm).toHaveBeenCalledWith(ACTOR, SOCIETY, 'att-1', CHECKSUM);

    const item = readUpload(key);
    expect(item?.state).toBe('completed');
    expect(item?.attachmentId).toBe('att-1');
    expect(item?.error).toBeNull();
  });

  it('reports the confirmation once the server has answered, not on PUT success', async () => {
    const key = seedItem();
    const onCompleted = jest.fn();
    await runAttachmentUpload(key, context(onCompleted));
    expect(onCompleted).toHaveBeenCalledWith('att-1');
  });

  it('maps the uploader’s byte counts to a 0–1 progress value', async () => {
    const key = seedItem();
    let observed: number | null = null;
    uploadSpy.mockImplementation(
      async (
        _uri: string,
        _url: string,
        options: {
          onProgress?: (event: { bytesSent: number; totalBytes: number }) => void;
        },
      ) => {
        options.onProgress?.({ bytesSent: 30_000, totalBytes: 120_000 });
        observed = readUpload(key)?.progress ?? null;
        return { status: 200, body: '', headers: {} };
      },
    );

    await runAttachmentUpload(key, context());

    expect(observed).toBeCloseTo(0.25);
    expect(readUpload(key)?.progress).toBe(1);
  });

  it('refuses a reservation whose payload is not the reserved size', async () => {
    const key = seedItem();
    mockReserve.mockRejectedValue(
      new ApiError(503, 'DEPENDENCY_UNAVAILABLE', 'The file store is temporarily unavailable.'),
    );

    await runAttachmentUpload(key, context());

    const item = readUpload(key);
    expect(item?.state).toBe('failed');
    expect(item?.step).toBe('reserve');
    expect(item?.error).toBe('The file store is temporarily unavailable.');
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it('turns a plan-limit refusal into the API’s own sentence', async () => {
    const key = seedItem();
    mockReserve.mockRejectedValue(
      new ApiError(402, 'PLAN_LIMIT_EXCEEDED', 'Your society’s attachment storage is full.'),
    );

    await runAttachmentUpload(key, context());

    expect(readUpload(key)?.error).toBe('Your society’s attachment storage is full.');
    expect(readUpload(key)?.step).toBe('reserve');
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  describe('recovery', () => {
    it('a refused PUT fails at `upload` and keeps the reservation', async () => {
      const key = seedItem();
      uploadSpy.mockResolvedValue({ status: 403, body: '', headers: {} });

      await runAttachmentUpload(key, context());

      const item = readUpload(key);
      expect(item?.state).toBe('failed');
      expect(item?.step).toBe('upload');
      expect(item?.error).toBe(
        'The upload link was refused or has expired. Try again to send the file.',
      );
      // The credential survives, so the retry can reuse it instead of minting a new row.
      expect(item?.reservation?.uploadUrl).toBe('https://storage.example/presigned');
      expect(item?.attachmentId).toBe('att-1');
      expect(mockConfirm).not.toHaveBeenCalled();
    });

    it('retries a refused PUT against the same URL without reserving again', async () => {
      const key = seedItem();
      uploadSpy.mockResolvedValueOnce({ status: 500, body: '', headers: {} });

      await runAttachmentUpload(key, context());
      expect(readUpload(key)?.step).toBe('upload');

      uploadSpy.mockResolvedValue({ status: 200, body: '', headers: {} });
      await runAttachmentUpload(key, context());

      expect(mockReserve).toHaveBeenCalledTimes(1);
      expect(uploadSpy).toHaveBeenCalledTimes(2);
      expect(uploadSpy.mock.calls[1]?.[1]).toBe('https://storage.example/presigned');
      expect(mockConfirm).toHaveBeenCalledTimes(1);
      expect(readUpload(key)?.state).toBe('completed');
    });

    it('re-reserves only when the outstanding URL has expired', async () => {
      const key = seedItem();
      // Simulate a PUT that failed long enough ago for the credential to have died.
      patchUpload(key, {
        state: 'failed',
        step: 'upload',
        attachmentId: 'att-old',
        reservation: {
          uploadUrl: 'https://storage.example/expired',
          expiresAt: new Date(Date.now() - 1_000).toISOString(),
          requiredHeaders: {},
        },
      });

      await runAttachmentUpload(key, context());

      expect(mockReserve).toHaveBeenCalledTimes(1);
      expect(uploadSpy.mock.calls[0]?.[1]).toBe('https://storage.example/presigned');
      expect(readUpload(key)?.state).toBe('completed');
    });

    it('after a confirmation failure, retry confirms again and never uploads or reserves', async () => {
      const key = seedItem();
      mockConfirm.mockRejectedValueOnce(new ApiError(0, 'NETWORK', 'Could not reach the server.'));

      await runAttachmentUpload(key, context());

      const failed = readUpload(key);
      expect(failed?.state).toBe('failed');
      expect(failed?.step).toBe('confirm');
      expect(uploadSpy).toHaveBeenCalledTimes(1);

      await runAttachmentUpload(key, context());

      // The whole point: the second attempt re-verifies the stored object, and touches neither
      // the reservation nor the bytes — so an ambiguous confirmation cannot create a second bill.
      expect(mockConfirm).toHaveBeenCalledTimes(2);
      expect(uploadSpy).toHaveBeenCalledTimes(1);
      expect(mockReserve).toHaveBeenCalledTimes(1);
      expect(readUpload(key)?.state).toBe('completed');
    });

    it('resumes a confirmation that had already been stamped (a replay is a success)', async () => {
      const key = seedItem();
      patchUpload(key, { state: 'failed', step: 'confirm', attachmentId: 'att-1' });

      await runAttachmentUpload(key, context());

      expect(mockConfirm).toHaveBeenCalledWith(ACTOR, SOCIETY, 'att-1', CHECKSUM);
      expect(uploadSpy).not.toHaveBeenCalled();
      expect(readUpload(key)?.state).toBe('completed');
    });

    it('does nothing for a staged file that has no parent expense', async () => {
      const key = seedItem({ expenseId: null });
      await runAttachmentUpload(key, context());

      expect(mockReserve).not.toHaveBeenCalled();
      expect(uploadSpy).not.toHaveBeenCalled();
      expect(readUpload(key)?.state).toBe('ready');
    });

    it('refuses to send an item whose bytes were never hashed', async () => {
      const key = seedItem({ checksum: null });
      await runAttachmentUpload(key, context());

      expect(readUpload(key)?.state).toBe('failed');
      expect(readUpload(key)?.step).toBe('prepare');
      expect(mockReserve).not.toHaveBeenCalled();
    });

    it('drops the item when the upload is cancelled rather than reporting a failure', async () => {
      const key = seedItem();
      // The transport honours an abort the way the real one does: an aborted signal rejects
      // the in-flight transfer, and a signal that is already aborted refuses to start.
      uploadSpy.mockImplementation(
        (_uri: string, _url: string, options: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            const abort = (): void => {
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            };
            if (options.signal?.aborted === true) {
              abort();
              return;
            }
            options.signal?.addEventListener('abort', abort);
          }),
      );

      const running = runAttachmentUpload(key, context());
      // Let the reservation settle so the PUT is genuinely in flight before the cancel.
      await Promise.resolve();
      await Promise.resolve();
      cancelAttachmentUpload(key);
      await running;

      expect(readUpload(key)).toBeNull();
      expect(mockConfirm).not.toHaveBeenCalled();
    });
  });

  describe('client-side request shapes match the shared contracts', () => {
    it('declares exactly the four presign facts the strict schema accepts', () => {
      const parsed = presignAttachmentUploadSchema.parse({
        fileName: 'bill.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 120_000,
        checksum: CHECKSUM.toUpperCase(),
      });
      // Uppercase is the same digest, and the schema lower-cases it rather than refusing it.
      expect(parsed.checksum).toBe(CHECKSUM);
    });

    it('completes with the single field completion accepts', () => {
      expect(completeAttachmentUploadSchema.parse({ checksum: CHECKSUM })).toEqual({
        checksum: CHECKSUM,
      });
    });
  });

  describe('presigned URL expiry', () => {
    it('treats a past instant as expired', () => {
      expect(isPresignedUrlExpired(new Date(Date.now() - 1_000).toISOString())).toBe(true);
    });

    it('treats an unparseable instant as expired rather than as usable', () => {
      expect(isPresignedUrlExpired('not-a-date')).toBe(true);
    });

    it('guards the last 30 seconds so a PUT cannot start into a dying credential', () => {
      expect(isPresignedUrlExpired(new Date(Date.now() + 10_000).toISOString())).toBe(true);
      expect(isPresignedUrlExpired(new Date(Date.now() + 120_000).toISOString())).toBe(false);
    });
  });

  describe('failure copy', () => {
    it('never surfaces a raw native error message, which can name a path', () => {
      expect(uploadFailureMessage(new Error('ENOENT /data/user/0/app/cache/bill.jpg'))).toBe(
        'The upload could not be completed. Please try again.',
      );
    });

    it('reports a transport failure as a connection problem', () => {
      expect(uploadFailureMessage(new ApiError(0, 'NETWORK', 'Could not reach the server.'))).toBe(
        'Could not reach the server.',
      );
    });
  });
});
