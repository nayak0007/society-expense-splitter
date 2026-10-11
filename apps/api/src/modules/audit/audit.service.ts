import { Injectable } from "@nestjs/common";
import type { AuditDescriptor, AuditEntry } from "@ses/domain";

import { buildAuditEntry } from "../../common/audit/audit-context";
import { RequestContext } from "../../common/context/request-context";

/**
 * The audit module's injectable surface — T050, ADR-0014.
 *
 * Thin on purpose, and the thinness is the design. The two jobs it has are
 * genuinely dependent on the request context and are therefore not worth a class
 * of their own anywhere else:
 *
 *  - `entry()` turns a call site's descriptor into a persisted row, taking the
 *    actor and the trusted request facts from the server-side context (the rule
 *    itself lives in `common/audit/audit-context.ts`, beside the context it reads);
 *  - `declare()` records what a route promised with `@Audited()`, so a later layer
 *    can ask.
 *
 * It deliberately does **not** write anything. A service that wrote audits
 * independently of the caller's transaction would reintroduce exactly the
 * two-transaction gap T050 exists to close — so the write lives on `UnitOfWork`'s
 * seam, where it shares the business change's transaction.
 */
@Injectable()
export class AuditService {
  /** Builds the row the writer will persist, from trusted context. */
  entry(descriptor: AuditDescriptor): AuditEntry {
    return buildAuditEntry(descriptor);
  }

  /** Records the actions this route declared via `@Audited()`. */
  declare(actions: readonly string[]): void {
    RequestContext.declareAudit(actions);
  }

  /**
   * True when the request declared auditing. Stage B's enforcement reads this to
   * decide whether a missing record is a failure; in Stage A it exists so the
   * mechanism is live and testable rather than dead code waiting for a caller.
   */
  isAuditedRoute(): boolean {
    return RequestContext.audited().length > 0;
  }
}
