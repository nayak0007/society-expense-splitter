/**
 * The audit module's application layer — Roadmap T050 Stage E1.
 *
 * `listAuditLogs` — one page of a society's append-only audit trail, narrowed to the
 * categories the caller's membership may read (PRD §2.1's "View audit log — ✅ Admin,
 * 🟡 Treasurer financial only"), with a reader-audit entry handed to the read's own
 * transaction (PRD §11.7's "the log itself records who viewed it").
 *
 * One use case, because the read side is one route. The write side has no use case
 * here by design: a mutation records through `UnitOfWork`'s audit seam inside the
 * transaction that makes the change, so there is nothing for this layer to
 * orchestrate — and a "record an audit row" use case would be exactly the
 * post-commit, best-effort shape ADR-0014 D7 rules out.
 *
 * What is deliberately **not** here: retention/archival, refusal-class auditing, the
 * attachment-cascade accounting and the audit UI. Those are Stage E2's, and none of
 * them is expressible as a read of the log.
 */
export * from "./use-cases";
