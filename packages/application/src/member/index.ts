/**
 * The Members module's use cases — Roadmap T045.
 *
 * Five operations over the directory (list with search and filters, get, add, update,
 * remove) plus the two status transitions the lifecycle needs (suspend, reactivate), each a
 * pure function of `(deps, actor, …)` returning a `Result`. Both callers use them: the API
 * through `MembersOperations`, the mobile app through `features/members/services/`.
 *
 * Two operations the surrounding prompt named are deliberately **not** here, and the
 * Roadmap records why: *approval and rejection* are the join queue's transitions
 * (`pending → active`, `pending → rejected`, T049 — the queue, its list and its copy are
 * that task's), and *leaving* is the society module's `leaveSociety`, which already exists
 * with the sole-admin check and the "promote another Admin first" message. Re-implementing
 * either here would be a second copy of a rule that already has an owner.
 */
export * from "./use-cases";
