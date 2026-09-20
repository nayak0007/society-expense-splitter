# ADR-0001 · The backend is a modular monolith, not microservices

**Status:** Accepted
**Date:** 2026-09-20
**Task:** T015 (`.dependency-cruiser.js` enforcing the boundaries this ADR describes)
**Supersedes:** —

## Context

Society Expense Splitter's server side has to do several things that look, at first
glance, like separate services: identity, society tenancy, expense capture,
split calculation, dues generation, payment reconciliation against Razorpay
webhooks, notifications, and AI/OCR extraction of receipts.

The reflex for a system with that many concerns is to split it up — one deployable
per bounded context, a queue between them, an API gateway in front. That reflex is
usually right for a large organisation where separate teams need independent
release cadence and independent scaling.

It is wrong here, for two reasons specific to this product.

**1. The most important write in the system is transactional across concerns.**
Publishing a maintenance cycle must atomically write expenses, their splits, the
dues they generate and the balances they move. In a distributed split, that is a
saga: each step needs a compensating action, partial failure is a state the
product must be able to _show_ a treasurer, and "the cycle half-published" becomes
a support category. In one process with one database transaction, it is a
`BEGIN`/`COMMIT`. SAD §1.2 states this directly: a modular monolith gives
"microservice-grade separation of concerns with monolith-grade transactional
integrity".

**2. The financial core must be byte-identical on client and server.**
SAD §1.1 makes the split engine shared code: the preview a treasurer sees must be
produced by the same implementation that generates the bill. That is one package
imported by both a NestJS process and an Expo app. Splitting the backend into
services does nothing to that property, but the service boundaries make it
tempting to give each service its own copy of the arithmetic — which is exactly
how a one-paisa drift appears between preview and invoice.

## Decision

**One deployable NestJS process with hard module boundaries, and no cross-module
imports except through a module's published interface.**

Concretely, this is enforced rather than intended:

- `apps/api/src/modules/<feature>/` owns its controllers, use cases, repository
  implementation and mappers. Another module may import only from the module's
  public entry point, never from its internals.
- The layers inside every module point inward only: presentation → application →
  domain. `packages/domain` depends on nothing; `packages/application` depends on
  the domain and no framework.
- `.dependency-cruiser.js` fails the build on a violation (`pnpm lint:arch`), and
  the rules are proven to fire by deliberately planted violations rather than
  assumed to work.
- The worker is the _same_ codebase with a different entry point
  (`apps/api/src/worker.ts`), not a second service. SAD §2.2: queue processing
  never runs in the HTTP process, because a long report must not starve request
  handling — but that is a process split, not a repository split.

## Consequences

**What this buys:**

- Cycle publication and payment allocation are single transactions. The
  highest-severity bugs in this product (partial money writes) are structurally
  unavailable, not merely handled.
- One deployment, one schema, one migration history, one set of contracts, one
  test suite. At MVP scale an extra process per concern is operational cost with
  no corresponding benefit.
- Refactoring a boundary is a directory move. Splitting later is a
  _mechanical_ change because the seams already exist and are enforced.

**What it costs, and what to watch:**

- **Boundaries decay without the tool.** In a monolith, "just import it" always
  compiles. This is why T015 exists and why the rules are verified to fire — a
  boundary rule that silently matches nothing is indistinguishable from no rule.
- **One process scales as one unit.** A CPU-heavy OCR or AI call competes with
  request handling unless it is moved to the worker. Any new expensive synchronous
  path is a review question, not an automatic one.
- **A module's public interface is a real commitment.** Widening it to reach a
  private helper is the first step to the tangle this ADR exists to prevent.

## How a module becomes a service later

SAD §20 records this migration, and the property that makes it cheap is that the
module graph already has no cycles and no reaching into internals:

1. The module's repository interface becomes an HTTP or gRPC client behind the
   same port, so the use cases above it are unchanged.
2. Its database tables move with it. This is the expensive part and it is a data
   migration, not a code rewrite.
3. Only then does it become a separate deployment, keeping the same public
   interface its callers already use.

## Alternatives considered

**Microservices from day one.** Rejected: distributed transactions across the
cycle-publish write path, and a shared split engine that cannot be shared across
language/runtime boundaries without duplicating the arithmetic. It trades the
hardest correctness problem in the product for organisational independence that a
small team does not need yet.

**A serverless function per endpoint.** Rejected: no long-lived connection pool
(the workload is I/O-bound against Postgres, SAD §2.2), cold-start latency on the
synchronous expense-entry path, and no natural home for the transactional
boundary around cycle publication.

**Two services — money and everything else.** Rejected for now: the split is along
the wrong axis. Expenses, dues and payments are updated by the same transactions;
splitting them apart creates the saga problem in exactly the place it hurts most,
while identity and notifications are the concerns that could have been separated
cheaply. If a split is ever justified, it should follow (§20), not lead.
