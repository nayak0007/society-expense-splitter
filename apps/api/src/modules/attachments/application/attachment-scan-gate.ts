import { attachmentError, attachmentServingRefusal } from "@ses/domain";
import type { AttachmentRecord } from "@ses/domain";

/**
 * The serving gate for attachment reads — SAD §10.7, ADR-0012 D3.
 *
 * ## The one switch, and why it is `false`
 *
 * ADR-0012 D3 (Accepted, binding on T073) settled this: **no scanner exists and no
 * Roadmap task owns one**, so if SAD §10.7's gate were armed unconditionally nothing
 * would ever write `clean` and every bill of every society would be permanently
 * unservable. The decision is that `clean` is written only when a scanner is
 * configured, and **with no scanner configured the gate is inert** — reads succeed.
 *
 * `ATTACHMENT_SCANNER_CONFIGURED` is that switch, stated as a value rather than as an
 * absence of code so the *armed* behaviour is written and unit-tested even while it is
 * off. Arming it later is a scanner job plus flipping this constant (or sourcing it
 * from configuration) — not a re-design of the read path. It is deliberately not an
 * environment variable yet: there is nothing to point it at, and a variable that can
 * only ever be `false` is a trap rather than a seam.
 */
export const ATTACHMENT_SCANNER_CONFIGURED = false;

/** The two refusals, in the attachment module's vocabulary (SAD §10.7's own). */
const REFUSAL_MESSAGE = {
  scan_pending:
    "This file has not finished its security scan and cannot be downloaded yet.",
  file_quarantined:
    "This file was quarantined by the security scan and cannot be downloaded.",
} as const;

/**
 * Refuse an unscanned or quarantined file **when a scanner is configured**; inert
 * otherwise (ADR-0012 D3). Callers get the shaped refusal as an `AttachmentError`
 * mapped to `409 SCAN_PENDING` / `403 FILE_QUARANTINED` by `attachment-error.mapper`.
 *
 * A pure decision over the row's `scanStatus`, so the armed arm is testable with no
 * scanner and the inert arm is the production configuration today.
 */
export function assertAttachmentServable(record: AttachmentRecord): void {
  const refusal = attachmentServingRefusal(
    record.scanStatus,
    ATTACHMENT_SCANNER_CONFIGURED,
  );
  if (refusal === null) return;
  throw attachmentError(refusal, REFUSAL_MESSAGE[refusal], {
    scanStatus: record.scanStatus,
  });
}
