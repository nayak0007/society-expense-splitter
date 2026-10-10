import * as ImageManipulatorModule from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system';

import { sha256Hex } from '@/lib/storage/files';

import {
  exceedsContractCap,
  prepareImage,
  preparePickedDocument,
  preparePickedImage,
} from '../services/attachment.service';
import {
  ATTACHMENT_MAX_BYTES,
  AttachmentValidationError,
  IMAGE_MAX_EDGE_PX,
  IMAGE_TARGET_BYTES,
} from '../schemas/attachment.schemas';

/**
 * Attachment preparation (T076 §5/§9).
 *
 * The pipeline's own claims are what these tests pin: the longest edge is capped at 1600 and a
 * smaller image is never upscaled, the second pass runs only above the 400 KB target, a PDF's
 * bytes are untouched, and the digest is computed over the file that will actually be uploaded
 * (the *output* of compression, not the original).
 *
 * The digest is checked against a real SHA-256 of the same bytes, so "the checksum is of the
 * uploaded bytes" is an assertion about the algorithm rather than about a stub.
 */

const fs = FileSystem as unknown as {
  __setFile: (uri: string, size: number, bytes?: Uint8Array) => void;
  __hasFile: (uri: string) => boolean;
  __clearFiles: () => void;
};
const manipulator = ImageManipulatorModule as unknown as {
  __setSourceDimensions: (width: number, height: number) => void;
  __setRenderOutputs: (
    outputs: readonly { uri: string; width?: number; height?: number }[],
  ) => void;
  ImageManipulator: { manipulate: jest.Mock };
};

beforeEach(() => {
  fs.__clearFiles();
  manipulator.__setSourceDimensions(4000, 3000);
  manipulator.__setRenderOutputs([]);
});

