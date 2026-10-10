/**
 * The capture → prepare → upload hook — Roadmap T076 (audit §4/§6/§7).
 *
 * ## `Ready` is the user's decision point, not a formality
 *
 * Picking a file does **not** upload it. `prepareFrom…` runs the picker, compresses and
 * validates, and leaves the result in the store as a `ready` item with a visible preview
 * and an explicit **Upload** action. That is why the audit's state machine has a `ready`
 * state between `preparing` and `reserving`: reserving creates a server row and uploads
 * bytes, and neither should happen as a side effect of a selection the user might have
 * made by mistake.
 *
 * ## Permissions are requested one at a time, and only when needed
 *
 * The camera is the only capability that needs a runtime permission here: the photo
 * library and the document picker are **system pickers**, which grant access to the chosen
 * item without granting the app the library. Asking for `MEDIA_LIBRARY` would be asking
 * for more than the flow uses, so it is deliberately not requested.
 *
 * ## Scope isolation
 *
 * Every item is keyed by `{society}:{user}`. When either changes, the previous scope's
 * items are abandoned and their transports aborted, so a bill captured under one tenant
 * can never be confirmed into another.
 */

import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { selectAuthUser, useAuthStore } from '@/stores/auth.store';
import { selectActiveSocietyId, useSocietyStore } from '@/stores/society.store';

import {
  createUpload,
  abandonOtherScopes,
  bindStagedToExpense,
  patchUpload,
  readUpload,
  removeUpload,
  subscribeUploads,
  uploadsSnapshot,
} from '../services/attachment-upload.store';
import type { AttachmentUpload } from '../services/attachment-upload.store';
import {
  attachmentScopeKey,
  cancelAttachmentUpload,
  runAttachmentUpload,
  uploadFailureMessage,
} from '../services/attachment-upload.service';
import { preparePickedDocument, preparePickedImage } from '../services/attachment.service';
import type { PreparedAttachment } from '../services/attachment.service';
import { invalidateExpenseAttachments } from '../services/expense-query-invalidation';
import { isAttachmentValidationError } from '../schemas/attachment.schemas';

/** The scope this device's session is acting in, or `null` when there is none. */
export function useAttachmentScope(): string | null {
  const userId = useAuthStore(selectAuthUser)?.id ?? null;
  const societyId = useSocietyStore(selectActiveSocietyId);
  return attachmentScopeKey(societyId, userId);
}

/**
 * The uploads of one expense, in insertion order.
 *
 * Reads through `useSyncExternalStore`, so every screen looking at the same expense sees
 * the same items and a progress update re-renders all of them — the property that lets the
 * scanner start an upload and the detail screen finish watching it.
 */
export function useAttachmentUploads(expenseId: string | null): {
  readonly uploads: readonly AttachmentUpload[];
  readonly ready: readonly AttachmentUpload[];
  readonly inFlight: readonly AttachmentUpload[];
} {
  const scope = useAttachmentScope();
  const all = useSyncExternalStore(subscribeUploads, uploadsSnapshot, uploadsSnapshot);

  return useMemo(() => {
    const uploads = all.filter((item) => item.scope === scope && item.expenseId === expenseId);
    return {
      uploads,
      ready: uploads.filter((item) => item.state === 'ready'),
      inFlight: uploads.filter((item) => isInFlight(item.state)),
    };
  }, [all, scope, expenseId]);
}

/** The staged (unsaved-expense) items of this session. */
export function useStagedAttachments(): {
  readonly staged: readonly AttachmentUpload[];
} {
  const scope = useAttachmentScope();
  const all = useSyncExternalStore(subscribeUploads, uploadsSnapshot, uploadsSnapshot);
  return useMemo(
    () => ({ staged: all.filter((item) => item.scope === scope && item.expenseId === null) }),
    [all, scope],
  );
}

