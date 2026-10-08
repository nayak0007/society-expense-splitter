import { ATTACHMENT_SCAN_STATUSES } from "../attachment";
import {
  ATTACHMENT_SERVING_REFUSALS,
  ATTACHMENT_SERVING_REFUSAL_STATUS,
  attachmentServingRefusal,
} from "../serving-gate";

/**
 * The serving gate — SAD §10.7 and ADR-0012 D3.
 *
 * The whole point of this predicate is that both configurations are written down and
 * the *inert* one is the production configuration today. A test that only asserted
 * "pending is refused" would describe a gate this product does not ship, and one that
 * only asserted "pending serves" would leave the armed behaviour unproven.
 */
describe("attachmentServingRefusal", () => {
  it("is inert while no scanner is configured — every status serves (ADR-0012 D3)", () => {
    for (const status of ATTACHMENT_SCAN_STATUSES) {
      expect(attachmentServingRefusal(status, false)).toBeNull();
    }
  });

  it("serves a clean file when a scanner is configured", () => {
    expect(attachmentServingRefusal("clean", true)).toBeNull();
  });

  it("refuses pending and failed as SCAN_PENDING when armed", () => {
    expect(attachmentServingRefusal("pending", true)).toBe("scan_pending");
    expect(attachmentServingRefusal("failed", true)).toBe("scan_pending");
  });

  it("quarantines an infected file when armed", () => {
    expect(attachmentServingRefusal("infected", true)).toBe("file_quarantined");
  });

  it("maps the two refusals to SAD §10.7's two statuses", () => {
    expect(ATTACHMENT_SERVING_REFUSAL_STATUS.scan_pending).toBe(409);
    expect(ATTACHMENT_SERVING_REFUSAL_STATUS.file_quarantined).toBe(403);
    expect([...ATTACHMENT_SERVING_REFUSALS]).toEqual([
      "scan_pending",
      "file_quarantined",
    ]);
  });
});
