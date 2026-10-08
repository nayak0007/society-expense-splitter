import type { AttachmentScanStatus } from "./attachment";

/**
 * The scan-status serving gate — SAD §10.7, ADR-0012 D3.
 *
 * ## What SAD §10.7 says, and what ADR-0012 D3 decided instead
 *
 * SAD §10.7: "Files with `scan_status != 'clean'` are **never** served —
 * `presignDownload` refuses and the API returns `409 SCAN_PENDING` or `403
 * FILE_QUARANTINED`."
 *
 * ADR-0012 D3 (Accepted, binding on T073): no scanner exists and **no Roadmap task
 * owns one**, so if that gate were armed unconditionally every bill of every society
 * would be permanently unservable (nothing writes `clean`). The decision is therefore
 * that `clean` is written *only when a scanner is configured*, and **with no scanner
 * configured the gate is inert** — reads succeed — while `409 SCAN_PENDING` /
 * `403 FILE_QUARANTINED` stay *shaped but unreachable*. Arming it later is
 * configuration plus the scanner job, not a re-design.
 *
 * This function is that decision, stated once as a pure predicate so both arms are
 * testable and the inert configuration is a value rather than an absence of code:
 *
 * ```text
 * scannerConfigured = false  ->  no refusal, whatever the status   (today; D3)
 * scannerConfigured = true   ->  clean serves; infected quarantines; pending/failed
 *                                refuse as SCAN_PENDING
 * ```
 *
 * The point of shipping it inert rather than absent is that the *armed* behaviour is
 * written and tested, so turning on a scanner cannot silently change the serving
 * contract — and the *documented* deviation from §10.7 is recorded in the type rather
 * than discovered in a diff.
 */
export const ATTACHMENT_SERVING_REFUSALS = [
  "scan_pending",
  "file_quarantined",
] as const;
export type AttachmentServingRefusal =
  (typeof ATTACHMENT_SERVING_REFUSALS)[number];

/**
 * Whether a stored attachment may be served, as a stable refusal code or `null`.
 *
 * `scannerConfigured` is passed in rather than read from ambient state, so the same
 * predicate answers both the live (inert) configuration and the armed one, and a test
 * can prove the armed arm without a scanner existing.
 */
export function attachmentServingRefusal(
  scanStatus: AttachmentScanStatus,
  scannerConfigured: boolean,
): AttachmentServingRefusal | null {
  // ADR-0012 D3: with no scanner, the gate is inert. This is the *accepted*
  // deviation from SAD §10.7's literal "never served", not an oversight.
  if (!scannerConfigured) return null;

  if (scanStatus === "clean") return null;
  if (scanStatus === "infected") return "file_quarantined";
  // `pending` and `failed` are both "not verified clean yet": one is awaiting a scan,
  // the other a scan that could not complete. Neither is a quarantine, so both read as
  // the retryable `SCAN_PENDING` rather than the terminal `FILE_QUARANTINED`.
  return "scan_pending";
}

/** The HTTP status each refusal maps to, per SAD §10.7. */
export const ATTACHMENT_SERVING_REFUSAL_STATUS: Readonly<
  Record<AttachmentServingRefusal, number>
> = {
  scan_pending: 409,
  file_quarantined: 403,
};
