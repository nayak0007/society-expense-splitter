import { EXPENSE_ATTACHMENT_MAX_BYTES } from '@ses/domain';

import {
  ATTACHMENT_MAX_BYTES,
  AttachmentValidationError,
  assertAcceptableUpload,
  documentDisplayName,
  extensionOf,
  formatAttachmentBytes,
  isAcceptedMimeType,
  jpegDisplayName,
  resolvePickerMimeType,
  scanStatusLabel,
} from '../schemas/attachment.schemas';

/**
 * The attachment rules (T076 §5).
 *
 * These are the numbers T071 already enforces. The tests pin the **contract's** boundary
 * rather than a re-derived one: exactly 10 MB is allowed and one byte more is not, because
 * that is what `validateAttachmentSize` — the API's own function — decides.
 */
describe('attachment rules', () => {
  it('takes the domain module’s own ceiling rather than a literal', () => {
    expect(ATTACHMENT_MAX_BYTES).toBe(EXPENSE_ATTACHMENT_MAX_BYTES);
    expect(ATTACHMENT_MAX_BYTES).toBe(10 * 1024 * 1024);
  });

  describe('resolvePickerMimeType', () => {
    it('accepts the four declared types', () => {
      expect(resolvePickerMimeType('image/jpeg', 'a.jpg')).toBe('image/jpeg');
      expect(resolvePickerMimeType('image/png', 'a.png')).toBe('image/png');
      expect(resolvePickerMimeType('image/heic', 'a.heic')).toBe('image/heic');
      expect(resolvePickerMimeType('application/pdf', 'a.pdf')).toBe('application/pdf');
    });

    it('normalises case and treats heif as heic', () => {
      expect(resolvePickerMimeType('IMAGE/JPEG', 'a.jpg')).toBe('image/jpeg');
      expect(resolvePickerMimeType('image/heif', 'a.heif')).toBe('image/heic');
    });

    it('falls back to the suffix only when the picker reported no type', () => {
      expect(resolvePickerMimeType(undefined, 'scan.PDF')).toBe('application/pdf');
      expect(resolvePickerMimeType(null, 'photo.HEIC')).toBe('image/heic');
      expect(resolvePickerMimeType('', 'photo.jpeg')).toBe('image/jpeg');
    });

    it('refuses anything outside the four types', () => {
      expect(resolvePickerMimeType('video/mp4', 'clip.mp4')).toBeNull();
      expect(resolvePickerMimeType(undefined, 'notes.txt')).toBeNull();
      expect(resolvePickerMimeType('image/svg+xml', 'logo.svg')).toBeNull();
    });
  });

  describe('assertAcceptableUpload', () => {
    it('allows exactly the ceiling', () => {
      expect(() =>
        assertAcceptableUpload({
          fileName: 'bill.jpg',
          mimeType: 'image/jpeg',
          sizeBytes: ATTACHMENT_MAX_BYTES,
        }),
      ).not.toThrow();
    });

    it('refuses one byte over the ceiling, naming the size', () => {
      expect.assertions(2);
      try {
        assertAcceptableUpload({
          fileName: 'bill.jpg',
          mimeType: 'image/jpeg',
          sizeBytes: ATTACHMENT_MAX_BYTES + 1,
        });
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(AttachmentValidationError);
        expect((error as AttachmentValidationError).reason).toBe('too_large');
      }
    });

    it('refuses an unsupported type before looking at the size', () => {
      expect.assertions(2);
      try {
        assertAcceptableUpload({
          fileName: 'bill.txt',
          mimeType: 'text/plain',
          sizeBytes: 10,
        });
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(AttachmentValidationError);
        expect((error as AttachmentValidationError).reason).toBe('unsupported_type');
      }
    });

    it('treats an empty file as empty rather than oversized', () => {
      expect.assertions(1);
      try {
        assertAcceptableUpload({ fileName: 'bill.jpg', mimeType: 'image/jpeg', sizeBytes: 0 });
      } catch (error: unknown) {
        expect((error as AttachmentValidationError).reason).toBe('empty_file');
      }
    });
  });

  describe('naming', () => {
    it('renames a compressed image to .jpg, because the bytes are JPEG', () => {
      expect(jpegDisplayName('IMG_4021.HEIC')).toBe('IMG_4021.jpg');
      expect(jpegDisplayName('photo.png')).toBe('photo.jpg');
      expect(jpegDisplayName('C:\\Users\\me\\bill.jpeg')).toBe('bill.jpg');
    });

    it('gives an extensionless name an extension rather than dropping it', () => {
      expect(jpegDisplayName('bill')).toBe('bill.jpg');
    });

    it('keeps a document’s own sanitised name', () => {
      expect(documentDisplayName('C:\\tmp\\invoice.pdf')).toBe('invoice.pdf');
    });

    it('finds a suffix regardless of case or path separators', () => {
      expect(extensionOf('a/b/c.JPEG')).toBe('jpeg');
      expect(extensionOf('no-dot')).toBe('');
    });
  });

  it('recognises the accepted types by their mime', () => {
    expect(isAcceptedMimeType('image/heic')).toBe(true);
    expect(isAcceptedMimeType('image/gif')).toBe(false);
  });

  it('never presents an unscanned file as verified', () => {
    expect(scanStatusLabel('pending')).toBe('Not yet security-scanned');
    expect(scanStatusLabel('clean')).toBe('Scan: clean');
    expect(scanStatusLabel('infected')).toBe('Scan: infected — do not open');
    expect(scanStatusLabel('failed')).toBe('Scan: could not be completed');
    expect(scanStatusLabel('something-new')).toBe('Not yet security-scanned');
  });

  it('formats bytes for the size line', () => {
    expect(formatAttachmentBytes(2048)).toBe('2.0 KB');
    expect(formatAttachmentBytes(512)).toBe('512 B');
    expect(formatAttachmentBytes(1024 * 1024 * 2)).toBe('2.0 MB');
  });
});