describe('prepareImage', () => {
  it('caps the longest edge at 1600 px and re-encodes to JPEG', async () => {
    fs.__setFile('file:///cache/out.jpg', 300_000);
    manipulator.__setSourceDimensions(4000, 3000);
    // No dimensions queued, so the save reports the context's — which is the resize's.
    manipulator.__setRenderOutputs([{ uri: 'file:///cache/out.jpg' }]);

    const prepared = await prepareImage('file:///picked.jpg', 'IMG_4021.HEIC');

    expect(prepared.isImage).toBe(true);
    expect(prepared.mimeType).toBe('image/jpeg');
    // 4000 × 3000 → the long edge lands on 1600 and the ratio is preserved by the encoder.
    expect(prepared.width).toBe(IMAGE_MAX_EDGE_PX);
    expect(prepared.height).toBe(1200);
    // The name follows the bytes: a HEIC original became a JPEG.
    expect(prepared.fileName).toBe('IMG_4021.jpg');
    expect(prepared.sizeBytes).toBe(300_000);
  });

  it('uses the height when the image is portrait', async () => {
    fs.__setFile('file:///cache/tall.jpg', 200_000);
    manipulator.__setSourceDimensions(3000, 4000);
    manipulator.__setRenderOutputs([{ uri: 'file:///cache/tall.jpg' }]);

    const prepared = await prepareImage('file:///picked.jpg', 'bill.jpg');

    expect(prepared.height).toBe(IMAGE_MAX_EDGE_PX);
    expect(prepared.width).toBe(1200);
  });

  it('never upscales an image that is already small enough', async () => {
    fs.__setFile('file:///cache/small.jpg', 50_000);
    manipulator.__setSourceDimensions(800, 600);
    manipulator.__setRenderOutputs([{ uri: 'file:///cache/small.jpg' }]);

    const prepared = await prepareImage('file:///picked.jpg', 'small.jpg');

    expect(prepared.width).toBe(800);
    expect(prepared.height).toBe(600);
  });

  it('adds a second pass only when the first overshoots the target', async () => {
    fs.__setFile('file:///cache/first.jpg', IMAGE_TARGET_BYTES + 100_000);
    fs.__setFile('file:///cache/second.jpg', 180_000);
    manipulator.__setSourceDimensions(4000, 3000);
    manipulator.__setRenderOutputs([
      { uri: 'file:///cache/first.jpg' },
      { uri: 'file:///cache/second.jpg' },
    ]);

    const prepared = await prepareImage('file:///picked.jpg', 'bill.jpg');

    expect(prepared.uri).toBe('file:///cache/second.jpg');
    expect(prepared.sizeBytes).toBe(180_000);
    // The intermediate render is not left in the cache.
    expect(fs.__hasFile('file:///cache/first.jpg')).toBe(false);
    expect(fs.__hasFile('file:///cache/second.jpg')).toBe(true);
  });

  it('keeps a result between the target and the cap — 400 KB is a target, not a gate', async () => {
    fs.__setFile('file:///cache/dense.jpg', IMAGE_TARGET_BYTES + 30_000);
    fs.__setFile('file:///cache/dense2.jpg', IMAGE_TARGET_BYTES + 20_000);
    manipulator.__setRenderOutputs([
      { uri: 'file:///cache/dense.jpg' },
      { uri: 'file:///cache/dense2.jpg' },
    ]);

    const prepared = await prepareImage('file:///picked.jpg', 'bill.jpg');

    // Two passes ran (the first did overshoot), and the result is still uploaded.
    expect(prepared.uri).toBe('file:///cache/dense2.jpg');
    expect(prepared.sizeBytes).toBeGreaterThan(IMAGE_TARGET_BYTES);
    expect(exceedsContractCap(prepared)).toBe(false);
  });

  it('refuses a result that breaches the contract ceiling', async () => {
    fs.__setFile('file:///cache/huge.jpg', ATTACHMENT_MAX_BYTES + 1);
    manipulator.__setRenderOutputs([{ uri: 'file:///cache/huge.jpg' }]);

    await expect(prepareImage('file:///picked.jpg', 'bill.jpg')).rejects.toBeInstanceOf(
      AttachmentValidationError,
    );
  });

  it('refuses an image whose dimensions cannot be read', async () => {
    manipulator.__setSourceDimensions(0, 0);

    await expect(prepareImage('file:///picked.jpg', 'bill.jpg')).rejects.toMatchObject({
      reason: 'unreadable_file',
    });
  });

  it('computes the digest over the compressed output, not the original', async () => {
    const outputBytes = new Uint8Array([9, 8, 7, 6, 5]);
    fs.__setFile('file:///cache/out.jpg', outputBytes.length, outputBytes);
    manipulator.__setRenderOutputs([{ uri: 'file:///cache/out.jpg' }]);

    const prepared = await prepareImage('file:///picked.jpg', 'bill.jpg');

    expect(prepared.checksum).toBe(await sha256Hex(outputBytes));
    expect(prepared.checksum).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('preparePickedImage', () => {
  it('refuses a picked file that is not an image the product accepts', async () => {
    await expect(
      preparePickedImage({ uri: 'file:///clip.mp4', fileName: 'clip.mp4', mimeType: 'video/mp4' }),
    ).rejects.toMatchObject({ reason: 'unsupported_type' });
  });

  it('refuses a picked image whose bytes cannot be read', async () => {
    await expect(
      preparePickedImage({
        uri: 'file:///missing.jpg',
        fileName: 'missing.jpg',
        mimeType: 'image/jpeg',
      }),
    ).rejects.toMatchObject({ reason: 'unreadable_file' });
  });

  it('accepts an image above the upload cap before compression, because compression shrinks it', async () => {
    // 12 MB on disk — bigger than the 10 MB upload cap, and exactly what a phone camera
    // produces. Only the compressed result is measured against the contract.
    fs.__setFile('file:///picked.jpg', 12 * 1024 * 1024);
    fs.__setFile('file:///cache/out.jpg', 250_000);
    manipulator.__setRenderOutputs([{ uri: 'file:///cache/out.jpg' }]);

    const prepared = await preparePickedImage({
      uri: 'file:///picked.jpg',
      fileName: 'IMG_1.HEIC',
      mimeType: 'image/heic',
    });

    expect(prepared.sizeBytes).toBe(250_000);
    expect(prepared.mimeType).toBe('image/jpeg');
  });
});

describe('preparePickedDocument', () => {
  it('passes a PDF through untouched and hashes its own bytes', async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3]);
    fs.__setFile('file:///cache/invoice.pdf', pdfBytes.length, pdfBytes);

    const prepared = await preparePickedDocument({
      uri: 'file:///cache/invoice.pdf',
      name: 'September invoice.pdf',
      mimeType: 'application/pdf',
    });

    expect(prepared.isImage).toBe(false);
    expect(prepared.mimeType).toBe('application/pdf');
    expect(prepared.uri).toBe('file:///cache/invoice.pdf');
    expect(prepared.sizeBytes).toBe(pdfBytes.length);
    expect(prepared.checksum).toBe(await sha256Hex(pdfBytes));
    // No image pipeline ran: a PDF is never converted to an image to simplify uploading.
    expect(manipulator.ImageManipulator.manipulate).not.toHaveBeenCalled();
  });

  it('refuses a document that is not a PDF', async () => {
    fs.__setFile('file:///cache/notes.docx', 1000);

    await expect(
      preparePickedDocument({
        uri: 'file:///cache/notes.docx',
        name: 'notes.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    ).rejects.toMatchObject({ reason: 'unsupported_type' });
  });

  it('refuses an oversized PDF, since its bytes are the uploaded bytes', async () => {
    fs.__setFile('file:///cache/big.pdf', ATTACHMENT_MAX_BYTES + 1);

    await expect(
      preparePickedDocument({
        uri: 'file:///cache/big.pdf',
        name: 'big.pdf',
        mimeType: 'application/pdf',
      }),
    ).rejects.toMatchObject({ reason: 'too_large' });
  });
});