/** True for the states where a transport is live and a cancel is meaningful. */
export function isInFlight(state: AttachmentUpload['state']): boolean {
  return state === 'reserving' || state === 'uploading' || state === 'confirming';
}

export interface AttachmentUploaderController {
  /** True while a picker is open, a file is being compressed, or a hash is being read. */
  readonly isPreparing: boolean;
  /** The last thing the user should read, or `null`. */
  readonly error: string | null;
  readonly notice: string | null;
  takePhoto(expenseId: string | null): Promise<void>;
  chooseImage(expenseId: string | null): Promise<void>;
  chooseDocument(expenseId: string | null): Promise<void>;
  /** Start the upload of one `ready` item (the explicit user action). */
  upload(key: string): void;
  retryUpload(key: string): void;
  cancelUpload(key: string): void;
  discardUpload(key: string): void;
  /**
   * Adopt this session's staged files onto a freshly saved expense and upload them.
   *
   * The unsaved-expense path (audit §8): a file captured before the expense existed has
   * no parent to attach to, so it waits as a staged item until the server has minted an
   * id. Nothing is reserved before then, which is what keeps a cancelled new expense from
   * leaving orphan reservations behind.
   */
  uploadAllForExpense(expenseId: string): void;
  clearFeedback(): void;
}

/**
 * The single capture/upload controller every attachment surface uses.
 *
 * Failures during *preparation* are surfaced here as `error` rather than as a store item:
 * a file that cannot be read or compressed has no useful retry state — the user's next
 * move is to pick a different file — whereas a failure during reserve/upload/confirm is a
 * store item in `failed`, whose retry is step-specific.
 */
