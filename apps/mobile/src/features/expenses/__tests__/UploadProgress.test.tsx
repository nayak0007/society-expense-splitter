import { fireEvent, render, screen } from '@testing-library/react-native';

import { UploadProgress } from '../components/UploadProgress';
import type { AttachmentUpload } from '../services/attachment-upload.store';

/**
 * `UploadProgress` (T076 §7/§12).
 *
 * The component's job is to make the *step* visible, because the retry differs per step: a
 * user whose confirmation failed is offered a retry that will not re-send the file, and the
 * label has to say so. These tests pin the actions each state offers, which is the visible
 * half of the recovery model.
 */
function makeUpload(overrides: Partial<AttachmentUpload> = {}): AttachmentUpload {
  return {
    key: 'upload-1',
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
    progress: 0,
    attachmentId: null,
    error: null,
    reservation: null,
    ...overrides,
  };
}

async function renderProgress(
  upload: AttachmentUpload,
  handlers: {
    onUpload?: jest.Mock;
    onRetry?: jest.Mock;
    onCancel?: jest.Mock;
    onDiscard?: jest.Mock;
  } = {},
): Promise<void> {
  await render(
    <UploadProgress
      upload={upload}
      onUpload={handlers.onUpload}
      onRetry={handlers.onRetry}
      onCancel={handlers.onCancel}
      onDiscard={handlers.onDiscard}
    />,
  );
}

describe('UploadProgress', () => {
  it('says a ready file has not been sent yet', async () => {
    await renderProgress(makeUpload());
    expect(screen.getByText('Ready to upload')).toBeTruthy();
    expect(screen.getByText('117.2 KB · nothing is sent until you tap Upload')).toBeTruthy();
  });

  it('offers Upload and Remove while ready, and reports the tap', async () => {
    const onUpload = jest.fn();
    const onDiscard = jest.fn();
    await renderProgress(makeUpload(), { onUpload, onDiscard });

    await fireEvent.press(screen.getByText('Upload'));
    await fireEvent.press(screen.getByText('Remove'));

    expect(onUpload).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Retry')).toBeNull();
    expect(screen.queryByText('Cancel')).toBeNull();
  });

  it('offers Cancel while a transport is live, and only then', async () => {
    const onCancel = jest.fn();
    await renderProgress(makeUpload({ state: 'uploading', progress: 0.4 }), { onCancel });

    expect(screen.getByText('Uploading… 40%')).toBeTruthy();
    await fireEvent.press(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Upload')).toBeNull();
    expect(screen.queryByText('Retry')).toBeNull();
  });

  it('reports progress on the accessibility tree as a percentage', async () => {
    await renderProgress(makeUpload({ state: 'uploading', progress: 0.4 }));
    const bar = screen.getByRole('progressbar');
    expect(bar.props.accessibilityValue).toMatchObject({ now: 40, min: 0, max: 100 });
  });

  it('explains each in-flight step rather than showing one anonymous spinner', async () => {
    await renderProgress(makeUpload({ state: 'reserving' }));
    expect(screen.getByText('Reserving an upload slot…')).toBeTruthy();

    await renderProgress(makeUpload({ state: 'confirming' }));
    expect(screen.getByText('Verifying the upload…')).toBeTruthy();
  });

  it('offers Retry and the failure reason when a step failed', async () => {
    const onRetry = jest.fn();
    const onDiscard = jest.fn();
    await renderProgress(
      makeUpload({ state: 'failed', step: 'confirm', error: 'Verifying the upload failed.' }),
      { onRetry, onDiscard },
    );

    expect(screen.getByText('Upload failed')).toBeTruthy();
    expect(screen.getByText('Verifying the upload failed.')).toBeTruthy();

    await fireEvent.press(screen.getByText('Retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
    // Remove stays available — a user must be able to abandon a file they cannot send.
    expect(screen.getByText('Remove')).toBeTruthy();
  });

  it('never labels a completed upload as scanned, and offers no further action', async () => {
    await renderProgress(makeUpload({ state: 'completed', progress: 1 }), {
      onUpload: jest.fn(),
      onRetry: jest.fn(),
      onDiscard: jest.fn(),
    });

    expect(screen.getByText('Uploaded — not yet security-scanned')).toBeTruthy();
    expect(screen.queryByText('Upload')).toBeNull();
    expect(screen.queryByText('Retry')).toBeNull();
    expect(screen.queryByText('Remove')).toBeNull();
  });

  it('hides an action whose handler was not provided', async () => {
    await renderProgress(makeUpload());
    expect(screen.queryByText('Upload')).toBeNull();
    expect(screen.queryByText('Remove')).toBeNull();
  });
});
