import {
  CHECKSUM_PATTERN,
  EXPENSE_ATTACHMENT_MAX_BYTES,
  EXPENSE_ATTACHMENT_MIME_TYPES,
  MIME_EXTENSIONS,
  assertSafeStorageKey,
  buildAttachmentStorageKey,
  extensionForMimeType,
  isAttachmentEntityType,
  isAttachmentScanStatus,
  isExpenseAttachmentMime,
  isSafeStorageKey,
  sanitiseOriginalFilename,
  validateAttachmentMimeType,
  validateAttachmentSize,
  validateChecksum,
} from "../attachment";
// `quotaVerdict` is a port-level rule — it is what the reservation's own comparison
// calls — so it is imported from the module that declares it.
import { quotaVerdict } from "../ports";

/**
 * The T071 value rules, with no bucket and no database — Roadmap T071.
 *
 * These are the rules the presign use case *and* the storage adapter both depend on,
 * so they are tested where they live rather than through a route: a key layout that
 * only works because a controller happened to pass the right ids is a key layout
 * nobody has checked.
 */

const ATTACHMENT_ID = "11111111-1111-4111-8111-111111111111";
const EXPENSE_ID = "22222222-2222-4222-8222-222222222222";
const SOCIETY_ID = "33333333-3333-4333-8333-333333333333";

describe("attachment size and type rules", () => {
  it("refuses a zero, negative, fractional or non-numeric size", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, "1024", null, undefined]) {
      expect(validateAttachmentSize(bad).ok).toBe(false);
    }
  });

  it("allows exactly the 10 MB cap and refuses one byte more", () => {
    // The boundary is the whole point: `>` versus `>=` here decides whether the
    // largest legal bill can be attached at all.
    expect(validateAttachmentSize(EXPENSE_ATTACHMENT_MAX_BYTES).ok).toBe(true);
    const over = validateAttachmentSize(EXPENSE_ATTACHMENT_MAX_BYTES + 1);
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.error.code).toBe("validation");
      expect(over.error.details?.["field"]).toBe("sizeBytes");
    }
  });

  it("accepts exactly the four bill types and nothing else", () => {
    for (const mime of EXPENSE_ATTACHMENT_MIME_TYPES) {
      expect(validateAttachmentMimeType(mime).ok).toBe(true);
    }
    // SVG and every executable/archive format are absent on purpose — an image type
    // that can carry script is not a bill.
    for (const mime of [
      "image/svg+xml",
      "application/zip",
      "application/octet-stream",
      "image/gif",
      "text/html",
    ]) {
      expect(validateAttachmentMimeType(mime).ok).toBe(false);
      expect(isExpenseAttachmentMime(mime)).toBe(false);
    }
  });

  it("derives the extension from the type, never from a filename", () => {
    expect(extensionForMimeType("image/jpeg")).toBe("jpg");
    expect(extensionForMimeType("image/png")).toBe("png");
    expect(extensionForMimeType("image/heic")).toBe("heic");
    expect(extensionForMimeType("application/pdf")).toBe("pdf");
    // The mismatch case: a PDF's *type* decides, so an extension derived from a
    // `.jpg` name is not a thing this module can produce.
    expect(extensionForMimeType("..%2f..%2fetc%2fpasswd.jpg")).toBeNull();
    expect(Object.keys(MIME_EXTENSIONS)).toHaveLength(
      EXPENSE_ATTACHMENT_MIME_TYPES.length,
    );
  });

  it("refuses an entity type that is not expense in T071", () => {
    expect(isAttachmentEntityType("expense")).toBe(true);
    expect(isAttachmentEntityType("complaint")).toBe(false);
    expect(isAttachmentEntityType("Expense")).toBe(false);
  });

  it("knows SAD §10.7's four scan statuses and no others", () => {
    for (const status of ["pending", "clean", "infected", "failed"]) {
      expect(isAttachmentScanStatus(status)).toBe(true);
    }
    expect(isAttachmentScanStatus("scanned")).toBe(false);
    expect(isAttachmentScanStatus(null)).toBe(false);
  });
});

describe("checksum rules", () => {
  const sha = "a".repeat(64);

  it("accepts a 64-character hex digest and normalises case", () => {
    const lower = validateChecksum(sha);
    expect(lower.ok).toBe(true);
    if (lower.ok) expect(lower.value).toBe(sha);

    // Uppercase is the same digest, so refusing it would refuse a caller who is
    // right about the content.
    const upper = validateChecksum(sha.toUpperCase());
    expect(upper.ok).toBe(true);
    if (upper.ok) expect(upper.value).toBe(sha);
  });

  it("refuses anything that is not a SHA-256 — a caller that has not hashed", () => {
    for (const bad of [
      "a".repeat(63),
      "a".repeat(65),
      "z".repeat(64),
      "",
      "not-a-digest",
      undefined,
    ]) {
      expect(validateChecksum(bad).ok).toBe(false);
    }
    expect(CHECKSUM_PATTERN.test(sha)).toBe(true);
  });
});