export function useAttachmentUploader(): AttachmentUploaderController {
  const scope = useAttachmentScope();
  const [isPreparing, setIsPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // A society or account switch abandons the previous scope's items and stops their
  // transports: an upload that outlived its tenant must never be confirmed.
  useEffect(() => {
    if (scope === null) return;
    abandonOtherScopes(scope);
  }, [scope]);

  const run = useCallback(
    (key: string) => {
      const societyId = useSocietyStore.getState().activeSocietyId;
      const actorId = useAuthStore.getState().user?.id ?? null;
      if (societyId === null || actorId === null || scope === null) {
        setError('Switch to a society to attach a bill.');
        return;
      }
      void runAttachmentUpload(key, {
        actorId,
        societyId,
        onCompleted: () => {
          const expenseId = readUpload(key)?.expenseId ?? null;
          if (expenseId !== null) invalidateExpenseAttachments(expenseId);
          setNotice('Bill attached. It has not been security-scanned yet.');
          setError(null);
        },
      });
    },
    [scope],
  );

  const stage = useCallback(
    async (
      expenseId: string | null,
      produce: () => Promise<PreparedAttachment>,
      preparingMessage: string,
    ): Promise<void> => {
      if (scope === null) {
        setError('Switch to a society to attach a bill.');
        return;
      }
      setError(null);
      setNotice(null);
      setIsPreparing(true);
      try {
        const prepared = await produce();
        createUpload({
          scope,
          expenseId,
          fileName: prepared.fileName,
          mimeType: prepared.mimeType,
          sizeBytes: prepared.sizeBytes,
          checksum: prepared.checksum,
          uri: prepared.uri,
          isImage: prepared.isImage,
          width: prepared.width,
          height: prepared.height,
          state: 'ready',
          step: 'reserve',
        });
        setNotice(
          expenseId === null
            ? 'File ready. It will be attached when the expense is saved.'
            : preparingMessage,
        );
      } catch (caught: unknown) {
        setError(preparationFailureMessage(caught));
      } finally {
        setIsPreparing(false);
      }
    },
    [scope],
  );

  const takePhoto = useCallback(
    async (expenseId: string | null): Promise<void> => {
      setError(null);
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        setError(
          'Camera access is not allowed. Allow it in Settings, or choose a photo from your library instead.',
        );
        return;
      }

      let result: ImagePicker.ImagePickerResult;
      try {
        result = await ImagePicker.launchCameraAsync({
          mediaTypes: ['images'],
          // The crop step T076's acceptance names, provided by the system UI.
          allowsEditing: true,
          // No picker-side compression or EXIF payload: this app compresses
          // deterministically in one place, so the pipeline stays reproducible.
          quality: 1,
          exif: false,
        });
      } catch {
        setError('The camera is not available on this device. Choose a photo instead.');
        return;
      }

      if (result.canceled) return;
      const asset = result.assets[0];
      if (asset === undefined) return;
      await stage(
        expenseId,
        () => preparePickedImage(asset),
        'Photo ready. Upload it when you are.',
      );
    },
    [stage],
  );

  const chooseImage = useCallback(
    async (expenseId: string | null): Promise<void> => {
      setError(null);
      // No media-library permission is requested, and `allowsEditing` stays off: the
      // crop step is the camera's (T076's acceptance names it there), and turning it on
      // for the library would route through `UIImagePickerController`, which needs
      // photo-library access — exactly the broad permission a system picker avoids.
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 1,
        exif: false,
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (asset === undefined) return;
      await stage(
        expenseId,
        () => preparePickedImage(asset),
        'Photo ready. Upload it when you are.',
      );
    },
    [stage],
  );

  const chooseDocument = useCallback(
    async (expenseId: string | null): Promise<void> => {
      setError(null);
      const result = await DocumentPicker.getDocumentAsync({
        type: 'application/pdf',
        multiple: false,
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (asset === undefined) return;
      await stage(
        expenseId,
        () =>
          preparePickedDocument({
            uri: asset.uri,
            name: asset.name,
            mimeType: asset.mimeType ?? null,
          }),
        'Document ready. Upload it when you are.',
      );
    },
    [stage],
  );

  const upload = useCallback(
    (key: string) => {
      // The explicit action: mark it as starting so a double tap cannot enqueue it twice.
      const item = readUpload(key);
      if (item === null || item.state !== 'ready') return;
      patchUpload(key, { state: 'reserving', step: 'reserve', error: null });
      run(key);
    },
    [run],
  );

  const retryUpload = useCallback(
    (key: string) => {
      const item = readUpload(key);
      if (item === null || item.state !== 'failed') return;
      patchUpload(key, { error: null });
      run(key);
    },
    [run],
  );

  const cancelUpload = useCallback((key: string) => {
    cancelAttachmentUpload(key);
  }, []);

  const discardUpload = useCallback((key: string) => {
    removeUpload(key);
  }, []);

  const uploadAllForExpense = useCallback(
    (expenseId: string) => {
      // Adopt staged files first, so an item captured for an unsaved expense is bound to
      // the id the server just minted rather than to `null`.
      bindStagedToExpense(scope ?? '', expenseId);
      const all = uploadsSnapshot().filter(
        (item) =>
          item.expenseId === expenseId && (item.state === 'ready' || item.state === 'failed'),
      );
      for (const item of all) {
        patchUpload(item.key, { state: 'reserving', step: 'reserve', error: null });
        run(item.key);
      }
    },
    [run, scope],
  );

  const clearFeedback = useCallback(() => {
    setError(null);
    setNotice(null);
  }, []);

  return {
    isPreparing,
    error,
    notice,
    takePhoto,
    chooseImage,
    chooseDocument,
    upload,
    retryUpload,
    cancelUpload,
    discardUpload,
    uploadAllForExpense,
    clearFeedback,
  };
}

/**
 * A preparation failure → the sentence a screen renders.
 *
 * A locally-refused file (wrong type, over the cap, unreadable) has its own message; an
 * unexpected throw gets the API-side generic line, because the raw `Error.message` of a
 * native module can name a path the user should never see.
 */
export function preparationFailureMessage(error: unknown): string {
  if (isAttachmentValidationError(error)) return error.message;
  return uploadFailureMessage(error);
}