describe("original filename", () => {
  it("reduces a path to its last segment rather than refusing it", () => {
    // A Windows browser reports a full path; storing `bill.jpg` is the obvious
    // meaning of what the user did.
    expect(sanitiseOriginalFilename("C:\\Users\\me\\bill.jpg")).toBe(
      "bill.jpg",
    );
    expect(sanitiseOriginalFilename("/etc/passwd")).toBe("passwd");
    expect(sanitiseOriginalFilename("../../escape.pdf")).toBe("escape.pdf");
  });

  it("falls back for a name that carries nothing usable", () => {
    expect(sanitiseOriginalFilename("")).toBe("attachment");
    expect(sanitiseOriginalFilename("   ")).toBe("attachment");
    expect(sanitiseOriginalFilename("...")).toBe("attachment");
    expect(sanitiseOriginalFilename(undefined)).toBe("attachment");
  });

  it("caps the length at the column's own 200 characters", () => {
    const long = `${"x".repeat(400)}.jpg`;
    expect(sanitiseOriginalFilename(long)).toHaveLength(200);
  });
});

describe("storage key layout (SAD §10.3)", () => {
  const key = buildAttachmentStorageKey({
    societyId: SOCIETY_ID,
    entityType: "expense",
    entityId: EXPENSE_ID,
    attachmentId: ATTACHMENT_ID,
    mimeType: "image/jpeg",
  });

  it("builds exactly SAD §10.3's path", () => {
    expect(key.ok).toBe(true);
    if (key.ok) {
      expect(key.value).toBe(
        `societies/${SOCIETY_ID}/expenses/${EXPENSE_ID}/${ATTACHMENT_ID}.jpg`,
      );
    }
  });

  it("takes its suffix from the accepted type, not from any input string", () => {
    const pdf = buildAttachmentStorageKey({
      societyId: SOCIETY_ID,
      entityType: "expense",
      entityId: EXPENSE_ID,
      attachmentId: ATTACHMENT_ID,
      mimeType: "application/pdf",
    });
    expect(pdf.ok).toBe(true);
    if (pdf.ok) expect(pdf.value.endsWith(`/${ATTACHMENT_ID}.pdf`)).toBe(true);

    // An unaccepted type produces no key at all, so a traversal in a filename can
    // never reach the object store through this function.
    const evil = buildAttachmentStorageKey({
      societyId: SOCIETY_ID,
      entityType: "expense",
      entityId: EXPENSE_ID,
      attachmentId: ATTACHMENT_ID,
      mimeType: "image/jpeg;../../etc/passwd",
    });
    expect(evil.ok).toBe(false);
  });

  it("refuses a key that is not this server's own layout", () => {
    // The three properties the insert policy re-asserts, checked here so a use case
    // can produce a typed refusal rather than a SQLSTATE.
    for (const bad of [
      "other-bucket/key.jpg",
      "/societies/x/expenses/y/z.jpg",
      "societies/../../secret.jpg",
      "societies//x.jpg",
      "societies/\\x.jpg",
      "",
      "x".repeat(513),
      null,
    ]) {
      expect(isSafeStorageKey(bad)).toBe(false);
      expect(assertSafeStorageKey(bad).ok).toBe(false);
    }
    if (key.ok) {
      expect(isSafeStorageKey(key.value)).toBe(true);
      expect(assertSafeStorageKey(key.value).ok).toBe(true);
    }
  });
});

describe("quota verdict (ADR-0012 D2)", () => {
  const CAP = 500 * 1024 * 1024;

  it("allows the exact boundary and refuses one byte past it", () => {
    // The case a `<` would get wrong, and the case the brief calls out by name.
    expect(quotaVerdict(CAP - 1000, 1000, CAP).ok).toBe(true);
    const over = quotaVerdict(CAP - 1000, 1001, CAP);
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.error.code).toBe("quota_exceeded");
      expect(over.error.details).toMatchObject({
        usedBytes: CAP - 1000,
        requestedBytes: 1001,
        capBytes: CAP,
      });
    }
  });

  it("allows a first upload into an empty society exactly at the cap", () => {
    expect(quotaVerdict(0, CAP, CAP).ok).toBe(true);
    expect(quotaVerdict(0, CAP + 1, CAP).ok).toBe(false);
  });

  it("refuses a request into an already-full society at one byte", () => {
    const full = quotaVerdict(CAP, 1, CAP);
    expect(full.ok).toBe(false);
  });
});
