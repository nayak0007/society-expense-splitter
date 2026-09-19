# Software Architecture Document — Society Expense Splitter

**Version:** 1.0
**Companion to:** Society Expense Splitter PRD v1.0
**Audience:** AI coding agents and engineers implementing the system
**Status:** Normative. Where an implementation detail is specified here, build it exactly this way.

> **Relationship to the PRD.** The PRD defines *what* to build and *why*. This document defines *how*. Where the PRD describes a behaviour, this document describes the module, layer, file, contract and failure mode that delivers it. Where the two disagree on a technical choice, **this document wins** — see §2.0 for the deliberate deviations.

---

## Contents

1. [High-Level Architecture](#1-high-level-architecture)
2. [Technology Stack](#2-technology-stack)
3. [Clean Architecture](#3-clean-architecture)
4. [Folder Structure](#4-folder-structure)
5. [Navigation Architecture](#5-navigation-architecture)
6. [State Management](#6-state-management)
7. [API Design Standards](#7-api-design-standards)
8. [Database Design](#8-database-design)
9. [Authentication & Authorization](#9-authentication--authorization)
10. [File Upload Architecture](#10-file-upload-architecture)
11. [AI Architecture](#11-ai-architecture)
12. [Offline Architecture](#12-offline-architecture)
13. [Security](#13-security)
14. [Performance](#14-performance)
15. [Testing Strategy](#15-testing-strategy)
16. [CI/CD](#16-cicd)
17. [Monitoring](#17-monitoring)
18. [Coding Standards](#18-coding-standards)
19. [Deployment](#19-deployment)
20. [Future Scalability](#20-future-scalability)
21. [Implementation Summary](#21-implementation-summary)

---

# 1. High-Level Architecture

## 1.1 Architectural Style

The system is a **modular monolith backend + offline-first mobile client**, with a deliberately small set of managed services around it.

Three decisions define everything downstream:

1. **The server is the single authority on money.** The mobile client computes split previews locally for responsiveness, but no balance, due or payment is considered real until the server has written it inside a transaction. The client's local database is a *replica with an outbox*, never a source of truth.
2. **The backend is a modular monolith, not microservices.** One deployable NestJS process with hard module boundaries and no cross-module imports except through published interfaces. This gives microservice-grade separation of concerns with monolith-grade transactional integrity — critical, because publishing a maintenance cycle must atomically write expenses, splits, dues and balances. §20 describes how modules become services later without a rewrite.
3. **Supabase is infrastructure, not architecture.** It provides Postgres, Auth, Storage and Realtime. Every Supabase-specific call sits behind an adapter interface, so the platform is replaceable in weeks rather than being load-bearing.

## 1.2 System Context

```mermaid
graph TB
    subgraph Clients
        MOB["Expo Mobile App<br/>iOS · Android"]
        WEB["Expo Web<br/>read-only reports · Phase 3"]
    end

    subgraph Edge
        CDN["CDN<br/>Cloudflare"]
        WAF["WAF · Rate Limiter"]
    end

    subgraph Core["Core Platform"]
        API["NestJS API<br/>modular monolith"]
        WORKER["BullMQ Workers<br/>cycles · reports · notifications"]
        SCHED["Scheduler<br/>cron triggers"]
    end

    subgraph Data
        PG[("PostgreSQL 15<br/>primary")]
        REPLICA[("Read Replica<br/>reports")]
        REDIS[("Redis<br/>cache · queues · rate limits")]
        OBJ[("Object Storage<br/>Supabase → R2")]
    end

    subgraph Managed["Managed Services"]
        SBAUTH["Supabase Auth"]
        RZP["Razorpay"]
        EXPO["Expo Push → FCM/APNs"]
        MSG["MSG91 SMS"]
        RESEND["Resend Email"]
        WA["WhatsApp Cloud API"]
        LLM["LLM Gateway<br/>Claude · Gemini"]
    end

    subgraph Observability
        SENTRY["Sentry"]
        POSTHOG["PostHog"]
        OTEL["OpenTelemetry → Grafana"]
    end

    MOB --> CDN --> WAF --> API
    WEB --> CDN
    MOB -.direct, RLS-protected.-> SBAUTH
    MOB -.signed URLs.-> OBJ

    API --> PG
    API --> REDIS
    API --> OBJ
    API --> SBAUTH
    API --> RZP
    RZP -.webhooks.-> API

    API --> WORKER
    SCHED --> WORKER
    WORKER --> PG
    WORKER --> EXPO
    WORKER --> MSG
    WORKER --> RESEND
    WORKER --> WA
    WORKER --> LLM
    WORKER --> REDIS

    API --> REPLICA
    PG -.streaming.-> REPLICA

    API --> SENTRY
    API --> OTEL
    MOB --> SENTRY
    MOB --> POSTHOG
```

## 1.3 Component Responsibilities

### Mobile App (Expo / React Native)
Owns presentation, local persistence, offline queueing and optimistic UX. Contains **no authoritative business rules** except the shared split engine, which is byte-identical to the server's copy because both import the same package. Responsibilities:
- Render from SQLite first, network second (stale-while-revalidate).
- Queue every mutation in a local outbox with an idempotency key.
- Enforce permissions in the UI for *affordance*, never for *security*.
- Handle deep links, push routing, biometric lock and session lifecycle.

### Backend API (NestJS)
The only component allowed to mutate financial state. Responsibilities:
- Authorisation enforcement (guard layer) on every request.
- Transactional use cases: publish expense, publish cycle, allocate payment, issue receipt.
- Integration orchestration: Razorpay, notifications, LLM calls.
- Emitting domain events that workers consume.
- Serving an OpenAPI spec from which the mobile client's types are generated.

### Database (PostgreSQL)
Not just storage — an active participant in correctness:
- Constraints and triggers enforce money invariants that application code could forget.
- Row Level Security enforces tenant isolation independently of the API.
- Partitioning and materialised aggregates keep reporting fast.
- A read replica isolates heavy report queries from the transactional path.

### Authentication (Supabase Auth)
Issues and validates identity. The API **verifies** Supabase JWTs but maintains its own `members` table for authorisation, because a user's identity is global while their permissions are per-society. Identity and authorisation are deliberately separate systems.

### Storage (Supabase Storage → Cloudflare R2)
Private buckets only. Uploads go direct from device to storage via a presigned URL issued by the API; the API records metadata and never proxies bytes. Downloads use short-lived signed URLs.

### Notifications
A single `NotificationOrchestrator` in the API decides *what* to send and to *whom*; channel adapters (Expo Push, MSG91, Resend, WhatsApp) decide *how*. The `notifications` table is the source of truth; push is one delivery mechanism among several and may fail without data loss.

### AI Services
An `LLMGateway` abstraction sits between the application and any model provider. No module imports a provider SDK directly. All AI output is advisory: it produces `ai_suggestions` rows that a human must accept before any ledger effect.

### Payment Gateway (Razorpay)
Integrated in **Route/partner mode** so funds settle directly to each society's bank account — the platform never holds money, which keeps it outside payment-aggregator regulation and PCI scope. Webhooks are authoritative; client callbacks are UX accelerators only.

## 1.4 Request Path — Publish an Expense

```mermaid
sequenceDiagram
    participant U as User (Treasurer)
    participant M as Mobile App
    participant Q as Outbox (SQLite)
    participant A as NestJS API
    participant D as PostgreSQL
    participant W as Worker
    participant P as Push/Email

    U->>M: Tap "Publish"
    M->>M: computeSplit() local preview
    M->>Q: enqueue op (opId = idempotency key)
    M-->>U: optimistic UI + "Pending sync"
    M->>A: POST /v1/expenses (Idempotency-Key)
    A->>A: AuthGuard → SocietyGuard → PermissionGuard
    A->>A: zod validate → map to domain entity
    A->>D: BEGIN
    A->>A: splitEngine.compute() (authoritative)
    A->>D: INSERT expense, expense_splits, dues
    A->>D: UPDATE member_balances
    A->>D: INSERT audit_log
    A->>D: COMMIT
    A->>W: emit expense.published
    A-->>M: 201 { id, splitSummary, duesCreated }
    M->>Q: mark op applied, rewrite temp id
    M->>M: reconcile SQLite, clear chip
    W->>D: load recipients
    W->>P: dispatch notifications (batched)
```

**Note the ordering:** the transaction commits before any notification is emitted. Workers consume events; they never participate in the financial transaction. A failed push must never roll back a bill.

## 1.5 Request Path — Online Payment

```mermaid
sequenceDiagram
    participant R as Resident
    participant M as Mobile App
    participant A as API
    participant RZ as Razorpay
    participant D as PostgreSQL

    R->>M: Select dues → Pay
    M->>A: POST /payments/intent (Idempotency-Key)
    A->>D: INSERT payment (status=initiated)
    A->>RZ: Create Order (notes: societyId, memberId, dueIds)
    A-->>M: orderId + keyId + prefill
    M->>RZ: Open checkout SDK (UPI first)
    RZ-->>M: success(paymentId, signature)
    M->>A: POST /payments/verify
    RZ->>A: POST /webhooks/razorpay (payment.captured)
    Note over A: Both paths converge on the same<br/>idempotent handler. Webhook is authoritative.
    A->>A: verify HMAC-SHA256 over raw body
    A->>D: BEGIN — lock payment row
    A->>D: allocate oldest-due-first → payment_allocations
    A->>D: UPDATE dues, member_balances
    A->>D: INSERT receipt (nextval sequence)
    A->>D: COMMIT
    A-->>M: 200 { status: verified, allocations, receipt }
```

## 1.6 Deployment Topology

```mermaid
graph LR
    subgraph "ap-south-1 (Mumbai)"
        subgraph "Application Tier"
            API1["API instance 1"]
            API2["API instance 2"]
            WK1["Worker 1"]
            WK2["Worker 2"]
        end
        subgraph "Data Tier"
            PGB["PgBouncer"]
            PGP[("Postgres primary")]
            PGR[("Read replica")]
            RDS[("Redis")]
        end
        LB["Load Balancer"]
    end
    OBJ[("Object Storage + CDN")]

    LB --> API1 & API2
    API1 & API2 & WK1 & WK2 --> PGB --> PGP
    API1 & API2 --> PGR
    API1 & API2 & WK1 & WK2 --> RDS
    API1 & API2 --> OBJ
```

**Sizing for MVP:** 2 × API (1 vCPU / 1 GB), 1 × worker, Postgres 2 vCPU / 4 GB, Redis 256 MB. This comfortably serves ~500 societies. Scale workers before API instances — the load is bursty around cycle publish dates, not evenly distributed.

## 1.7 Cross-Cutting Architectural Rules

| Rule | Enforcement |
|---|---|
| No module imports another module's internals | ESLint `no-restricted-imports` + dependency-cruiser in CI |
| No financial write outside a transaction | All money use cases extend `TransactionalUseCase`; lint rule bans direct repository writes in controllers |
| Every mutation emits an audit entry | `@Audited()` decorator; integration test asserts audit rows per endpoint |
| Tenant scope derived from token + membership, never from the body | `SocietyGuard` sets `RequestContext`; repositories require a `societyId` argument typed as `SocietyId` |
| No floats in money paths | Branded `Paise` type + lint rule banning `parseFloat`/`Number` on `*Paise` fields |
| Provider SDKs only inside `infrastructure/` | dependency-cruiser rule |

---

# 2. Technology Stack

## 2.0 Deliberate Deviations from the PRD

Two, both stated up front so an implementing agent does not get conflicting instructions:

| PRD said | This SAD says | Reason |
|---|---|---|
| `react-native-paper` (MD3 components) | **NativeWind v4 + an in-house MD3 token system**, `react-native-paper` removed entirely | NativeWind is now in the mandated stack. Mixing a styled-component library with a utility CSS engine produces two competing theming systems, doubled bundle weight and constant style-precedence bugs. We keep Material Design 3 as the *design language* (tokens, type scale, elevation, shape) and implement it as Tailwind theme tokens. Do **not** install `react-native-paper`. |
| `victory-native` for charts | **`react-native-gifted-charts`** primary, `react-native-svg` for custom viz | Lighter, no Skia dependency, better low-end Android performance. Skia stays available if a specific chart demands it. |

Everything else in the PRD's stack section stands.

## 2.1 Frontend

| Concern | Library | Version policy |
|---|---|---|
| Runtime | **Expo SDK (latest stable)**, React Native | Pin exact; upgrade one SDK behind head on a scheduled cadence |
| Language | **TypeScript** `strict` + `noUncheckedIndexedAccess` | — |
| Routing | **Expo Router v4+** | Typed routes enabled |
| Server state | **TanStack Query v5** | — |
| Client state | **Zustand v5** | With `persist` + MMKV storage adapter |
| Forms | **React Hook Form v7** + `@hookform/resolvers/zod` | — |
| Validation | **Zod v3** | Schemas live in `packages/contracts`, shared with the API |
| KV storage | **react-native-mmkv v3** | Encrypted instance for anything semi-sensitive |
| Styling | **NativeWind v4** | Tailwind config carries MD3 tokens |
| Animation | **Reanimated v3** + `react-native-gesture-handler` | Worklets for list and sheet interactions |
| Lists | **@shopify/flash-list** | Mandatory for any list over 20 rows |
| Local DB | **expo-sqlite** + **Drizzle ORM** + SQLCipher | Typed queries, versioned migrations |
| Secure storage | **expo-secure-store** | Tokens + SQLCipher key only |
| Images | **expo-image** | Disk cache, blurhash placeholders |
| Charts | **react-native-gifted-charts** | Dark-mode palette required |
| i18n | **i18next** + `react-i18next` + `expo-localization` | No literal strings in JSX |
| Payments | **react-native-razorpay** | Requires `expo-dev-client` |
| Push | **expo-notifications** | Expo Push service over FCM/APNs |
| Testing | Jest + RNTL + **Maestro** | — |

### Why NativeWind rather than StyleSheet or styled-components
- **Design tokens become the only styling vocabulary.** MD3 roles (`bg-surface-container`, `text-on-surface-variant`) are Tailwind classes, so a developer cannot accidentally hardcode `#2E7D5B`. An ESLint rule bans raw hex in `.tsx` files.
- **Dark mode is free.** `dark:` variants resolve from the same token set; no parallel StyleSheet objects to keep in sync.
- **Styles compile to `StyleSheet` objects at build time** — no runtime CSS parsing, unlike styled-components' runtime interpolation, which matters on a ₹8,000 Android device.
- **Co-location.** Reading a component tells you exactly how it looks without jumping to a style block 200 lines down.

Guardrail: NativeWind is for *layout and token application*. Any component that needs more than ~8 utility classes gets a named variant via `cva` (class-variance-authority) in `components/ui/`, not an ever-growing `className` string.

## 2.2 Backend — Recommendation: NestJS

**Choose NestJS.** Not Express, not Spring Boot.

### Versus Node/Express
Express gives you an HTTP router and nothing else. Everything this system needs — dependency injection, request-scoped context, declarative guards, interceptors for the response envelope, module boundaries, validation pipes, OpenAPI generation, lifecycle hooks for graceful shutdown — you would build by hand and maintain forever. For a financial application with a permission matrix across six roles and strict layering requirements, that hand-rolled scaffolding *is* the architecture, and every team writes it slightly differently. NestJS ships it, opinionated and documented, so an AI coding agent generating code has a single unambiguous convention to follow rather than inventing one per file.

Concretely, three NestJS features map directly onto requirements in this system:
- **Guards** implement the §9 permission matrix as declarative decorators (`@RequirePermission('expense.publish')`) evaluated before any handler runs. In Express this becomes middleware ordering you must remember on every route — and forgetting once is a security hole.
- **Interceptors** implement the §7 response envelope, request-id propagation and audit logging uniformly, with no per-handler boilerplate.
- **Modules + DI** enforce the clean-architecture boundaries of §3 at compile time. Use cases receive repository *interfaces*; the concrete Postgres implementation is bound in the module. This makes the domain layer testable without a database and makes the Supabase swap a one-line provider change.

### Versus Spring Boot
Spring Boot is genuinely excellent for this class of problem and would be a defensible choice at a 30-engineer company. It loses here for one reason: **language unification**. The split engine must be byte-identical on client and server (§1.1). In TypeScript it is one package imported by both. With Spring Boot it is two implementations in two languages that will drift, and a rounding discrepancy between the preview a treasurer saw and the bill residents received is exactly the trust-destroying bug the PRD calls Sev-1. Add to that: shared Zod schemas, generated client types from OpenAPI, one set of lint rules, and one hiring pool. The JVM's throughput advantage is irrelevant at this scale — the workload is I/O-bound against Postgres, not CPU-bound.

### NestJS configuration decisions
- **Fastify adapter**, not Express — roughly 2× throughput and better JSON serialisation.
- **Drizzle ORM**, not TypeORM or Prisma. Drizzle gives SQL-shaped, fully typed queries with no hidden N+1 magic, generates plain SQL migrations you can review, shares its schema definitions with the mobile app's SQLite layer, and has no query-engine binary to ship. Prisma's relational query API is pleasant but its migration story and connection handling are worse fits for a money system where you want to read exactly what SQL runs.
- **BullMQ** for jobs, running in a separate worker process from the same codebase (`apps/api` with a `--worker` entrypoint). Never run queue processing in the API process — a long report job must not starve request handling.
- **`@nestjs/swagger`** generating the OpenAPI spec, with `openapi-typescript` producing `packages/api-types` in CI.

## 2.3 Database — PostgreSQL

### Schema strategy
**Single database, single schema, tenant-scoped rows with RLS.** Not schema-per-society, not database-per-society.

Rationale: at 6,000 societies, schema-per-tenant means 6,000 × ~35 tables = 210,000 tables, which makes migrations operationally miserable and blows up Postgres catalog performance. Cross-tenant analytics (§12 of the PRD) becomes a union over thousands of schemas. Row-level tenancy with a `society_id` column on every table, a mandatory index prefix, and RLS policies gives isolation that is enforced by the database itself while keeping one migration to run.

The strategy has six rules:

1. **Every tenant-scoped table carries `society_id uuid NOT NULL`** with an FK to `societies`, and every index on that table begins with `society_id`. No exceptions, even where it feels redundant.
2. **RLS is enabled on every tenant table** with policies deriving access from the requesting user's active memberships. The application connects as a role that cannot bypass RLS. A second role used only by migrations can.
3. **Money is `bigint` paise.** `numeric` is correct but slower and invites accidental float coercion in JS drivers; `bigint` with a branded TypeScript type makes the unit part of the type system.
4. **Integrity lives in the database where it is cheap.** `CHECK` constraints for ranges, `UNIQUE` for idempotency keys and receipt numbers, deferred constraint triggers for `SUM(splits) = expense.amount`. Application bugs then fail loudly at commit instead of silently corrupting a ledger.
5. **Append-only where history matters.** `audit_logs`, `complaint_events` and `expense_revisions` have `UPDATE`/`DELETE` revoked from the application role.
6. **Time-series tables partition by month** once volume justifies it (`expenses`, `dues`, `payments`, `audit_logs`, `notifications`) using `pg_partman`. Design the keys for this from day one: partition key is `created_at` and every PK is `(id)` with `society_id` in supporting indexes.

Extensions used: `pgcrypto` (UUIDs, column encryption), `citext` (case-insensitive email), `pg_trgm` (vendor/duplicate fuzzy matching), `btree_gin`, `pg_stat_statements`, and `pgvector` from Phase 3 for AI retrieval.

## 2.4 Authentication — Supabase Auth

**Choose Supabase Auth over Clerk**, for three reasons specific to this product:

1. **Pricing shape.** Clerk charges per monthly active user. This app's users are residents who log in once a month to pay a bill — high MAU, low ARPU. At 80,000 users and ₹12,000 ARPS, per-MAU auth pricing consumes a visible fraction of gross margin for a feature that is table stakes. Supabase Auth has no per-MAU meter.
2. **Indian phone OTP.** Phone is the primary identity in this market (PRD §3.1). Supabase Auth supports pluggable SMS providers, so **MSG91** handles DLT-compliant Indian delivery. Clerk's SMS routing is less controllable and its Indian deliverability story is weaker, which matters when a failed OTP means a locked-out treasurer.
3. **It issues the JWT that RLS reads.** Supabase Auth's `auth.uid()` integrates natively with Postgres RLS policies. With Clerk you bridge identity into the database yourself — workable, but an extra security-critical seam.

Clerk's advantages (superb prebuilt UI, organisation primitives, better DX) are real but less decisive here: we need custom onboarding screens anyway, and "organisations" do not model society↔apartment↔occupancy relationships, so that primitive would go unused.

**Architectural boundary:** Supabase Auth owns *identity* (who you are). The `members` table owns *authorisation* (what you may do, per society). The API verifies the Supabase JWT via JWKS, then loads memberships. Swapping auth providers later means changing token verification in one guard — nothing else.

## 2.5 Storage

**Supabase Storage for MVP → Cloudflare R2 at scale.** Cloudinary and S3 are rejected as the primary.

| Option | Verdict |
|---|---|
| **Supabase Storage** ✅ MVP | S3-compatible, same RLS policy engine as the database, presigned uploads and downloads built in, one vendor to operate. Zero integration cost given Supabase is already present. |
| **Cloudflare R2** ✅ scale | S3-compatible, **zero egress fees**. Decisive here: bill images and receipts are read many times more often than written, so egress dominates cost. Migration is a bucket copy plus an env var because the adapter interface is identical. |
| **AWS S3** 🟡 enterprise option | Keep for Enterprise customers demanding AWS residency guarantees. Egress cost makes it the wrong default. |
| **Cloudinary** ❌ | Excellent transformation pipeline, but priced for media-heavy consumer apps and far more expensive per GB. We need on-device compression and simple storage, not server-side transformation — the client already compresses to < 400 KB before upload (PRD §3.4). |

All three are addressed through one `StorageProvider` interface (§10.2), so the choice is reversible.

## 2.6 Notifications

Four channels, one orchestrator, four adapters:

| Channel | Provider | Architectural notes |
|---|---|---|
| **Push** | **Expo Push Notifications** over FCM/APNs | One API for both platforms, free, handles token lifecycle and delivery receipts. Configure FCM v1 and APNs keys directly so raw FCM remains a drop-in replacement if Expo's service ever becomes a bottleneck. Batch 100 tokens per request; poll receipts and prune `DeviceNotRegistered` tokens. |
| **Raw FCM** | Deferred | Only if Expo Push delivery rates fall below the 95% target, or if Enterprise customers demand per-topic fan-out at a scale Expo's service throttles. The adapter interface makes this a swap, not a rewrite. |
| **Email** | **Resend** (MVP) → AWS SES (volume) | React Email templates live in `packages/emails` and are rendered server-side. Bills, receipts, reports, auth. |
| **SMS** | **MSG91** with Twilio failover | DLT-registered templates. Reserved for OTP and T+15 overdue reminders only — it is the largest variable cost in the system. |
| **WhatsApp** | Meta Cloud API via BSP (Phase 2) | Highest engagement channel in India; template approval required. |
| **In-app** | `notifications` table | Always written, regardless of other channels. The table is the source of truth; push is delivery. |

The orchestrator reads the event→channel matrix from configuration, applies per-user preferences and quiet hours, deduplicates, batches, then hands each message to a channel adapter. Channel failures are retried independently and never block each other.

---

# 3. Clean Architecture

## 3.1 Layer Model

Four layers, dependencies pointing **inward only**. The domain layer knows nothing about NestJS, Postgres, Razorpay or React.

```mermaid
graph TB
    subgraph L1["Presentation (outermost)"]
        P1["Controllers · Screens"]
        P2["DTOs · ViewModels"]
    end
    subgraph L2["Application"]
        A1["Use Cases"]
        A2["Ports (interfaces)"]
        A3["Application Services"]
    end
    subgraph L3["Domain (innermost)"]
        D1["Entities"]
        D2["Value Objects"]
        D3["Domain Services"]
        D4["Domain Events"]
    end
    subgraph L4["Infrastructure"]
        I1["Repositories (Drizzle)"]
        I2["Provider Adapters"]
        I3["Queue · Cache · Storage"]
    end

    P1 --> A1
    A1 --> D1
    A1 --> A2
    I1 -.implements.-> A2
    I2 -.implements.-> A2
    I1 --> D1
```

**The dependency rule, stated operationally:** a file in `domain/` may not contain a single `import` from `@nestjs/*`, `drizzle-orm`, `razorpay`, `react`, or any other framework. This is enforced by a dependency-cruiser rule in CI, not by convention.

## 3.2 Domain Layer

Pure TypeScript. No decorators, no I/O, no dates read from `Date.now()` (time is injected).

### Entities
Objects with identity and a lifecycle. They hold invariants and refuse to exist in an invalid state.

```ts
// domain/expense/expense.entity.ts
export class Expense {
  private constructor(
    readonly id: ExpenseId,
    readonly societyId: SocietyId,
    private _amount: Money,
    private _status: ExpenseStatus,
    private _splits: ReadonlyArray<ExpenseSplit>,
    private _version: number,
  ) {}

  static create(props: CreateExpenseProps): Result<Expense, DomainError> {
    if (props.amount.isZeroOrNegative()) return err(new InvalidAmountError());
    if (props.expenseDate.isMoreThanDaysInFuture(30)) return err(new FutureDatedExpenseError());
    return ok(new Expense(ExpenseId.generate(), props.societyId, props.amount, 'draft', [], 1));
  }

  publish(allocations: ReadonlyArray<Allocation>, clock: Clock): Result<DomainEvent[], DomainError> {
    if (this._status !== 'draft' && this._status !== 'pending_approval')
      return err(new InvalidTransitionError(this._status, 'published'));

    const total = allocations.reduce((s, a) => s.add(a.amount), Money.zero());
    if (!total.equals(this._amount)) return err(new SplitMismatchError(total, this._amount));

    this._splits = allocations.map(ExpenseSplit.fromAllocation);
    this._status = 'published';
    return ok([new ExpensePublishedEvent(this.id, this.societyId, clock.now())]);
  }

  void_(reason: string, by: MemberId): Result<DomainEvent[], DomainError> {
    if (reason.trim().length < 10) return err(new VoidReasonTooShortError());
    if (this._status !== 'published') return err(new InvalidTransitionError(this._status, 'void'));
    this._status = 'void';
    return ok([new ExpenseVoidedEvent(this.id, by, reason)]);
  }
}
```

Note what is *not* here: no `save()`, no database awareness, no HTTP concepts. The entity validates the split total itself — the single most important invariant in the system lives inside the object that owns it.

### Value Objects
Immutable, compared by value, self-validating. These eliminate an entire class of bug.

```ts
// domain/shared/money.vo.ts
export class Money {
  private constructor(private readonly paise: bigint, readonly currency: Currency) {}

  static fromPaise(p: bigint | number): Money { return new Money(BigInt(p), 'INR'); }
  static fromRupees(r: string): Result<Money, DomainError> { /* parses "4,250.75" exactly */ }

  add(o: Money): Money { this.assertSameCurrency(o); return new Money(this.paise + o.paise, this.currency); }
  subtract(o: Money): Money { /* … */ }
  multiplyByWeight(w: Weight): Money { /* integer maths only */ }
  allocateByWeights(weights: Weight[]): Money[] { /* deterministic residual distribution */ }
  equals(o: Money): boolean { return this.paise === o.paise && this.currency === o.currency; }
  toPaise(): bigint { return this.paise; }
  format(locale = 'en-IN'): string { /* ₹4,250.75 with lakh grouping */ }
}
```

The full value-object catalogue: `Money`, `Paise`, `Weight`, `Percentage`, `PhoneNumber` (E.164 + Indian validation), `EmailAddress`, `GSTIN` (checksum-validated), `ApartmentNumber`, `JoinCode`, `ReceiptNumber`, `DateRange`, `BillingPeriod`, `FinancialYear`, `AgeingBucket`, `SLADeadline`. Every identifier is a branded type (`ExpenseId`, `MemberId`, `SocietyId`) so passing a member id where an expense id belongs is a compile error.

### Domain Services
Logic that spans entities and belongs to no single one.
- `SplitEngine` — the PRD's five strategies, pure, shared with the client via `packages/split-engine`.
- `PaymentAllocator` — oldest-due-first allocation across dues, including late fees before principal.
- `DuesCalculator` — arrears carry-forward, late-fee computation, ageing bucketing.
- `PermissionEvaluator` — the role matrix as a pure function `can(role, action, resource) → boolean`.
- `CycleChargeCalculator` — charge heads × apartments → charge lines.

### Domain Events
`ExpensePublished`, `ExpenseVoided`, `CyclePublished`, `PaymentVerified`, `DueOverdue`, `ComplaintAssigned`, `MemberRoleChanged`, `VisitorApprovalRequested`. Raised by entities, collected by the use case, dispatched **after** commit.

## 3.3 Application Layer

### Use Cases
One class, one business operation, one public method. This is where transactions begin and end.

```ts
// application/expenses/publish-expense.use-case.ts
@Injectable()
export class PublishExpenseUseCase {
  constructor(
    @Inject(EXPENSE_REPOSITORY) private readonly expenses: IExpenseRepository,
    @Inject(MEMBER_REPOSITORY)  private readonly members: IMemberRepository,
    @Inject(BALANCE_REPOSITORY) private readonly balances: IBalanceRepository,
    @Inject(UNIT_OF_WORK)       private readonly uow: IUnitOfWork,
    @Inject(EVENT_BUS)          private readonly events: IEventBus,
    @Inject(CLOCK)              private readonly clock: Clock,
    private readonly splitEngine: SplitEngine,
    private readonly audit: AuditService,
  ) {}

  async execute(cmd: PublishExpenseCommand): Promise<Result<PublishExpenseResult, AppError>> {
    return this.uow.transaction(async (tx) => {
      const expense = await this.expenses.findById(cmd.expenseId, cmd.societyId, tx);
      if (!expense) return err(AppError.notFound('Expense'));
      if (expense.version !== cmd.expectedVersion) return err(AppError.conflict(expense.version));

      const participants = await this.members.resolveSelector(
        expense.participantSelector, cmd.societyId, tx,
      );
      const allocations = this.splitEngine.compute({
        amount: expense.amount, strategy: expense.strategy,
        participants, config: expense.splitConfig,
      });

      const published = expense.publish(allocations, this.clock);
      if (published.isErr()) return err(AppError.fromDomain(published.error));

      await this.expenses.save(expense, tx);
      await this.balances.applyDues(expense.toDues(), tx);
      await this.audit.record('expense.publish', expense, cmd.actor, tx);

      this.events.enqueue(published.value);       // dispatched post-commit
      return ok(PublishExpenseResult.from(expense));
    });
  }
}
```

Rules for use cases:
- Depend on **ports**, never concrete classes.
- Return `Result<T, E>`, never throw for expected failures. Throw only for programmer errors.
- Own the transaction boundary. Nothing below them opens or commits a transaction.
- Never import a NestJS HTTP type. A use case does not know what an HTTP request is.

### Ports (Interfaces)
Defined in `application/ports/`, implemented in `infrastructure/`.

```ts
export interface IExpenseRepository {
  findById(id: ExpenseId, societyId: SocietyId, tx?: Tx): Promise<Expense | null>;
  findMany(q: ExpenseQuery, tx?: Tx): Promise<Page<Expense>>;
  save(expense: Expense, tx?: Tx): Promise<void>;
}
export interface IPaymentGateway {
  createOrder(o: CreateOrderInput): Promise<GatewayOrder>;
  verifySignature(p: SignaturePayload): boolean;
  refund(paymentId: string, amount: Money): Promise<GatewayRefund>;
}
export interface INotificationChannel { send(m: OutboundMessage): Promise<DeliveryResult>; }
export interface IStorageProvider {
  presignUpload(key: string, contentType: string, maxBytes: number): Promise<PresignedUpload>;
  presignDownload(key: string, ttlSeconds: number): Promise<string>;
  delete(key: string): Promise<void>;
}
export interface ILLMGateway { complete(r: LLMRequest): Promise<LLMResponse>; }
export interface IUnitOfWork { transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>; }
export interface Clock { now(): Instant; today(tz: Timezone): CalendarDate; }
```

### Application Services
Orchestration that is not a single business transaction: `NotificationOrchestrator`, `ReportGenerator`, `SyncService`, `AISuggestionService`. They may call multiple use cases but hold no domain rules of their own.

### DTOs
Three distinct shapes, never conflated:
- **Request DTOs** — validated HTTP input, defined as Zod schemas in `packages/contracts`, consumed by both client and server.
- **Commands** — internal use-case input, using domain value objects (`Money`, not `number`).
- **Response DTOs** — serialisable output. Mapped explicitly from entities by a `Mapper`; entities are never returned to a controller.

```ts
// packages/contracts/expenses.ts
export const PublishExpenseRequest = z.object({
  expectedVersion: z.number().int().nonnegative(),
  sendNotifications: z.boolean().default(true),
}).strict();
export type PublishExpenseRequest = z.infer<typeof PublishExpenseRequest>;
```

## 3.4 Infrastructure Layer

Everything that talks to the outside world.

```
infrastructure/
├── persistence/
│   ├── drizzle/schema/          # table definitions (shared with mobile SQLite)
│   ├── repositories/            # ExpenseRepository implements IExpenseRepository
│   ├── mappers/                 # row ⇄ entity
│   └── unit-of-work.ts
├── gateways/
│   ├── razorpay/                # implements IPaymentGateway
│   ├── expo-push/  msg91/  resend/  whatsapp/     # implement INotificationChannel
│   ├── supabase-storage/  r2/   # implement IStorageProvider
│   └── llm/  anthropic/  gemini/                  # implement ILLMGateway
├── queue/                       # BullMQ producers + processors
├── cache/                       # Redis
└── auth/                        # Supabase JWKS verification
```

Repositories translate rows to entities and back. They never contain business rules — a repository that decides whether an expense *may* be published is a bug.

## 3.5 Presentation Layer

**Backend controllers** are thin: validate → build command → call use case → map result to HTTP.

```ts
@Controller('expenses')
@UseGuards(AuthGuard, SocietyGuard, PermissionGuard)
export class ExpensesController {
  constructor(private readonly publishExpense: PublishExpenseUseCase) {}

  @Post(':id/publish')
  @RequirePermission('expense.publish')
  @Audited('expense.publish')
  @HttpCode(200)
  async publish(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(PublishExpenseRequest)) body: PublishExpenseRequest,
    @Ctx() ctx: RequestContext,
  ) {
    const result = await this.publishExpense.execute({
      expenseId: ExpenseId.of(id), societyId: ctx.societyId,
      actor: ctx.member, expectedVersion: body.expectedVersion,
    });
    if (result.isErr()) throw HttpErrorMapper.map(result.error);
    return ExpenseMapper.toResponse(result.value);
  }
}
```

A controller method over ~15 lines is doing something a use case should own.

**Mobile presentation** mirrors the same layering: route file → screen component → feature hook → API client. Screens contain no business logic; hooks contain no JSX.

## 3.6 Dependency Injection

NestJS DI with **symbol tokens for every port**, so the domain never references a concrete class:

```ts
export const EXPENSE_REPOSITORY = Symbol('EXPENSE_REPOSITORY');

@Module({
  providers: [
    PublishExpenseUseCase,
    { provide: EXPENSE_REPOSITORY, useClass: DrizzleExpenseRepository },
    { provide: PAYMENT_GATEWAY, useClass: RazorpayGateway },
    { provide: CLOCK, useClass: SystemClock },
  ],
  exports: [PublishExpenseUseCase],
})
export class ExpensesModule {}
```

In tests, swap `useClass: InMemoryExpenseRepository` and `useValue: new FixedClock('2026-09-19T00:00:00Z')`. Use-case tests then run in milliseconds with no database and no time flakiness — which is what makes 100% coverage on the financial core achievable rather than aspirational.

**On the mobile side** there is no DI container. Dependency inversion is achieved through module boundaries and hook composition: a screen imports `useExpenses()`, which imports the API client, which imports the transport. Tests replace the transport with MSW.

---

# 4. Folder Structure

## 4.1 Repository Root

```
society-expense-splitter/
├── apps/
│   ├── mobile/                  # Expo app
│   ├── api/                     # NestJS API + worker
│   └── admin/                   # Next.js admin console (Phase 3, scaffolded empty)
├── packages/
│   ├── contracts/               # Zod schemas — the API contract, shared
│   ├── domain/                  # pure domain layer, shared by api + mobile
│   ├── split-engine/            # ⚠ the single most important shared package
│   ├── db-schema/               # Drizzle table definitions (Postgres + SQLite variants)
│   ├── api-types/               # generated from OpenAPI (CI artefact, gitignored source)
│   ├── emails/                  # React Email templates
│   ├── i18n/                    # translation catalogues
│   └── config/                  # eslint, tsconfig, prettier, jest presets
├── docs/
├── scripts/
├── infra/
├── .github/
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
```

**Why the domain is a shared package:** the split engine, `Money`, permission evaluation and due calculation must behave identically on both sides. Duplicating them guarantees eventual divergence. `packages/domain` has zero runtime dependencies and compiles for both Node and Hermes.

## 4.2 Mobile

```
apps/mobile/
├── app/                                  # Expo Router — ROUTES ONLY, thin wrappers
│   ├── _layout.tsx                       # providers: Query, theme, i18n, error boundary
│   ├── index.tsx                         # splash + route resolver
│   ├── +not-found.tsx
│   ├── (auth)/
│   │   ├── _layout.tsx
│   │   ├── welcome.tsx  login.tsx  signup.tsx
│   │   ├── phone.tsx  otp.tsx
│   │   └── forgot-password.tsx  reset-password.tsx
│   ├── (setup)/
│   │   ├── _layout.tsx
│   │   ├── profile-setup.tsx  society-choice.tsx
│   │   ├── create/[step].tsx
│   │   └── join/index.tsx  join/pending.tsx
│   ├── (app)/
│   │   ├── _layout.tsx                   # tab navigator + auth guard
│   │   ├── home/index.tsx  home/notifications.tsx
│   │   ├── expenses/index.tsx  [id].tsx  new.tsx  [id]/edit.tsx  scan.tsx
│   │   ├── payments/index.tsx  history.tsx  cycles/index.tsx  cycles/[id].tsx  outstanding.tsx
│   │   ├── community/notices.tsx  notices/[id].tsx  complaints/index.tsx  complaints/[id].tsx  visitors.tsx
│   │   └── more/index.tsx  reports/…  members/…  settings/…  ai/…
│   └── (modals)/
│       ├── pay/[dueIds].tsx  society-switcher.tsx
│       ├── visitor-approval/[id].tsx  attachment/[id].tsx
│       └── paywall.tsx  confirm.tsx
├── src/
│   ├── features/                         # vertical slices — the primary organising unit
│   │   ├── auth/
│   │   │   ├── api/            auth.api.ts
│   │   │   ├── hooks/          useLogin.ts  useOtp.ts  useSession.ts
│   │   │   ├── components/     OtpInput.tsx  PhoneField.tsx
│   │   │   ├── screens/        LoginScreen.tsx  OtpScreen.tsx
│   │   │   └── __tests__/
│   │   ├── society/  members/  expenses/  payments/  maintenance/
│   │   ├── complaints/  notices/  visitors/  reports/
│   │   ├── notifications/  ai/  subscription/  sync/
│   │   └── …                             # each with the same 5 sub-folders
│   ├── components/
│   │   ├── ui/                 Button.tsx  Card.tsx  Sheet.tsx  Money.tsx  Chip.tsx
│   │   │                       Skeleton.tsx  EmptyState.tsx  ErrorState.tsx  Badge.tsx
│   │   ├── forms/              FormField.tsx  AmountInput.tsx  DateField.tsx  SelectField.tsx
│   │   ├── feedback/           SyncChip.tsx  OfflineBanner.tsx  Toast.tsx
│   │   └── layout/             Screen.tsx  Header.tsx  TabBar.tsx  KeyboardAvoider.tsx
│   ├── lib/
│   │   ├── api/                client.ts  interceptors.ts  errors.ts  idempotency.ts
│   │   ├── db/                 schema.ts  migrations/  queries/  client.ts
│   │   ├── sync/               outbox.ts  puller.ts  pusher.ts  conflicts.ts  engine.ts
│   │   ├── storage/            mmkv.ts  secure.ts  files.ts
│   │   ├── permissions.ts      analytics.ts  logger.ts  deeplinks.ts  network.ts
│   ├── stores/                 auth.store.ts  society.store.ts  sync.store.ts
│   │                           ui.store.ts  draft.store.ts
│   ├── theme/                  tokens.ts  tailwind-preset.js  typography.ts  charts.ts
│   ├── i18n/                   index.ts  (catalogues come from packages/i18n)
│   ├── hooks/                  useDebounce.ts  useAppState.ts  useNetwork.ts
│   ├── constants/              config.ts  limits.ts  routes.ts
│   └── types/                  globals.d.ts  nativewind-env.d.ts
├── assets/
│   ├── fonts/                  Inter-*.ttf  NotoSansDevanagari-*.ttf
│   ├── images/                 icon.png  splash.png  adaptive-icon.png
│   └── illustrations/          empty-*.svg  (light + dark variants)
├── __tests__/                  setup.ts  mocks/  factories/
├── .maestro/                   e2e flows (yaml)
├── app.config.ts   eas.json   tailwind.config.js   metro.config.js   babel.config.js
└── tsconfig.json
```

**Hard rules:**
- A file in `app/` is a route wrapper: import the screen, render it, nothing else. Target under 20 lines.
- Cross-feature imports are forbidden. If `expenses` needs something from `members`, that thing belongs in `lib/` or `packages/domain`.
- No barrel `index.ts` re-exporting a whole folder — it breaks tree-shaking and creates import cycles.

## 4.3 Backend

```
apps/api/
├── src/
│   ├── main.ts                           # HTTP bootstrap (Fastify adapter)
│   ├── worker.ts                         # BullMQ worker bootstrap — separate process
│   ├── app.module.ts
│   ├── modules/
│   │   ├── expenses/
│   │   │   ├── expenses.module.ts
│   │   │   ├── presentation/
│   │   │   │   ├── expenses.controller.ts
│   │   │   │   └── expense.mapper.ts
│   │   │   ├── application/
│   │   │   │   ├── use-cases/  create-expense.use-case.ts  publish-expense.use-case.ts
│   │   │   │   │               void-expense.use-case.ts    preview-split.use-case.ts
│   │   │   │   ├── ports/      expense.repository.ts
│   │   │   │   └── commands/
│   │   │   ├── infrastructure/
│   │   │   │   └── drizzle-expense.repository.ts
│   │   │   └── __tests__/
│   │   ├── auth/  societies/  members/  payments/  maintenance/
│   │   ├── complaints/  notices/  visitors/  reports/
│   │   ├── notifications/  ai/  subscription/  sync/  audit/
│   │   └── health/
│   ├── common/
│   │   ├── guards/             auth.guard.ts  society.guard.ts  permission.guard.ts
│   │   │                       plan.guard.ts  throttle.guard.ts
│   │   ├── interceptors/       envelope.interceptor.ts  audit.interceptor.ts
│   │   │                       logging.interceptor.ts  timeout.interceptor.ts
│   │   ├── filters/            http-exception.filter.ts  domain-error.filter.ts
│   │   ├── decorators/         @Ctx  @RequirePermission  @Audited  @Idempotent
│   │   ├── pipes/              zod.pipe.ts
│   │   ├── context/            request-context.ts  als.ts   # AsyncLocalStorage
│   │   └── errors/             app-error.ts  http-error-mapper.ts
│   ├── infrastructure/
│   │   ├── database/           drizzle.provider.ts  unit-of-work.ts  migrations/  seeds/
│   │   ├── cache/              redis.provider.ts  cache.service.ts
│   │   ├── queue/              bull.provider.ts  queues.ts
│   │   ├── gateways/           razorpay/  expo-push/  msg91/  resend/  whatsapp/
│   │   │                       supabase-storage/  r2/  llm/
│   │   ├── auth/               jwks.verifier.ts  supabase-admin.client.ts
│   │   └── observability/      sentry.ts  otel.ts  metrics.ts
│   ├── jobs/
│   │   ├── processors/         cycle-generate.processor.ts  cycle-publish.processor.ts
│   │   │                       reminders.processor.ts  late-fees.processor.ts
│   │   │                       report-export.processor.ts  reconciliation.processor.ts
│   │   │                       ocr.processor.ts  notification-dispatch.processor.ts
│   │   └── schedules/          cron.definitions.ts
│   └── config/                 configuration.ts  validation.schema.ts
├── test/
│   ├── integration/            per-module endpoint suites (Testcontainers)
│   ├── fixtures/               society.fixture.ts  expense.fixture.ts
│   └── utils/                  test-app.ts  auth-helper.ts
├── drizzle.config.ts   nest-cli.json   Dockerfile   tsconfig.json
```

## 4.4 Shared Packages

```
packages/
├── contracts/
│   ├── src/
│   │   ├── auth.ts  societies.ts  expenses.ts  payments.ts  maintenance.ts
│   │   ├── complaints.ts  notices.ts  visitors.ts  reports.ts  sync.ts
│   │   ├── common/         pagination.ts  envelope.ts  errors.ts
│   │   └── index.ts
│   └── package.json                       # zero deps except zod
├── domain/
│   ├── src/
│   │   ├── shared/         money.vo.ts  ids.ts  result.ts  clock.ts  errors.ts
│   │   ├── expense/        expense.entity.ts  expense-split.vo.ts  events.ts
│   │   ├── payment/        payment.entity.ts  allocator.service.ts
│   │   ├── member/         member.entity.ts  permission-evaluator.ts
│   │   ├── maintenance/    cycle.entity.ts  charge-head.vo.ts  calculator.ts
│   │   └── index.ts
│   └── __tests__/                         # 100% coverage required
├── split-engine/
│   ├── src/
│   │   ├── strategies/     equal.ts  percentage.ts  shares.ts  apartment.ts  custom.ts
│   │   ├── bases/          per-flat.ts  per-sqft.ts  per-bhk.ts  floor-band.ts  parking.ts
│   │   ├── rounding.ts     participants.ts  engine.ts  types.ts
│   └── __tests__/          property-based tests (fast-check) — 100% coverage
├── db-schema/
│   ├── src/postgres/       full Drizzle schema for Postgres
│   ├── src/sqlite/         mirrored subset for the mobile replica + outbox
│   └── src/shared/         column helpers, audit fields, enums
├── api-types/                              # generated by CI from OpenAPI
├── emails/                 react-email templates + preview server
├── i18n/                   en.json  hi.json  mr.json  ta.json  te.json  kn.json  bn.json  gu.json
└── config/                 eslint-preset/  tsconfig/  jest-preset/  prettier/
```

## 4.5 Documentation, Assets, Tests, Scripts, CI/CD, Infra

```
docs/
├── PRD.md
├── SAD.md                                 # this document
├── ARCHITECTURE_DECISIONS/
│   ├── ADR-0001-modular-monolith.md
│   ├── ADR-0002-nativewind-over-paper.md
│   ├── ADR-0003-drizzle-over-prisma.md
│   ├── ADR-0004-supabase-auth-over-clerk.md
│   ├── ADR-0005-money-as-bigint-paise.md
│   └── ADR-0006-rls-row-tenancy.md
├── api/OPENAPI.yaml                       # generated, committed for diffing
├── runbooks/
│   ├── INCIDENT_RESPONSE.md   BALANCE_REBUILD.md   WEBHOOK_REPLAY.md
│   ├── RESTORE_DRILL.md       CYCLE_PUBLISH_FAILURE.md   ONCALL.md
├── guides/
│   ├── LOCAL_SETUP.md  CONTRIBUTING.md  TESTING.md  RELEASE.md
└── diagrams/                              # mermaid sources

scripts/
├── db/          migrate.ts  seed.ts  reset.ts  anonymise-dump.ts
├── codegen/     openapi-to-types.ts  i18n-extract.ts  drizzle-to-sqlite.ts
├── release/     bump-version.ts  changelog.ts  eas-submit.ts
├── ops/         rebuild-balances.ts  replay-webhooks.ts  prune-tokens.ts
└── dev/         setup.sh  doctor.ts

infra/
├── terraform/   environments/{dev,staging,prod}/  modules/{rds,redis,ecs,r2,cloudfront}/
├── docker/      api.Dockerfile  worker.Dockerfile  docker-compose.dev.yml
└── k8s/                                   # Phase 4 only

.github/
├── workflows/
│   ├── ci.yml                 # typecheck · lint · unit · integration · build
│   ├── mobile-preview.yml     # EAS preview build per PR
│   ├── mobile-release.yml     # store builds + OTA
│   ├── api-deploy.yml         # staging on merge, prod on tag
│   ├── e2e.yml                # Maestro nightly on main
│   ├── contract-check.yml     # OpenAPI breaking-change diff
│   └── security.yml           # Snyk, audit, secret scan
├── PULL_REQUEST_TEMPLATE.md
├── ISSUE_TEMPLATE/
└── CODEOWNERS
```

---

# 5. Navigation Architecture

## 5.1 Structure

Expo Router file-based routing, with four route groups that map exactly to the four states a session can be in.

```mermaid
stateDiagram-v2
    [*] --> Splash
    Splash --> Auth: no valid token
    Splash --> Setup: token, no active membership
    Splash --> App: token + active membership
    Auth --> Setup: authenticated
    Setup --> App: society joined/created
    App --> Auth: logout / refresh failure
    App --> Setup: removed from last society
    state App {
        [*] --> Home
        Home --> Expenses
        Expenses --> Payments
        Payments --> Community
        Community --> More
    }
```

## 5.2 Authentication Flow

The resolver in `app/index.tsx` runs once per cold start and is the only place routing decisions are made:

```ts
export default function Index() {
  const { status, user } = useSessionRestore();      // SecureStore → refresh → /auth/me
  const { memberships, lastUsedSocietyId } = useSocietyStore();

  if (status === 'restoring') return <SplashScreen />;
  if (status === 'unauthenticated')        return <Redirect href="/(auth)/welcome" />;
  if (!user.profileComplete)               return <Redirect href="/(setup)/profile-setup" />;
  if (memberships.length === 0)            return <Redirect href="/(setup)/society-choice" />;
  if (memberships.every(m => m.status === 'pending')) return <Redirect href="/(setup)/join/pending" />;
  return <Redirect href="/(app)/home" />;
}
```

**Session restore is synchronous-first:** MMKV holds a cached session snapshot read synchronously, so the app renders the correct group on the first frame; the network validation happens in the background and only redirects if it fails. This removes the white flash that plagues token-restore flows on cold start.

## 5.3 Main Tabs and Nested Stacks

Five tabs (`home`, `expenses`, `payments`, `community`, `more`), each owning an independent stack.

```
(app)/_layout.tsx           Tabs
 └── expenses/_layout.tsx   Stack
      ├── index             list
      ├── [id]              detail
      ├── [id]/edit         form
      ├── new               form
      └── scan              camera
```

**Tab state preservation is mandatory.** `unmountOnBlur` is false everywhere; scroll positions, open forms and filter selections survive tab switches. A treasurer half-way through an expense form who checks a notice must return to their draft intact.

**Modals** live in `(modals)/` and are presented over any stack with `presentation: 'modal'`. Modal routes are used when the task is orthogonal to the current stack: paying, approving a visitor, switching societies, viewing an attachment, hitting a paywall.

## 5.4 Deep Linking

Scheme `societyexpense://` plus universal links on `https://app.societysplit.in`.

| Link | Route | Notes |
|---|---|---|
| `/join?code=ABC123` | `(setup)/join` | Works unauthenticated; code preserved through auth |
| `/expenses/:id` | `(app)/expenses/[id]` | Requires membership in that expense's society |
| `/payments/receipt/:id` | `(modals)/attachment/[id]` | |
| `/complaints/:id` | `(app)/community/complaints/[id]` | |
| `/notices/:id` | `(app)/community/notices/[id]` | |
| `/visitors/approve/:id` | `(modals)/visitor-approval/[id]` | Cold-starts straight into the modal |
| `/cycles/:id` | `(app)/payments/cycles/[id]` | Treasurer/admin only |

**Intent preservation.** A deep link received while unauthenticated is stored in MMKV as `pendingIntent`, the user completes auth, and the resolver consumes it after landing. Same mechanism handles a link into a society the user is not currently switched to: the router switches `activeSocietyId` first, waits for the cache swap, then navigates. A link to a society the user does not belong to renders the Permission Denied screen — never a raw error.

Push payloads always carry `{ type, entityId, societyId }` and are converted to an internal path by `lib/deeplinks.ts`, which is the single mapping table for both push and URL entry.

## 5.5 Protected Routes

Three enforcement layers, each necessary:

1. **Group-level guard.** `(app)/_layout.tsx` redirects to `(auth)` if the session is invalid. This handles navigation, not security.
2. **Route-level permission guard.** A `<RequirePermission action="cycle.publish">` wrapper renders Permission Denied instead of the screen. Applied in the route file so it cannot be bypassed by direct navigation or a deep link.
3. **Server-side authorisation.** The API rejects the request regardless of what the client did. **This is the only layer that provides security.**

```tsx
// app/(app)/payments/cycles/[id].tsx
export default function CycleRoute() {
  return (
    <RequirePermission action="cycle.view" fallback={<PermissionDenied />}>
      <CycleDetailScreen />
    </RequirePermission>
  );
}
```

Plan-gated routes wrap additionally in `<RequirePlan feature="ai_assistant" />`, which presents the paywall modal rather than blocking navigation — the user should see what they are missing, not a dead end.

**Android hardware back:** within a tab, pop; at a tab root, switch to Home; at Home, double-tap-to-exit with a toast. Modals always dismiss rather than navigating back.

---

# 6. State Management

## 6.1 The Division

| Kind of state | Where it lives | Why |
|---|---|---|
| Server data (expenses, dues, members) | **TanStack Query** over **SQLite** | It is a cache of server truth with lifecycle needs |
| Session, active society, role | **Zustand** (persisted, MMKV) | Small, synchronous, read everywhere |
| Form field values | **React Hook Form** | Uncontrolled inputs, minimal re-renders |
| Form validation rules | **Zod** (from `packages/contracts`) | Same schema validates client and server |
| Pending mutations | **SQLite outbox** | Must survive app kill |
| Ephemeral UI (sheet open, tab index) | `useState` | Not worth a store |
| Theme, language, flags | **Zustand** + MMKV | Read before first paint |

**The rule that prevents most state bugs:** if it comes from the server, it does not go in Zustand. Ever. Duplicating server data into a client store means two copies with independent staleness, and the resulting "why is the balance different on this screen" bug is very hard to find.

## 6.2 Global State — Zustand

Chosen over Redux Toolkit and Context for concrete reasons:
- **No provider tree, no boilerplate.** Five stores total, ~250 lines combined. RTK for the same surface is several times that, and most of it would be slice ceremony for state that is a handful of primitives.
- **Selector subscriptions prevent re-render storms.** `useSocietyStore(s => s.activeSocietyId)` re-renders only on that field. Context re-renders every consumer on any change — fatal for a 200-row cycle grid.
- **Synchronous reads outside React.** The API client interceptor needs `activeSocietyId` to set a header; with Zustand it calls `useSocietyStore.getState()`. With Context it cannot.
- **Trivially persistable** via the `persist` middleware with an MMKV adapter, with `partialize` to exclude transient fields.

```ts
export const useSocietyStore = create<SocietyState>()(
  persist(
    (set, get) => ({
      activeSocietyId: null,
      memberships: [],
      setActive: (id) => { set({ activeSocietyId: id }); queryClient.clear(); },
      can: (action) => {
        const m = get().memberships.find(x => x.societyId === get().activeSocietyId);
        return m ? evaluatePermission(m.role, action) : false;   // from packages/domain
      },
    }),
    { name: 'society', storage: mmkvJSONStorage,
      partialize: (s) => ({ activeSocietyId: s.activeSocietyId, memberships: s.memberships }) },
  ),
);
```

Stores: `auth` (user, session status), `society` (active society, memberships, `can()`), `sync` (online flag, pending count, per-op errors), `ui` (theme, language, banners), `draft` (autosaved forms, persisted).

## 6.3 Server State — TanStack Query

Chosen over RTK Query and SWR because:
- **Mutation lifecycle hooks** (`onMutate`/`onError`/`onSettled`) give optimistic updates with automatic rollback as a first-class contract, which is precisely what offline expense creation needs. SWR's mutation story is thinner; RTK Query's requires more wiring.
- **Per-query cache policy.** Dues need a 30-second stale time; categories can sit for an hour. Query expresses this declaratively per key.
- **Query cancellation, deduplication, retry with backoff, and `select` transforms** are built in. Hand-rolling these in `useEffect` is where most React Native data bugs originate.
- **Persistence adapter** integrates cleanly with MMKV, with a version buster so a schema change cannot resurrect an incompatible cache.

### Key factory — every key is society-scoped

```ts
export const qk = {
  all: (sid: SocietyId) => ['s', sid] as const,
  expenses: (sid, f?: ExpenseFilters) => [...qk.all(sid), 'expenses', f ?? {}] as const,
  expense:  (sid, id)     => [...qk.all(sid), 'expense', id] as const,
  dues:     (sid, mid?)   => [...qk.all(sid), 'dues', mid ?? 'all'] as const,
  balance:  (sid, mid)    => [...qk.all(sid), 'balance', mid] as const,
  cycle:    (sid, id)     => [...qk.all(sid), 'cycle', id] as const,
};
```

Every key beginning with `['s', societyId]` means switching societies invalidates by prefix in one call, and no cached row can leak across tenants. This is a security property expressed as a naming convention — a CI test asserts every key factory entry starts with `qk.all`.

### Optimistic mutation pattern (the canonical shape — copy it)

```ts
export function useCreateExpense() {
  const sid = useSocietyStore(s => s.activeSocietyId!);
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateExpenseInput) => expenseApi.create(sid, input),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: qk.expenses(sid) });
      const previous = qc.getQueryData(qk.expenses(sid));
      const optimistic = buildOptimisticExpense(input);       // temp id: local_*
      await db.insert(expenses).values(toRow(optimistic));    // SQLite first
      await outbox.enqueue({ entity: 'expenses', op: 'create', payload: input });
      qc.setQueryData(qk.expenses(sid), (old) => prepend(old, optimistic));
      return { previous, tempId: optimistic.id };
    },
    onError: (_e, _v, ctx) => {
      qc.setQueryData(qk.expenses(sid), ctx!.previous);
      db.delete(expenses).where(eq(expenses.id, ctx!.tempId));
    },
    onSuccess: (server, _v, ctx) => { syncEngine.rewriteTempId(ctx!.tempId, server.id); },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: qk.expenses(sid) });
      qc.invalidateQueries({ queryKey: qk.dues(sid) });
    },
  });
}
```

### Stale time policy

| Data | staleTime | gcTime | refetchOnFocus |
|---|---|---|---|
| Society, settings, categories, charge heads | 60 min | 24 h | no |
| Members, apartments | 30 min | 24 h | no |
| Expenses list | 2 min | 24 h | yes |
| Dues, balance | 30 s | 24 h | yes |
| Outstanding / reports | 5 min | 6 h | yes |
| Notices, complaints | 60 s | 24 h | yes |
| Notifications | 30 s | 1 h | yes |

## 6.4 Forms — React Hook Form + Zod

RHF keeps inputs uncontrolled, so typing an amount does not re-render the whole expense form — noticeable on low-end devices with a 20-field form open. Zod schemas come from `packages/contracts`, meaning the client validates against the *exact* schema the server will apply; a validation rule can never drift between the two.

```ts
const form = useForm<CreateExpenseRequest>({
  resolver: zodResolver(CreateExpenseRequest),
  defaultValues: draftStore.get('expense') ?? defaults,
  mode: 'onBlur',
});
useAutosaveDraft(form, 'expense', 3000);     // persists to MMKV every 3s
```

Rules: one schema per request type; `.strict()` everywhere so unknown fields are rejected; field errors rendered by the shared `FormField` component with accessible announcements; money fields use `AmountInput`, which emits `Paise` and never a float.

## 6.5 Caching

Three tiers, each with a distinct job:

| Tier | Technology | TTL | Purpose |
|---|---|---|---|
| L1 in-memory | TanStack Query | per-query staleTime | Instant re-render, dedupe |
| L2 on-device | SQLite (+ MMKV for KV) | until evicted | Offline reads, cold start without network |
| L3 server | Redis | 30 s – 24 h | Hot aggregates, permission lookups, rate limits |

Server-side Redis caching is applied narrowly: society settings (`24h`, invalidated on write), permission/membership lookups (`5m`), outstanding summaries (`60s`), and presigned-URL memoisation. **Never cache per-member balances in Redis** — they must be read transactionally.

Eviction on device: expenses older than 18 months, notifications older than 90 days, visitor logs older than 90 days, image cache capped at 200 MB LRU and clearable from Settings.

## 6.6 Offline Queue

The outbox is a SQLite table, not an in-memory array, because it must survive process death. Full design in §12. From a state-management perspective the contract is:

- Every mutation writes to SQLite and the outbox **before** the network call.
- `opId` is generated client-side and doubles as the HTTP `Idempotency-Key`, so a retry after a lost response can never double-post.
- `useSyncStore` exposes `{ pendingCount, failedCount, isOnline, lastSyncAt }`, which drives the offline banner and per-row "Pending sync" chips.
- The UI never blocks on the queue. Failure surfaces as a chip and a Sync Status sheet, not a modal.

## 6.7 Error Handling

Four categories, four treatments:

| Category | Example | Treatment |
|---|---|---|
| **Network** | Timeout, no connectivity | Silent if cached data exists; offline banner; auto-retry on reconnect |
| **Validation (422)** | Percentages ≠ 100% | Map `error.field` onto the RHF field; announce to screen reader; never a toast |
| **Authorisation (401/403)** | Expired token / wrong role | 401 → silent refresh, replay once, then logout. 403 → Permission Denied screen + Sentry breadcrumb (it means the UI showed something it should not have) |
| **Conflict (409)** | Stale version | Sync Conflict sheet with a field-level diff and Keep mine / Keep theirs / Merge |
| **Server (5xx)** | Unexpected | Generic error state with Retry; full context to Sentry with the `requestId` |

```ts
// lib/api/errors.ts
export class ApiError extends Error {
  constructor(readonly code: ErrorCode, readonly status: number,
              readonly field?: string, readonly requestId?: string) { super(code); }
  get isRetryable() { return this.status >= 500 || this.status === 429; }
  get isAuthFailure() { return this.status === 401; }
}
```

Error boundaries: one per tab plus a root boundary that reports to Sentry and offers "Reload app". A crash in the Reports tab must not take down a payment in progress.

---

# 7. API Design Standards

## 7.1 REST Conventions

- Resources are plural nouns: `/expenses`, `/members`, `/cycles`.
- Nesting is at most one level deep and only for genuine containment: `/societies/:id/expenses`. Beyond that, use query filters: `/expenses?cycleId=…`, not `/societies/:sid/cycles/:cid/expenses`.
- Non-CRUD operations are sub-resource verbs in the imperative: `POST /expenses/:id/publish`, `POST /payments/:id/verify`, `POST /cycles/:id/close`. These are state transitions, not RPC creep — each maps to exactly one use case.
- `PUT` replaces a whole resource (`PUT /societies/:id/settings`); `PATCH` applies a partial update. Never use `PUT` for partial updates.
- `DELETE` performs a soft delete where history matters and returns `204`. Financial records have no `DELETE` — they have `POST /:id/void`.
- All paths kebab-case, all JSON camelCase, all database columns snake_case. The mapper layer is the only place the translation happens.

## 7.2 Status Codes

| Code | Used for | Never used for |
|---|---|---|
| 200 | Successful GET, PATCH, PUT, or a POST that transitions state | Creating a new resource |
| 201 | Resource created; `Location` header set | |
| 202 | Accepted for async processing (report export, cycle publish for > 500 flats); returns `{ jobId }` | |
| 204 | Successful DELETE or an action with no body | |
| 400 | Malformed request (bad JSON, bad UUID) | Business-rule failures |
| 401 | Missing, expired or invalid token | Insufficient permissions |
| 402 | `PLAN_LIMIT_EXCEEDED` or `PAYMENT_FAILED` | |
| 403 | Authenticated but not permitted | Resource not found in your tenant |
| 404 | Not found **or not in your society** (deliberately indistinguishable — see §13) | |
| 409 | Version conflict, duplicate join code, concurrent cycle publish | Validation errors |
| 422 | Semantic validation failure (percentages ≠ 100, split ≠ total) | Syntax errors |
| 429 | Rate limit exceeded; `Retry-After` header mandatory | |
| 500 | Unhandled; never leaks internals | Anything the client could have prevented |
| 503 | Maintenance mode or dependency outage; `Retry-After` set | |

**Deliberate rule:** cross-tenant access returns `404`, not `403`. Returning `403` confirms the resource exists, which leaks the existence of other societies' data.

## 7.3 Versioning

URL-based: `/v1/…`. Chosen over header-based negotiation because mobile clients live in the wild for years and a version visible in logs, dashboards and support tickets is worth more than REST purity.

- **Additive changes** (new optional field, new endpoint) ship in `/v1` without a bump. Clients must ignore unknown fields — this is asserted in a client contract test.
- **Breaking changes** create `/v2` with at least 6 months of parallel operation.
- `GET /config` returns `{ minSupportedVersion, latestVersion, forceUpdate }`. Clients below `minSupportedVersion` receive `426 Upgrade Required` on every call and show the Force Update screen.
- The OpenAPI spec is committed at `docs/api/OPENAPI.yaml`; CI diffs every PR against `main` and **fails on a breaking change** unless the PR carries the `breaking-change-approved` label.

## 7.4 Pagination

**Cursor-based by default.** Offset pagination is banned on any endpoint over a growing table: offsets produce duplicates and gaps when rows are inserted mid-scroll, and `OFFSET 10000` is a sequential scan.

```
GET /v1/expenses?limit=20&cursor=eyJpZCI6IjBmMy4uLiIsImRhdGUiOiIyMDI2LTA5LTEyIn0
```

The cursor is base64 of the sort tuple (`{ expenseDate, id }`), making it stable against insertion. `total` is returned only when cheap (from a cached count) and is explicitly optional — clients must render correctly without it.

```json
{
  "data": [ /* … */ ],
  "meta": { "nextCursor": "eyJ…", "hasMore": true, "total": 248, "requestId": "req_9k2" }
}
```

Limits: default 20, max 100, max 500 for `/sync/changes`. Exceeding the max clamps silently rather than erroring.

## 7.5 Filtering, Sorting, Searching

**Filtering** — explicit named parameters, never a generic query DSL from the client (that is how you get SQL injection and unindexed scans):

```
GET /v1/expenses
  ?categoryId=uuid          &status=published
  &dateFrom=2026-04-01      &dateTo=2026-06-30
  &amountPaiseMin=500000    &amountPaiseMax=5000000
  &buildingId=uuid          &createdBy=uuid
  &hasAttachments=true      &cycleId=uuid
```

Every filter parameter is declared in a Zod schema, and **every filterable field must have a supporting index**. A CI check cross-references the filter schema against `pg_indexes` and fails if a filter has no index.

**Sorting** — `?sort=-expenseDate,title` (prefix `-` for descending). The allowlist per endpoint is explicit; an unknown sort field returns `422` rather than being ignored, so a client bug surfaces loudly.

**Searching** — `?q=plumber` runs against a GIN `tsvector` index over title, description and vendor for expenses; `pg_trgm` similarity for member and vendor name lookup. Search is always combined with the tenant filter at the SQL level, never applied after fetching.

## 7.6 Rate Limiting

Token bucket in Redis, keyed by the most specific available identity. Headers on every response:

```
X-RateLimit-Limit: 120
X-RateLimit-Remaining: 117
X-RateLimit-Reset: 1758264000
Retry-After: 30          (only on 429)
```

| Scope | Limit |
|---|---|
| Per IP (unauthenticated) | 60 req/min |
| Per user | 120 req/min |
| Per society (aggregate) | 600 req/min |
| `POST /auth/otp/request` | 3/hour/number, 10/day/number, 20/day/IP |
| `POST /auth/login` | 5 failures / 15 min / identity, then exponential lockout |
| `/ai/*` | 20/day free, 200/day paid, 5/min burst |
| `POST /reports/export` | 10/hour/society |
| `POST /sync/batch` | 60/min/user, ≤ 200 ops/request |
| Webhooks | Exempt from user limits; separately limited per source IP |

## 7.7 Idempotency

Mandatory on every POST that moves money or creates a billing artefact: `/payments/intent`, `/payments/verify`, `/payments/offline`, `/expenses`, `/expenses/:id/publish`, `/cycles/:id/publish`, `/sync/batch`.

```
Idempotency-Key: 6f1c2a4e-8b3d-4f21-9c77-2ab5e1d09f84
```

Implementation: a Redis entry `idem:{userId}:{key}` written at request start with status `in_progress`, plus a Postgres `idempotency_records` row for durability.

1. Key unseen → process, store the serialised response with a 24-hour TTL, return it.
2. Key seen and **complete** → return the stored response verbatim with `Idempotency-Replayed: true`. Do not re-execute.
3. Key seen and **in progress** → `409 CONFLICT` with `Retry-After: 2`.
4. Key reused with a **different request body hash** → `422 IDEMPOTENCY_KEY_REUSE`.

The mobile outbox's `opId` *is* the idempotency key, which is what makes offline retries safe by construction.

## 7.8 Validation

Three-stage, each with a distinct failure mode:

1. **Syntactic** — Zod at the pipe, from `packages/contracts`, `.strict()` so unknown fields are rejected rather than silently dropped. Failure → `400`.
2. **Semantic** — cross-field rules (percentages total 100, `dateTo >= dateFrom`, CGST+SGST xor IGST). Expressed as Zod `.superRefine()` in the same shared schema, so the client catches them before a round trip. Failure → `422`.
3. **Domain** — invariants requiring database state (split total equals amount, member has no unsettled dues, cycle not already published). Enforced inside entities and use cases. Failure → `422` or `409`.

## 7.9 Response Format

```json
{
  "data": { "id": "exp-77", "amountPaise": 4500000 },
  "meta": { "requestId": "req_9k2x", "timestamp": "2026-09-19T06:31:44.812Z" }
}
```

Rules: `data` is always present on success and is an object or array, never a bare scalar (so fields can be added later without a breaking change). Money is always `*Paise` as an integer. Timestamps are ISO-8601 UTC with milliseconds. Dates without a time are `YYYY-MM-DD`. Nulls are explicit; fields are never omitted to mean null.

## 7.10 Error Format

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Split percentages must total 100%",
    "field": "splitConfig.percentages",
    "details": [
      { "field": "splitConfig.percentages[2]", "code": "OUT_OF_RANGE",
        "message": "Percentage must be between 0 and 100", "received": 105 }
    ],
    "requestId": "req_9k2x",
    "timestamp": "2026-09-19T06:31:44.812Z",
    "docs": "https://docs.societysplit.in/errors/VALIDATION_ERROR"
  }
}
```

- `code` is a stable machine-readable enum. Clients branch on `code`, never on `message`.
- `message` is human-readable, safe to display, and **already localised** when the request carries `Accept-Language`.
- `details` is present only for multi-field validation failures.
- `requestId` correlates to logs, traces and the audit trail. Support asks for this string.

### Error code catalogue

```
UNAUTHENTICATED · TOKEN_EXPIRED · TOKEN_REUSED · FORBIDDEN · NOT_FOUND
VALIDATION_ERROR · CONFLICT · VERSION_MISMATCH · DUPLICATE_RESOURCE
IDEMPOTENCY_KEY_REUSE · RATE_LIMITED · PLAN_LIMIT_EXCEEDED
PAYMENT_FAILED · PAYMENT_ALREADY_VERIFIED · SIGNATURE_INVALID
SPLIT_MISMATCH · INVALID_TRANSITION · UNSETTLED_DUES · CYCLE_ALREADY_PUBLISHED
SOCIETY_ADMIN_REQUIRED · MEMBER_INACTIVE · UPGRADE_REQUIRED
DEPENDENCY_UNAVAILABLE · INTERNAL
```

## 7.11 Worked Examples

**Create an expense**
```http
POST /v1/expenses HTTP/1.1
Authorization: Bearer eyJhbGciOiJSUzI1NiIs…
X-Society-Id: b1f0c8e2-4a7d-4f1e-9b23-6c5d8e9f0a12
Idempotency-Key: 6f1c2a4e-8b3d-4f21-9c77-2ab5e1d09f84
X-Request-Id: 9c1e7a3b-2d44-4f81-b0e6-1a2c3d4e5f60
X-Client-Version: 1.4.2
Content-Type: application/json

{
  "title": "Overhead tank cleaning",
  "amountPaise": 1250000,
  "expenseDate": "2026-09-18",
  "categoryId": "4b2c…",
  "splitStrategy": "apartment",
  "apartmentBasis": "per_flat",
  "participantSelector": { "scope": "society", "includeVacant": true },
  "status": "published"
}
```
```http
HTTP/1.1 201 Created
Location: /v1/expenses/8e3f1b22-…
X-RateLimit-Remaining: 117

{
  "data": {
    "id": "8e3f1b22-…",
    "status": "published",
    "amountPaise": 1250000,
    "version": 1,
    "splitSummary": { "participantCount": 64, "perParticipantPaise": 19531,
                      "residualPaise": 0 },
    "duesCreated": 64,
    "publishedAt": "2026-09-19T06:31:44.812Z"
  },
  "meta": { "requestId": "9c1e7a3b-…", "timestamp": "2026-09-19T06:31:44.812Z" }
}
```

**Version conflict**
```http
HTTP/1.1 409 Conflict

{
  "error": {
    "code": "VERSION_MISMATCH",
    "message": "This expense was changed by Ramesh I. 40 seconds ago.",
    "details": [{ "field": "expectedVersion", "code": "STALE",
                  "received": 1, "current": 3 }],
    "requestId": "9c1e7a3b-…"
  }
}
```

**Plan limit**
```http
HTTP/1.1 402 Payment Required

{
  "error": {
    "code": "PLAN_LIMIT_EXCEEDED",
    "message": "The Free plan covers 25 apartments. This society has 26.",
    "details": [{ "field": "unitCount", "code": "LIMIT", "received": 26, "limit": 25 }],
    "requestId": "…"
  }
}
```

**Rate limited**
```http
HTTP/1.1 429 Too Many Requests
Retry-After: 47

{ "error": { "code": "RATE_LIMITED", "message": "Too many OTP requests. Try again in 47 seconds.",
             "requestId": "…" } }
```

---

# 8. Database Design

## 8.1 Conventions Applied to Every Table

```sql
-- Standard column set, applied via a Drizzle helper
id          uuid PRIMARY KEY DEFAULT gen_random_uuid()
society_id  uuid NOT NULL REFERENCES societies(id) ON DELETE CASCADE   -- tenant tables
created_at  timestamptz NOT NULL DEFAULT now()
updated_at  timestamptz NOT NULL DEFAULT now()                          -- trigger-maintained
created_by  uuid REFERENCES members(id)
updated_by  uuid REFERENCES members(id)
deleted_at  timestamptz                                                 -- soft delete
deleted_by  uuid REFERENCES members(id)
version     integer NOT NULL DEFAULT 1                                  -- optimistic locking
```

```ts
// packages/db-schema/src/shared/columns.ts
export const auditColumns = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by').references(() => members.id),
  updatedBy: uuid('updated_by').references(() => members.id),
};
export const softDeleteColumns = {
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: uuid('deleted_by').references(() => members.id),
};
export const tenantColumn = {
  societyId: uuid('society_id').notNull().references(() => societies.id, { onDelete: 'cascade' }),
};
```

**Soft-delete policy** — three tiers, chosen per table:

| Tier | Tables | Behaviour |
|---|---|---|
| **Soft delete** | societies, buildings, apartments, members, announcements, expense_categories | `deleted_at` set; every query filters `WHERE deleted_at IS NULL` via a Drizzle base query helper; partial indexes include the predicate |
| **Never deleted — voided instead** | expenses, dues, payments, receipts, maintenance_cycles | A status transition to `void`/`written_off`. `DELETE` is revoked from the application role at the grant level |
| **Append-only** | audit_logs, complaint_events, expense_revisions, payment_allocations | `UPDATE` and `DELETE` both revoked |

```sql
REVOKE DELETE, UPDATE ON audit_logs, complaint_events, expense_revisions FROM app_role;
REVOKE DELETE ON expenses, dues, payments, receipts FROM app_role;
```

**`updated_at` trigger** applied uniformly:
```sql
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); NEW.version = OLD.version + 1; RETURN NEW; END;
$$ LANGUAGE plpgsql;
-- attached to every table carrying updated_at
```

**Index conventions**
- Every tenant-table index begins with `society_id`.
- Every FK column is indexed (Postgres does not do this automatically, and unindexed FKs make cascading deletes catastrophically slow).
- Partial indexes for the hot filtered paths: `WHERE deleted_at IS NULL`, `WHERE status IN ('pending','partial','overdue')`.
- Naming: `idx_{table}_{cols}`, `uq_{table}_{cols}`, `fk_{table}_{ref}`, `chk_{table}_{rule}`.

## 8.2 ER Diagram — Identity & Structure

```mermaid
erDiagram
    users ||--o{ auth_identities : "links"
    users ||--o{ devices : "registers"
    users ||--o{ members : "is member via"
    societies ||--|| society_settings : "configures"
    societies ||--o{ buildings : "contains"
    buildings ||--o{ wings : "contains"
    buildings ||--o{ apartments : "contains"
    wings ||--o{ apartments : "groups"
    societies ||--o{ apartments : "owns"
    apartments ||--o{ members : "occupied by"
    apartments ||--o{ family_members : "houses"
    societies ||--o{ invitations : "issues"
    members ||--o{ invitations : "invited by"

    users {
        uuid id PK
        citext email UK "nullable"
        varchar phone UK "E.164, nullable"
        text password_hash "null for OAuth"
        user_status status
        timestamptz deleted_at
    }
    societies {
        uuid id PK
        varchar name
        varchar slug UK
        varchar join_code UK
        subscription_plan plan
        uuid created_by FK
        timestamptz deleted_at
    }
    buildings {
        uuid id PK
        uuid society_id FK
        varchar name "UK with society_id"
        smallint total_floors
    }
    apartments {
        uuid id PK
        uuid society_id FK
        uuid building_id FK
        uuid wing_id FK "nullable"
        varchar apartment_number "UK with building_id"
        smallint floor
        numeric carpet_area_sqft
        numeric share_units
        occupancy_status occupancy_status
        boolean is_billable
    }
    members {
        uuid id PK
        uuid society_id FK
        uuid user_id FK "null = shadow member"
        uuid apartment_id FK
        member_role role
        member_status status
        occupancy_type occupancy
        boolean is_primary
        date lease_end
    }
```

## 8.3 ER Diagram — Financial Core

```mermaid
erDiagram
    expense_categories ||--o{ expenses : "classifies"
    expenses ||--o{ expense_splits : "divides into"
    expenses ||--|| expense_gst_details : "may have"
    expenses ||--o{ expense_revisions : "versioned by"
    expense_splits ||--|| dues : "creates"
    members ||--o{ dues : "owes"
    members ||--o{ payments : "makes"
    payments ||--o{ payment_allocations : "allocated via"
    dues ||--o{ payment_allocations : "settled by"
    payments ||--|| receipts : "issues"
    members ||--|| member_balances : "summarised in"
    maintenance_cycles ||--o{ cycle_charges : "materialises"
    charge_heads ||--o{ cycle_charges : "priced by"
    maintenance_cycles ||--o{ expenses : "generates"
    apartments ||--o{ meter_readings : "metered by"

    expenses {
        uuid id PK
        uuid society_id FK
        uuid category_id FK
        uuid cycle_id FK "nullable"
        bigint amount_paise "CHECK > 0"
        date expense_date
        split_strategy split_strategy
        jsonb split_config
        jsonb participant_selector
        expense_status status
        integer version "optimistic lock"
    }
    expense_splits {
        uuid id PK
        uuid expense_id FK
        uuid member_id FK
        uuid apartment_id FK
        bigint amount_paise "CHECK >= 0"
        numeric weight
        jsonb snapshot "name+flat at publish"
    }
    dues {
        uuid id PK
        uuid member_id FK
        uuid expense_id FK
        uuid split_id FK
        varchar kind "principal|late_fee|adjustment"
        bigint amount_paise
        bigint paid_paise "CHECK <= amount"
        due_status status
        date due_date
    }
    payments {
        uuid id PK
        uuid member_id FK
        bigint amount_paise "CHECK > 0"
        payment_method method
        payment_status status
        varchar razorpay_payment_id UK
        varchar idempotency_key UK
        uuid verified_by FK
    }
    payment_allocations {
        uuid id PK
        uuid payment_id FK
        uuid due_id FK
        bigint amount_paise "UK payment+due"
    }
    receipts {
        uuid id PK
        uuid payment_id FK UK
        varchar receipt_number "UK with society"
        varchar financial_year
    }
    member_balances {
        uuid member_id PK
        bigint outstanding_paise
        bigint advance_paise
        date oldest_due_date
    }
```

## 8.4 ER Diagram — Community & System

```mermaid
erDiagram
    societies ||--o{ announcements : "publishes"
    announcements ||--o{ announcement_reads : "tracked by"
    societies ||--o{ complaints : "receives"
    complaints ||--o{ complaint_events : "timeline"
    members ||--o{ complaints : "raises"
    members ||--o{ complaints : "assigned"
    societies ||--o{ visitors : "logs"
    apartments ||--o{ visitors : "visited"
    users ||--o{ notifications : "receives"
    societies ||--o{ audit_logs : "records"
    societies ||--o{ subscriptions : "subscribes"
    societies ||--o{ ai_suggestions : "generates"
    societies ||--o{ attachments : "stores"

    complaints {
        uuid id PK
        uuid society_id FK
        uuid raised_by FK
        uuid assigned_to FK
        complaint_status status
        priority_level priority
        timestamptz sla_resolve_by
        uuid linked_expense_id FK
        smallint rating
    }
    visitors {
        uuid id PK
        uuid society_id FK
        uuid apartment_id FK
        visitor_type visitor_type
        visitor_status status
        varchar gate_pin
        timestamptz entry_at
        timestamptz exit_at
    }
    audit_logs {
        bigserial id PK
        uuid society_id FK
        uuid actor_user_id FK
        varchar action
        jsonb before
        jsonb after
        uuid request_id
        timestamptz created_at "partition key"
    }
    attachments {
        uuid id PK
        uuid society_id FK
        varchar entity_type "polymorphic"
        uuid entity_id
        text storage_key
        varchar checksum
        varchar scan_status
    }
```

## 8.5 Table Catalogue

Full DDL lives in the PRD §7 and in `packages/db-schema`. What follows is the implementation-level index and constraint plan an agent must apply.

| Table | Key indexes | Critical constraints |
|---|---|---|
| `users` | `uq(phone) WHERE deleted_at IS NULL`, `uq(email)…` | `CHECK (email IS NOT NULL OR phone IS NOT NULL)` |
| `societies` | `uq(slug)`, `uq(join_code)`, `idx(city) WHERE deleted_at IS NULL` | — |
| `buildings` | `idx(society_id)`, `uq(society_id, name)` | — |
| `apartments` | `idx(society_id) WHERE deleted_at IS NULL`, `idx(building_id, floor)`, `uq(society_id, building_id, apartment_number)` | `CHECK (carpet_area_sqft > 0)` |
| `members` | `idx(society_id, status)`, `idx(apartment_id)`, `idx(user_id)`, `uq(society_id, user_id)`, `uq(apartment_id, occupancy) WHERE is_primary AND status='active'` | Trigger: society must retain ≥ 1 active admin |
| `expenses` | `idx(society_id, expense_date DESC)`, `idx(society_id, status)`, `idx(category_id)`, `idx(cycle_id)`, GIN `tsvector(title, description, vendor)` | `CHECK (amount_paise > 0)`, deferred trigger `SUM(splits) = amount` when published |
| `expense_splits` | `idx(expense_id)`, `idx(member_id)`, `uq(expense_id, member_id, apartment_id)` | `CHECK (amount_paise >= 0)` |
| `dues` | `idx(member_id, status)`, `idx(society_id, due_date)`, partial `idx(society_id, status) WHERE status IN ('pending','partial','overdue')` | `CHECK (paid_paise BETWEEN 0 AND amount_paise)` |
| `payments` | `idx(member_id, created_at DESC)`, `idx(society_id, status)`, `uq(razorpay_payment_id)`, `uq(idempotency_key)` | `CHECK (amount_paise > 0)` |
| `payment_allocations` | `uq(payment_id, due_id)`, `idx(due_id)` | Trigger: `SUM ≤ payments.amount_paise` |
| `receipts` | `uq(society_id, receipt_number)`, `uq(payment_id)` | Number from a per-society-per-FY sequence |
| `maintenance_cycles` | `uq(society_id, period_start)` | `CHECK (period_end > period_start)` |
| `cycle_charges` | `uq(cycle_id, apartment_id, charge_head_id)` | — |
| `complaints` | `idx(society_id, status)`, `idx(assigned_to, status)`, `idx(society_id, sla_resolve_by) WHERE status NOT IN ('resolved','closed')` | `CHECK (rating BETWEEN 1 AND 5)` |
| `visitors` | `idx(society_id, created_at DESC)`, `idx(apartment_id, status)` | — |
| `notifications` | `idx(user_id, is_read, created_at DESC)` | Partitioned monthly at scale |
| `audit_logs` | `idx(society_id, created_at DESC)`, `idx(entity_type, entity_id)` | Append-only grants; partitioned monthly |
| `attachments` | `idx(entity_type, entity_id)`, `idx(society_id)` | `CHECK (size_bytes <= 10485760)` |

## 8.6 Database-Enforced Money Invariants

These are the constraints that make a wrong bill *impossible* rather than merely unlikely. Implement all four.

```sql
-- 1. A published expense's splits must sum exactly to its amount.
CREATE OR REPLACE FUNCTION chk_split_total() RETURNS trigger AS $$
DECLARE total bigint; expected bigint; st expense_status;
BEGIN
  SELECT amount_paise, status INTO expected, st FROM expenses WHERE id = NEW.expense_id;
  IF st <> 'published' THEN RETURN NEW; END IF;
  SELECT COALESCE(SUM(amount_paise),0) INTO total FROM expense_splits WHERE expense_id = NEW.expense_id;
  IF total <> expected THEN
    RAISE EXCEPTION 'SPLIT_MISMATCH: expense % splits total % expected %',
      NEW.expense_id, total, expected;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_split_total
  AFTER INSERT OR UPDATE OR DELETE ON expense_splits
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION chk_split_total();

-- 2. Allocations may never exceed the payment.
CREATE OR REPLACE FUNCTION chk_allocation_total() RETURNS trigger AS $$
DECLARE allocated bigint; paid bigint;
BEGIN
  SELECT amount_paise INTO paid FROM payments WHERE id = NEW.payment_id;
  SELECT COALESCE(SUM(amount_paise),0) INTO allocated
    FROM payment_allocations WHERE payment_id = NEW.payment_id;
  IF allocated > paid THEN
    RAISE EXCEPTION 'OVER_ALLOCATION: payment % allocated % of %', NEW.payment_id, allocated, paid;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

-- 3. dues.paid_paise must equal the sum of verified allocations.
--    Maintained by trigger on payment_allocations; verified nightly by the
--    reconciliation job which recomputes from source and alerts on drift.

-- 4. A society must always have at least one active admin.
CREATE OR REPLACE FUNCTION chk_admin_present() RETURNS trigger AS $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM members
   WHERE society_id = OLD.society_id AND role = 'admin' AND status = 'active';
  IF n = 0 THEN RAISE EXCEPTION 'SOCIETY_ADMIN_REQUIRED'; END IF;
  RETURN NULL;
END; $$ LANGUAGE plpgsql;
```

## 8.7 Row Level Security Pattern

Applied to every tenant table without exception. The application connects as `app_role`, which has `NOBYPASSRLS`.

```sql
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses FORCE ROW LEVEL SECURITY;

CREATE POLICY expenses_tenant_read ON expenses FOR SELECT TO app_role
USING (
  society_id IN (
    SELECT society_id FROM members
     WHERE user_id = current_setting('app.user_id', true)::uuid
       AND status = 'active'
  )
);

CREATE POLICY expenses_tenant_write ON expenses FOR INSERT TO app_role
WITH CHECK (
  society_id IN (
    SELECT society_id FROM members
     WHERE user_id = current_setting('app.user_id', true)::uuid
       AND status = 'active' AND role IN ('admin','treasurer','committee')
  )
);

-- Security (gate) accounts are denied all financial tables outright.
CREATE POLICY expenses_deny_security ON expenses FOR ALL TO app_role
USING (NOT EXISTS (
  SELECT 1 FROM members
   WHERE user_id = current_setting('app.user_id', true)::uuid
     AND society_id = expenses.society_id AND role = 'guest'
));
```

`app.user_id` is set per transaction by the Unit of Work from the request context (`SET LOCAL app.user_id = $1`). Using `SET LOCAL` means the value is transaction-scoped and cannot leak across pooled connections.

## 8.8 Migration Strategy

Forward-only, expand→migrate→contract, reviewed separately from feature code.

1. **Expand** — add the new nullable column or table. Deploy. Old and new app versions both work.
2. **Migrate** — backfill in batches (never a single `UPDATE` over millions of rows; use a batched job with `LIMIT 5000` and a sleep).
3. **Contract** — once every client is on the new version (verified via `X-Client-Version` telemetry), add `NOT NULL`, drop the old column.

Rules: a migration must be safe against the previous app version still running; no `ALTER TABLE … ADD COLUMN … DEFAULT` on a large table without `NOT NULL` plus a fast default (Postgres 11+ makes this safe, but verify); index creation is always `CONCURRENTLY` in production; every migration ships with a tested `down`.

---

# 9. Authentication & Authorization

## 9.1 Token Architecture

```mermaid
sequenceDiagram
    participant M as Mobile
    participant SA as Supabase Auth
    participant API as NestJS API
    participant R as Redis
    participant DB as Postgres

    M->>SA: signInWithOtp(phone)
    SA-->>M: access_token (JWT, 60m) + refresh_token (opaque, 60d)
    M->>M: store both in SecureStore
    M->>API: GET /auth/me (Bearer access_token)
    API->>SA: fetch JWKS (cached 24h)
    API->>API: verify RS256, aud, iss, exp
    API->>R: check jti denylist
    API->>DB: load memberships for sub
    API-->>M: user + memberships + permissions

    Note over M,API: 60 minutes later
    M->>API: any request → 401 TOKEN_EXPIRED
    M->>SA: refresh(refresh_token)
    SA-->>M: new access + ROTATED refresh
    M->>API: replay original request once
```

**Access token** — Supabase-issued JWT, RS256, 60-minute TTL. Claims used: `sub` (user id), `exp`, `iat`, `jti`, `role`. The API **never** trusts society or role claims from the token — those come from the `members` table on every request, because a role can be revoked mid-session and a token cannot be un-issued.

**Refresh token** — opaque, 60-day sliding expiry, **rotated on every use**. Rotation with reuse detection: each refresh token belongs to a family; presenting an already-consumed token means it was stolen, so the entire family is revoked, all sessions are killed, and the user is notified on every channel.

**JWKS caching:** fetched once and cached 24 hours with a background refresh; a `kid` miss triggers an immediate refetch (handles key rotation without downtime).

## 9.2 Session Handling

```ts
// lib/api/interceptors.ts
let refreshPromise: Promise<Session> | null = null;

async function onResponse(res: Response, req: Request): Promise<Response> {
  if (res.status !== 401) return res;
  if (req.headers.get('X-Retry') === '1') { await logout('token_refresh_failed'); throw new ApiError('UNAUTHENTICATED', 401); }

  // single-flight: 12 concurrent 401s trigger exactly one refresh
  refreshPromise ??= refreshSession().finally(() => { refreshPromise = null; });
  const session = await refreshPromise;

  return fetch(withAuth(req, session.accessToken, { 'X-Retry': '1' }));
}
```

Single-flight refresh is not optional. A dashboard fires eight parallel queries; without it, eight simultaneous refreshes race, seven rotate tokens that the eighth then presents as reused, and reuse detection logs the user out. This bug is subtle and common — implement the mutex.

**Foreground revalidation:** on `AppState` change to active, if the token expires within 5 minutes, refresh pre-emptively so the user's first tap is never blocked.

**Forced logout paths:** password reset, role revocation, device removal, or a security event. Implemented via a `jti` denylist in Redis (TTL = remaining token lifetime) plus a `token_version` on the user row; tokens with a lower `ver` are rejected, which invalidates everything at once after a breach.

## 9.3 Role-Based Access Control

Permissions are **per-membership**, not per-user. One user may be Treasurer in society A and Resident in society B simultaneously, and the evaluation always requires a society context.

```ts
// packages/domain/src/member/permission-evaluator.ts
export type Action =
  | 'society.edit' | 'society.delete' | 'structure.edit'
  | 'member.invite' | 'member.approve' | 'member.role_change' | 'member.remove'
  | 'expense.create' | 'expense.publish' | 'expense.approve' | 'expense.void'
  | 'payment.record' | 'payment.verify' | 'payment.refund'
  | 'cycle.create' | 'cycle.publish' | 'reminder.send'
  | 'complaint.assign' | 'complaint.resolve'
  | 'notice.post' | 'notice.emergency'
  | 'visitor.log' | 'visitor.approve'
  | 'report.view_all' | 'report.export'
  | 'audit.view' | 'subscription.manage';

const MATRIX: Record<MemberRole, ReadonlySet<Action>> = { /* from PRD §2.1 */ };

export function can(role: MemberRole, action: Action): boolean {
  return MATRIX[role]?.has(action) ?? false;
}

// Ownership-scoped checks that the matrix alone cannot express
export function canOnResource(
  member: MemberSnapshot, action: Action, resource: ResourceSnapshot,
): boolean {
  if (!can(member.role, action)) return false;
  switch (action) {
    case 'expense.void':        return resource.status === 'published' || member.role === 'admin';
    case 'complaint.resolve':   return resource.assignedTo === member.id || member.role === 'admin';
    case 'expense.create':      return member.role !== 'committee' || resource.status === 'draft';
    default: return true;
  }
}
```

**This function is the single source of truth.** The API guard calls it, the mobile UI calls it, the RLS policies mirror it. A parameterised test iterates every `(role × action)` pair against the PRD matrix and fails the build on any divergence.

## 9.4 Guard Chain

Executed in strict order; each stage may only narrow access.

```mermaid
graph LR
    A["1. ThrottleGuard<br/>rate limits"] --> B["2. AuthGuard<br/>verify JWT, load user"]
    B --> C["3. SocietyGuard<br/>resolve X-Society-Id → membership"]
    C --> D["4. PermissionGuard<br/>can(role, action)"]
    D --> E["5. PlanGuard<br/>entitlement check"]
    E --> F["6. Handler<br/>+ resource-level check in use case"]
```

```ts
@Injectable()
export class SocietyGuard implements CanActivate {
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const societyId = req.headers['x-society-id'];
    if (!societyId) throw new BadRequestException('MISSING_SOCIETY_CONTEXT');

    // cached 5 min; invalidated on any membership write
    const membership = await this.members.findActiveMembership(req.user.id, societyId);
    if (!membership) throw new NotFoundException();     // 404, not 403 — see §7.2

    RequestContext.set({ user: req.user, member: membership, societyId });
    return true;
  }
}
```

`RequestContext` uses `AsyncLocalStorage`, so repositories and the audit service read the actor without threading it through every signature — while remaining request-isolated.

## 9.5 Permission Matrix (implementation view)

Condensed from PRD §2.1. `✅` full, `🟡` conditional (see `canOnResource`), `—` denied.

| Action | admin | treasurer | committee | resident | tenant | guest |
|---|---|---|---|---|---|---|
| `society.edit` / `structure.edit` | ✅ | — | — | — | — | — |
| `society.delete` | ✅ | — | — | — | — | — |
| `member.invite` / `member.approve` | ✅ | ✅ | — | — | — | — |
| `member.role_change` / `member.remove` | ✅ | — | — | — | — | — |
| `expense.create` | ✅ | ✅ | 🟡 draft | — | — | — |
| `expense.publish` | ✅ | ✅ | — | — | — | — |
| `expense.approve` | ✅ | — | — | — | — | — |
| `expense.void` | ✅ | ✅ | — | — | — | — |
| `expense.view` | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| `payment.record` / `verify` / `refund` | ✅ | ✅ | — | — | — | — |
| `payment.pay_own` | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| `cycle.create` / `cycle.publish` | ✅ | ✅ | — | — | — | — |
| `reminder.send` | ✅ | ✅ | — | — | — | — |
| `notice.post` / `notice.emergency` | ✅ | ✅ | ✅ | — | — | — |
| `complaint.create` | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| `complaint.assign` | ✅ | — | 🟡 self | — | — | — |
| `complaint.resolve` | ✅ | — | 🟡 assigned | 🟡 own | 🟡 own | — |
| `visitor.log` | ✅ | — | — | — | — | ✅ |
| `visitor.approve` | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| `report.view_all` | ✅ | ✅ | ✅ | 🟡 summary | 🟡 summary | — |
| `report.export` | ✅ | ✅ | — | — | — | — |
| `audit.view` | ✅ | 🟡 financial | — | — | — | — |
| `subscription.manage` | ✅ | — | — | — | — | — |

## 9.6 Device Management

```sql
devices(id, user_id, expo_push_token UK, platform, app_version, device_name,
        last_seen_at, created_at, revoked_at)
```

- Registered on login and refreshed on every foreground; `last_seen_at` drives an "active sessions" list in Settings.
- The user can revoke any device, which denylists its refresh-token family and deletes its push token.
- `DeviceNotRegistered` from Expo Push prunes the row automatically.
- Cap at 10 active devices per user; the oldest is evicted beyond that.
- A device registering from a new country or after a phone-number change triggers a notification on all other channels — cheap, effective account-takeover detection.

## 9.7 Password Reset

1. `POST /auth/password/forgot` → **always** `200` with a generic message. Never confirms whether the account exists.
2. Single-use token, 256-bit random, stored hashed, 60-minute TTL, bound to the user's current `token_version`.
3. `POST /auth/password/reset` → validate, Argon2id hash the new password, **increment `token_version`** (invalidating every session everywhere), notify by email and push.
4. Rate limited to 3 requests/hour/identity.
5. Phone-only accounts have no password; the endpoint returns the generic message and sends an SMS pointing to OTP sign-in instead.

## 9.8 MFA Readiness

Not in MVP, but the schema and flow must not preclude it:

- `users.mfa_enabled boolean`, `user_mfa_factors(id, user_id, type, secret_encrypted, verified_at, backup_codes_hash[])` — create the table now, empty.
- The auth response already carries a discriminated `{ status: 'authenticated' | 'mfa_required', challengeId? }`, so adding a step later is not a breaking change for clients written against the contract.
- TOTP first (Supabase Auth supports it natively), SMS OTP as a second factor second.
- Policy when shipped: **required** for `admin` and `treasurer` roles in societies above 100 units or on Enterprise; optional elsewhere. Step-up MFA for high-risk actions (admin transfer, bulk write-off, bank-detail change) even when not enabled globally.

---

# 10. File Upload Architecture

## 10.1 Flow

Bytes never pass through the API. The API issues a presigned URL; the device uploads directly.

```mermaid
sequenceDiagram
    participant M as Mobile
    participant A as API
    participant S as Storage
    participant Q as Queue
    participant W as Worker

    M->>M: capture → crop → compress (≤1600px, q0.7, <400KB)
    M->>M: compute SHA-256 checksum
    M->>A: POST /attachments/presign {entityType, entityId, mime, bytes, checksum}
    A->>A: validate: plan quota, mime allowlist, size cap
    A->>S: create presigned PUT (15 min, content-length-range enforced)
    A->>A: INSERT attachments (scan_status='pending')
    A-->>M: {attachmentId, uploadUrl, storageKey}
    M->>S: PUT bytes (with progress, resumable)
    M->>A: POST /attachments/:id/complete {checksum}
    A->>A: verify checksum + object HEAD (size, mime magic bytes)
    A->>Q: enqueue virus-scan, then OCR if it's a bill
    A-->>M: 200 {status: 'processing'}
    W->>S: fetch object
    W->>W: ClamAV scan → strip EXIF → generate thumbnail
    W->>A: mark scan_status='clean' | 'infected'
    W->>Q: if bill → enqueue OCR job
```

**Why presigned and not proxied:** a 10 MB upload through the API occupies a Node event loop for its duration, consumes bandwidth twice, and makes the API the bottleneck at cycle time when 60 treasurers upload bills at once. Presigned uploads scale with the storage provider, not with our compute.

**Offline behaviour:** the local file URI is recorded in the outbox alongside the op. On reconnect, the attachment uploads **before** the op that references it, and the op is held until the upload confirms. A failed upload keeps the whole op pending rather than creating a dangling reference.

## 10.2 Storage Abstraction

```ts
export interface IStorageProvider {
  presignUpload(input: PresignUploadInput): Promise<PresignedUpload>;
  presignDownload(key: string, ttlSeconds: number): Promise<string>;
  head(key: string): Promise<ObjectMetadata>;
  copy(from: string, to: string): Promise<void>;
  delete(key: string): Promise<void>;
}
```

Implementations: `SupabaseStorageProvider` (MVP), `R2StorageProvider` (scale), `S3StorageProvider` (enterprise residency). Bound by DI token; switching is an env var plus a bucket migration.

## 10.3 Key Layout

```
societies/{societyId}/
├── expenses/{expenseId}/{attachmentId}.{ext}
├── receipts/{financialYear}/{receiptNumber}.pdf
├── complaints/{complaintId}/{attachmentId}.{ext}
├── notices/{noticeId}/{attachmentId}.{ext}
├── visitors/{visitorId}/photo.jpg
├── meters/{readingId}/photo.jpg
└── reports/{jobId}/{reportType}-{period}.{pdf|csv}
users/{userId}/avatar.jpg
thumbnails/{originalKey}-{size}.webp
```

The society prefix is not decorative — it makes per-society lifecycle rules, quota accounting, export-on-request and delete-on-churn a prefix operation rather than a table scan.

## 10.4 Per-Type Rules

| Type | Max size | Formats | Processing |
|---|---|---|---|
| **Bills / receipts (expense)** | 10 MB | jpg, png, heic, pdf | Compress, EXIF strip, thumbnail, virus scan, **OCR** |
| **Payment proof** | 5 MB | jpg, png, pdf | Compress, EXIF strip, scan |
| **Profile photo** | 3 MB | jpg, png, heic | Square crop, 512px + 128px variants, EXIF strip |
| **Complaint photos** | 8 MB × 4 | jpg, png, heic | Compress, EXIF strip (**GPS removal is mandatory** — a complaint photo geotagged to a flat is a privacy leak), thumbnail |
| **Visitor photo** | 2 MB | jpg | Compress, 90-day retention, auto-purge |
| **Notice attachments** | 10 MB × 3 | jpg, png, pdf | Scan only |
| **Meter reading photo** | 3 MB | jpg | Compress, linked to reading for dispute resolution |
| **Generated reports** | — | pdf, csv | Server-generated, 90-day retention |

## 10.5 Compression Pipeline (client)

```ts
export async function prepareImage(uri: string): Promise<PreparedFile> {
  const { width, height } = await ImageManipulator.getInfo(uri);
  const scale = Math.min(1, 1600 / Math.max(width, height));

  const result = await ImageManipulator.manipulateAsync(
    uri,
    scale < 1 ? [{ resize: { width: Math.round(width * scale) } }] : [],
    { compress: 0.7, format: SaveFormat.JPEG },              // strips EXIF as a side effect
  );

  let out = result;
  if (await sizeOf(out.uri) > 400_000) {                      // second pass for dense scans
    out = await ImageManipulator.manipulateAsync(out.uri, [], { compress: 0.55, format: SaveFormat.JPEG });
  }
  return { uri: out.uri, checksum: await sha256(out.uri), bytes: await sizeOf(out.uri) };
}
```

HEIC is converted to JPEG on iOS before upload — OCR providers handle it inconsistently and it saves a server-side conversion.

## 10.6 OCR Pipeline

```mermaid
graph LR
    A["Upload complete"] --> B{"Cache hit?<br/>by SHA-256"}
    B -->|yes| Z["Return cached result"]
    B -->|no| C["ML Kit on-device<br/>fast text pass"]
    C --> D{"Confidence<br/>≥ 0.85?"}
    D -->|yes| E["Structured parse<br/>regex + heuristics"]
    D -->|no| F["Server vision model<br/>Claude / Gemini"]
    E --> G["Normalise fields"]
    F --> G
    G --> H["Write ai_suggestions<br/>with per-field confidence"]
    H --> I["Push to client:<br/>OCR Review screen"]
    I --> J{"User accepts?"}
    J -->|accept| K["Prefill expense form<br/>outcome='accepted'"]
    J -->|reject| L["outcome='rejected'<br/>training signal"]
```

Extracted fields: `amount`, `invoiceDate`, `vendorName`, `gstin`, `invoiceNumber`, `hsnSac`, `taxableValue`, `cgst`, `sgst`, `igst`, `lineItems[]`. Each carries an independent confidence score; the review screen highlights anything below 0.7 in amber and shows the original image beside the fields at all times. **No OCR result ever writes to the ledger without a tap.**

Cost control: results cached by image checksum indefinitely (`ai_suggestions.input_hash`), so re-uploading the same bill is free. The on-device pass handles clean printed invoices and avoids a model call entirely for roughly half of real uploads.

## 10.7 Virus Scanning

ClamAV in a sidecar container, invoked by the worker after upload completes.

- `attachments.scan_status`: `pending → clean | infected | failed`.
- Files with `scan_status != 'clean'` are **never** served — `presignDownload` refuses and the API returns `409 SCAN_PENDING` or `403 FILE_QUARANTINED`.
- Infected files are deleted from storage, the row is retained with the verdict, the uploader is notified, and a security alert fires.
- Scan failures (timeout, scanner down) retry 3× then mark `failed`; the file stays unserved and appears in an ops queue.
- PDFs additionally have JavaScript and embedded-file detection; a PDF with active content is rejected.

---

# 11. AI Architecture

## 11.1 Principles

1. **AI is advisory, never authoritative.** Every output lands in `ai_suggestions` and requires a human tap to affect anything. There is no code path from a model response to a ledger write.
2. **No module imports a provider SDK.** Everything goes through `ILLMGateway`.
3. **Minimise what leaves the system.** Names, phone numbers and flat identifiers are stripped before any external call unless the feature inherently requires them and the user initiated it.
4. **Every feature has a kill switch** and a per-society opt-out.
5. **Deterministic beats clever for numbers.** Forecasting uses statistical decomposition; the model only *explains* the result.

## 11.2 Layered Design

```mermaid
graph TB
    subgraph Features
        F1["Bill OCR"] 
        F2["Duplicate Detection"]
        F3["Anomaly Detection"]
        F4["Expense Categorisation"]
        F5["NL Search"]
        F6["Financial Insights"]
        F7["AI Assistant"]
    end
    subgraph AppLayer["Application Layer"]
        S["AISuggestionService<br/>logs · consent · quota"]
        PM["PromptRegistry<br/>versioned templates"]
        VAL["OutputValidator<br/>zod-parsed responses"]
    end
    subgraph Gateway["LLM Gateway"]
        G["ILLMGateway"]
        CA["Response cache<br/>Redis, by input hash"]
        RT["Router<br/>task → model tier"]
        FB["Fallback chain"]
        RL["Quota + cost meter"]
    end
    subgraph Providers
        P1["Anthropic Claude"]
        P2["Google Gemini"]
        P3["On-device ML Kit"]
        P4["Deterministic engines<br/>trigram · z-score · seasonal"]
    end

    F1 & F2 & F3 & F4 & F5 & F6 & F7 --> S
    S --> PM --> G
    S --> VAL
    G --> CA
    G --> RT --> FB
    FB --> P1 & P2 & P3
    F2 & F3 --> P4
```

## 11.3 LLM Gateway

```ts
export interface ILLMGateway {
  complete<T>(req: LLMRequest<T>): Promise<LLMResponse<T>>;
  vision<T>(req: VisionRequest<T>): Promise<LLMResponse<T>>;
}

export interface LLMRequest<T> {
  task: AITask;                    // 'ocr' | 'categorise' | 'nl_search' | 'insights' | 'assistant'
  promptId: string;                // e.g. 'nl_search.v3' — resolved from PromptRegistry
  variables: Record<string, unknown>;
  outputSchema: z.ZodType<T>;      // response MUST parse or the call fails
  tier: 'small' | 'large';
  maxTokens: number;
  cacheKey?: string;               // stable hash of semantic inputs
  societyId: SocietyId;            // for quota, cost attribution, consent
  timeoutMs?: number;              // default 15s; 45s for vision
}
```

Responsibilities, in order of execution: consent check → quota check → cache lookup → prompt resolution → provider routing → call with timeout → schema validation → repair attempt → cache write → cost metering → `ai_suggestions` row.

**Schema-validated output is non-negotiable.** Every prompt instructs JSON-only output; the response is parsed with the supplied Zod schema. A parse failure triggers exactly one repair attempt (re-prompt with the validation error), then falls back. Unvalidated model output never reaches application code.

## 11.4 Routing and Fallback

| Task | Primary | Fallback 1 | Fallback 2 | Degraded behaviour |
|---|---|---|---|---|
| OCR | On-device ML Kit | Claude vision | Gemini vision | Manual entry, form unchanged |
| Categorisation | Small model | Keyword rules table | — | Default category, user picks |
| Duplicate detection | **Deterministic** (trigram + amount + date + pHash) | — | — | Feature simply off |
| Anomaly detection | **Deterministic** (rolling z-score, percentile) | — | — | Feature simply off |
| Forecasting | **Deterministic** (seasonal-naive + trend) | — | — | Hidden until 6 cycles exist |
| NL Search | Small model → query DSL | — | — | Falls back to normal filter UI |
| Insights | Large model over aggregates | Small model | — | Card hidden |
| Assistant | Large model + retrieval | Small model | — | "Try again shortly" |

Fallback triggers: timeout, 5xx, rate limit, schema-validation failure after repair. Circuit breaker per provider — 5 failures in 60 seconds opens for 5 minutes, during which the fallback is primary. **Every fallback path degrades to a working non-AI experience.** Nothing in the product blocks on a model being available.

## 11.5 Prompt Management

Prompts are versioned assets, not string literals scattered through code.

```
apps/api/src/modules/ai/prompts/
├── registry.ts
├── ocr/            bill-extract.v1.md  bill-extract.v2.md
├── search/         nl-to-dsl.v3.md
├── insights/       monthly-digest.v2.md
├── assistant/      resident.v1.md  treasurer.v1.md
└── categorise/     expense-category.v1.md
```

Each prompt file carries frontmatter: `id`, `version`, `model tier`, `maxTokens`, `outputSchema` reference, and a golden test-case file. Changing a prompt means creating a new version, never editing in place — so a regression is a rollback, and `ai_suggestions.prompt_version` tells you exactly which prompt produced any historical output.

Every prompt is evaluated against a golden dataset in CI (`packages/ai-evals`): 30 real (anonymised) invoices for OCR, 50 labelled queries for NL search. A new prompt version must not regress accuracy below the previous version's baseline.

## 11.6 Natural Language Search — Constrained DSL

The model never writes SQL and never sees data it is not entitled to. It only translates to a filter object, which is then validated and executed by ordinary permission-checked repository code.

```ts
const SearchDSL = z.object({
  entity: z.enum(['expenses', 'payments', 'dues', 'complaints', 'members']),
  filters: z.object({
    categoryNames: z.array(z.string()).max(10).optional(),
    amountPaiseMin: z.number().int().nonnegative().optional(),
    amountPaiseMax: z.number().int().nonnegative().optional(),
    dateFrom: z.string().date().optional(),
    dateTo:   z.string().date().optional(),
    status:   z.array(z.string()).max(6).optional(),
    buildingNames: z.array(z.string()).max(20).optional(),
    vendorContains: z.string().max(60).optional(),
  }).strict(),
  sort: z.enum(['date_desc','date_asc','amount_desc','amount_asc']).default('date_desc'),
  limit: z.number().int().min(1).max(100).default(20),
}).strict();
```

Execution: parse → validate → **map category and building *names* to ids within the current society** (a name from another society simply finds nothing) → run through the same repository the UI uses, with the same RLS and guard chain. The interpreted filter is returned to the client and rendered as **editable chips**, so the user can see and correct what the AI understood.

## 11.7 Duplicate Detection (deterministic)

No model involved. Composite score computed on save:

```ts
score =
    0.35 * amountProximity     // 1.0 if within 0.5%, decaying to 0 at 5%
  + 0.25 * dateProximity       // 1.0 same day, 0 beyond 14 days
  + 0.25 * vendorSimilarity    // pg_trgm similarity on vendor_name
  + 0.15 * imageSimilarity;    // perceptual hash Hamming distance on the bill

if (score >= 0.75) warn(nonBlocking);
```

Indexed by a `pg_trgm` GIN index on `vendor_name` and a `bigint` pHash column, so the candidate query stays under 50 ms even with 50,000 expenses in a society.

## 11.8 Caching and Cost Control

| Layer | Key | TTL |
|---|---|---|
| OCR results | SHA-256 of the image bytes | Permanent (`ai_suggestions.input_hash`) |
| Categorisation | normalised `title + vendor` hash | 30 days |
| NL search DSL | normalised query string + society schema version | 7 days |
| Insights | `societyId + period` | Until the next cycle publishes |
| Assistant | Not cached (conversational) | — |

Cost controls: per-society monthly token budget by plan, enforced *before* the call; `tier: 'small'` for every classification task (categorisation, NL search, triage) and `'large'` only for generation (insights, assistant); `max_tokens` always set explicitly; prompt-caching headers used for the long system prompts in the assistant. A dashboard tracks cost per society per feature, and a budget breach disables the feature for that society with a clear in-app message rather than silently failing.

## 11.9 AI Assistant (Phase 3)

Retrieval-augmented, permission-scoped, read-only.

```mermaid
graph LR
    Q["User question"] --> P["Permission scope<br/>build allowed entity set"]
    P --> R["Retrieve<br/>structured queries + pgvector over notices/bylaws"]
    R --> C["Compose context<br/>redact PII, cap tokens"]
    C --> L["LLM with tool definitions<br/>read-only tools ONLY"]
    L --> V["Validate + cite<br/>every figure links to a record"]
    V --> A["Answer with source chips"]
```

Tool definitions exposed to the model are read-only by construction: `getMyDues`, `getExpense`, `searchExpenses`, `getNotice`, `getComplaintStatus`, `getCycleSummary`. There is no write tool. Even if the model attempted a mutation, none exists to call.

Hard boundaries encoded in the system prompt *and* enforced in code: no cross-society data, no legal or tax advice (hand off with a disclaimer), no individual member financial details unless the requester is the member or holds `report.view_all`, and every numeric claim must cite the record it came from or be omitted.

---

# 12. Offline Architecture

## 12.1 Model

```mermaid
graph TB
    UI["React components"] --> Q["TanStack Query"]
    Q --> SQL[("SQLite<br/>replica + outbox")]
    Q -.revalidate.-> NET["API"]
    UI --> MUT["Mutation"]
    MUT --> SQL
    MUT --> OB["Outbox table"]
    OB --> ENG["Sync Engine"]
    ENG -->|push| NET
    NET -->|pull deltas| ENG
    ENG --> SQL
    NET -.->|conflict| CR["Conflict Resolver"]
    CR --> UI
```

SQLite is the read path for **every** screen. The network only ever updates SQLite; components never read from a network response directly. This single rule is what makes the app work identically online and offline, and it must not be violated for "just this one screen".

## 12.2 Local Schema

Mirrors the server subset for the active society, plus two local-only tables:

```sql
CREATE TABLE outbox (
  op_id         TEXT PRIMARY KEY,          -- uuid, also the Idempotency-Key
  entity        TEXT NOT NULL,
  op            TEXT NOT NULL,             -- create | update | delete
  entity_id     TEXT,                      -- local_* temp id or server uuid
  base_version  INTEGER,
  payload       TEXT NOT NULL,             -- JSON
  attachments   TEXT,                      -- JSON array of local file URIs
  depends_on    TEXT,                      -- op_id this op must follow
  attempts      INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  last_error    TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending|sending|failed|conflict|applied
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_outbox_ready ON outbox(status, next_retry_at);

CREATE TABLE sync_meta (
  entity          TEXT PRIMARY KEY,
  last_synced_at  TEXT,
  last_cursor     TEXT
);
```

Encryption: SQLCipher with a 256-bit key generated on first launch and stored in `expo-secure-store`. The database is deleted entirely on logout.

## 12.3 Synchronisation

**Pull (delta), triggered on:** app foreground, network reconnect, push notification with `{ type: 'sync_hint' }`, and every 15 minutes while active.

```
GET /v1/sync/changes?since=<ISO>&entities=expenses,dues,payments,notices,complaints&limit=500
```

Applied in one SQLite transaction; the cursor advances only on full success. `truncated: true` loops immediately. A cursor older than 30 days triggers a full resync for that society (cheaper and safer than a very long delta).

**Push (outbox drain), triggered on:** any local mutation while online, reconnect, foreground.

```mermaid
graph TB
    S["Drain triggered"] --> A{"Online?"}
    A -->|no| Z["Wait for reconnect"]
    A -->|yes| B["SELECT ops WHERE status='pending'<br/>AND next_retry_at <= now<br/>ORDER BY created_at"]
    B --> C{"Has unuploaded<br/>attachments?"}
    C -->|yes| D["Upload attachments first"]
    D --> E{"Upload ok?"}
    E -->|no| R["Backoff, keep pending"]
    E -->|yes| F
    C -->|no| F["Batch ≤200 ops → POST /sync/batch"]
    F --> G{"Per-op result"}
    G -->|applied| H["Rewrite temp ids<br/>mark applied<br/>reconcile SQLite"]
    G -->|conflict| I["status='conflict'<br/>surface in Sync sheet"]
    G -->|error 5xx/429| J["attempts++<br/>exponential backoff + jitter"]
    G -->|error 4xx| K["status='failed'<br/>show reason, offer discard"]
```

**Ordering guarantees:**
- Ops are drained in `created_at` order, serially per entity.
- An op referencing a `local_*` id is held via `depends_on` until the creating op is confirmed and the id has been rewritten throughout the outbox and SQLite.
- Attachments upload before the op that references them.

**Backoff:** 2s → 8s → 30s → 2m → 10m → 1h, each with ±20% jitter (jitter prevents a thundering herd when a whole society reconnects after a power cut — a genuinely common scenario in this market). Max 8 attempts, then `failed` with manual retry available.

## 12.4 Conflict Resolution

Resolved **by entity class**. There is no single global strategy, because the correct answer differs by data type.

| Class | Entities | Strategy |
|---|---|---|
| **Financial** | expenses, dues, payments, cycles | **Server authority + optimistic version.** Client sends `baseVersion`; mismatch → `409` with server state → Conflict sheet with a field-level diff and Keep mine / Keep theirs / Merge. Never auto-resolved. |
| **User-owned content** | my complaint description, my comment, my draft | **Last-write-wins by client timestamp.** Only one author realistically edits; blocking would annoy for no safety gain. |
| **Append-only** | comments, complaint_events, audit | **Merge, never conflict.** Server assigns sequence; both sides' entries survive. |
| **State machines** | complaint status, payment verification | **Server state machine wins.** An invalid transition from the server's current state is dropped and explained to the user ("this complaint was already closed"). |
| **Flags** | read, acknowledged, RSVP | **Union merge**, LWW on ties. Idempotent by nature. |
| **Deletes / voids** | any | **Delete wins** over a concurrent edit; the losing edit is preserved in the conflict log, not discarded. |

```ts
export const CONFLICT_POLICY: Record<Entity, ConflictStrategy> = {
  expenses:   'server-authority',
  dues:       'server-authority',
  payments:   'server-authority',
  cycles:     'server-authority',
  complaints: 'field-level',       // status → server; description → LWW
  comments:   'merge-append',
  notices:    'server-authority',
  visitors:   'state-machine',
  reads:      'union',
};
```

A conflicted op is **never silently discarded**. It stays in the outbox with `status='conflict'`, appears in the Sync Status sheet, and financial conflicts additionally write an `audit_logs` entry when resolved.

## 12.5 Background Sync

- **iOS:** `expo-background-fetch` (BGAppRefreshTask). iOS grants this opportunistically — treat it as a bonus, never a guarantee. Minimum interval 15 minutes, budget 25 seconds; drain only high-priority ops.
- **Android:** `expo-task-manager` + WorkManager with network and battery constraints. More reliable, still not guaranteed under aggressive OEM battery management (Xiaomi, Oppo, Vivo are notorious in this market — never rely on it).
- **Silent push as a sync trigger:** a `content-available` push after a cycle publish wakes the app to pull. Best-effort.
- **Foreground is the real sync path.** Everything above is opportunistic; the app must fully reconcile on next open. Design accordingly.

## 12.6 Network Detection

```ts
export function useNetworkState() {
  const [state, setState] = useState<NetworkState>({ isOnline: true, isMetered: false, quality: 'good' });

  useEffect(() => NetInfo.addEventListener((s) => {
    const isOnline = Boolean(s.isConnected && s.isInternetReachable);
    setState({
      isOnline,
      isMetered: s.type === 'cellular' && s.details?.isConnectionExpensive === true,
      quality: classify(s),      // '2g' | 'poor' | 'good' — from cellularGeneration + RTT probe
    });
    if (isOnline) syncEngine.trigger('network-reconnect');
  }), []);

  return state;
}
```

`isInternetReachable` matters more than `isConnected`: captive portals and dead Wi-Fi report connected while carrying no traffic, and a naive check causes endless failed retries.

Quality-adaptive behaviour: on `2g`/`poor`, skip prefetch, defer image loading to on-demand, reduce page size to 10, and pause background sync. On metered connections, ask before a full prefetch (an important courtesy for users on limited data plans).

---

# 13. Security

## 13.1 OWASP Mobile Top 10 — Controls

| Risk | Control in this system |
|---|---|
| **M1 Improper credential use** | No credentials in code or `app.config.ts`; Razorpay key id is public by design, secret never leaves the server; no hardcoded API keys in `EXPO_PUBLIC_*` beyond genuinely public values |
| **M2 Inadequate supply chain** | pnpm lockfile committed, Dependabot + Snyk, `npm audit` CI gate, no `postinstall` scripts from unvetted packages, SBOM generated per release |
| **M3 Insecure auth/authz** | Short-lived JWTs, rotating refresh with reuse detection, server-side authorisation on every request, UI permission checks treated as affordance only |
| **M4 Insufficient input validation** | Zod at every boundary, `.strict()`, parameterised queries exclusively |
| **M5 Insecure communication** | TLS 1.3, certificate pinning with a backup pin and remote kill-switch, no cleartext traffic (`usesCleartextTraffic=false`, ATS enforced) |
| **M6 Inadequate privacy controls** | EXIF/GPS stripping, PII scrubbed from logs and analytics, DPDP consent, data-export and deletion flows |
| **M7 Insufficient binary protection** | Hermes bytecode, ProGuard/R8 minification, no debug symbols in release, root/jailbreak detection as a soft signal |
| **M8 Security misconfiguration** | Debug menus stripped in production builds, `__DEV__` guards, no verbose errors surfaced to users |
| **M9 Insecure data storage** | SQLCipher for the local DB, SecureStore for tokens and the DB key, **nothing sensitive in MMKV or AsyncStorage**, DB wiped on logout |
| **M10 Insufficient cryptography** | Platform crypto only (Keychain/Keystore); no hand-rolled algorithms; Argon2id for passwords |

## 13.2 OWASP API Top 10 — Controls

| Risk | Control |
|---|---|
| **API1 BOLA** | Every repository method requires `societyId`; RLS enforces it at the database independently; cross-tenant access returns 404; a parameterised test suite attempts cross-tenant access on **every** endpoint |
| **API2 Broken authentication** | JWKS verification, `jti` denylist, `token_version` invalidation, single-flight refresh, OTP rate limits |
| **API3 Broken object property authorisation** | Explicit response mappers — entities are never serialised wholesale. A field is exposed only if a mapper names it |
| **API4 Unrestricted resource consumption** | Rate limits per IP/user/society, pagination caps, file size caps, AI quotas, query timeouts (10s), request body cap (1 MB except uploads) |
| **API5 Broken function-level authorisation** | Declarative `@RequirePermission` on every handler; a CI test fails the build if any non-public route lacks the decorator |
| **API6 Sensitive business flow abuse** | Idempotency keys, approval thresholds, anomaly alerts on bulk operations, velocity checks on payment creation |
| **API7 SSRF** | The server fetches only allowlisted domains; private IP ranges (RFC1918, link-local, metadata endpoints) blocked at the HTTP client level |
| **API8 Security misconfiguration** | CORS allowlist (no wildcard), security headers via Helmet, `x-powered-by` removed, stack traces never returned |
| **API9 Improper inventory** | OpenAPI spec is the inventory; CI fails if a route exists without a spec entry; deprecated versions tracked with sunset dates |
| **API10 Unsafe third-party API consumption** | Webhook signature verification before parsing; provider responses schema-validated; timeouts and circuit breakers on every outbound call |

## 13.3 Encryption

| Data | At rest | In transit |
|---|---|---|
| Database | Managed disk encryption AES-256 | TLS to Postgres |
| High-sensitivity columns (bank account, GSTIN, phone in audit) | `pgcrypto` column encryption, key in KMS | — |
| Object storage | Server-side encryption; private buckets only | TLS + signed URLs (15 min) |
| Local SQLite | SQLCipher AES-256, key in Keychain/Keystore | — |
| Tokens | Keychain (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`) / Android Keystore | — |
| All API traffic | — | TLS 1.3, HSTS + preload, certificate pinning |

**Certificate pinning** with mandatory safeguards: pin the intermediate CA rather than the leaf, ship a backup pin, and implement a remote kill-switch fetched from `/config` so a botched rotation cannot brick every installed client. This has bricked real apps; build the escape hatch first.

## 13.4 Secrets Management

| Environment | Store |
|---|---|
| Local dev | `.env.local`, gitignored; `.env.example` committed with dummy values |
| CI | GitHub Actions encrypted secrets + OIDC to cloud (no long-lived cloud keys) |
| Staging / Production | Doppler or AWS Secrets Manager, injected at runtime, never baked into images |
| Mobile build | EAS Secrets; anything in `EXPO_PUBLIC_*` is treated as public by definition |

Rotation: quarterly for service credentials, immediately on any suspected exposure. Secret scanning (gitleaks) runs on every push and blocks the merge. A leaked secret is rotated first and investigated second.

## 13.5 Secure Storage Decision Table

| Data | Store | Never |
|---|---|---|
| Access + refresh tokens | `expo-secure-store` | MMKV, AsyncStorage, Zustand persist |
| SQLCipher key | `expo-secure-store` | anywhere else |
| Biometric preference | MMKV | — |
| Theme, language, active society | MMKV | — |
| Cached financial data | SQLCipher SQLite | plain SQLite |
| Form drafts | MMKV (encrypted instance) | — |
| Razorpay keys / webhook secret | Server env only | the app bundle |

## 13.6 Injection Defences

**SQL injection** — Drizzle parameterises everything. Raw SQL is permitted only via `sql` template literals with bound parameters, and a lint rule bans string concatenation into `sql.raw`. The NL-search feature never generates SQL (§11.6). Report generators use the same parameterised path as everything else.

**XSS** — user-generated content (notice bodies, complaint text, comments) is sanitised server-side with an allowlist on write **and** escaped on render. React Native does not interpret HTML in `<Text>`, but the web build and email templates do, so both boundaries are covered. No `dangerouslySetInnerHTML` anywhere; a lint rule enforces it.

**CSRF** — the mobile API uses bearer tokens and no cookies, so CSRF is structurally absent. For the Phase 3 web admin, cookie-based sessions will require `SameSite=Strict`, a double-submit token and an `Origin` check. Webhooks are protected by signature verification, not CSRF tokens.

**Command injection** — no shell execution from request data, ever. PDF and image processing use library APIs, not CLI invocations with interpolated paths.

## 13.7 Logging and Audit Trail

**Structured JSON logging** with mandatory fields: `timestamp`, `level`, `requestId`, `userId` (hashed), `societyId`, `route`, `durationMs`, `statusCode`.

**Never logged:** passwords, tokens, OTPs, full phone numbers (last 4 only), email addresses (hashed), Razorpay signatures, card data (never received), full request bodies on financial endpoints, model prompt contents containing member data. A log-redaction middleware applies a deny-list before any transport, and a unit test asserts that a payload containing each forbidden key is redacted.

**Audit trail** — every mutation on money, membership, roles or structure writes an `audit_logs` row via the `@Audited()` interceptor: actor, role, action, before/after JSON, IP, user agent, `requestId`. `UPDATE` and `DELETE` are revoked at the grant level. Retention 7 years. Admin access to the audit log is itself audited.

**Integrity option (Phase 3):** hash-chain the audit log — each row stores `prev_hash` and `row_hash` — so tampering via direct database access becomes detectable. Cheap to add, valuable in a dispute.

## 13.8 Security Testing Cadence

| Activity | Frequency |
|---|---|
| Dependency scan (Snyk, audit) | Every PR |
| Secret scan (gitleaks) | Every push |
| SAST (CodeQL) | Every PR |
| Tenant-isolation suite | Every PR (blocking) |
| Permission-matrix suite | Every PR (blocking) |
| DAST (OWASP ZAP against staging) | Weekly |
| Penetration test (external) | Before Enterprise GA, then annually |
| Access review (prod IAM, database roles) | Quarterly |
| Restore drill from backup | Quarterly |

---

# 14. Performance

## 14.1 Budgets

| Metric | Budget | Enforcement |
|---|---|---|
| Cold start → interactive (mid Android) | < 3.0 s | Maestro-timed in CI on a low-end emulator |
| Warm start | < 1.0 s | — |
| Dashboard render from cache | < 500 ms | — |
| List scroll | 60 fps | FlashList + Reanimated; profiled per release |
| APK size | < 40 MB | CI gate fails the build above the threshold |
| JS bundle (Hermes) | < 6 MB | `expo-atlas` report per PR |
| p95 API latency | < 400 ms | OTel alert |
| p95 database query | < 50 ms | `pg_stat_statements` weekly review |
| Cycle publish (200 flats) | < 10 s | k6 load test |
| Cycle publish (2,000 flats) | < 30 s, async | k6 load test |
| Memory steady state | < 180 MB | — |
| Crash-free sessions | > 99.5% | Sentry release gate |

## 14.2 Lazy Loading

- **Route-level:** Expo Router code-splits per route by default. Heavy screens (Reports, AI Assistant, Cycle Preview grid) additionally use `React.lazy` + `Suspense` with a skeleton fallback.
- **Library-level:** dynamic `import()` for `react-native-razorpay` (only on the pay screen), chart libraries (only in Reports), and the camera/OCR stack (only in the scanner). These three account for a meaningful share of initial parse time.
- **Data-level:** never fetch a list and its details together. Detail screens fetch on mount with the list row as `placeholderData`, so the transition is instant and fills in.
- **Asset-level:** fonts loaded via `expo-font` with `useFonts` and the splash held until ready; illustrations are SVG, not PNG sprites.

## 14.3 Image Optimisation

- `expo-image` everywhere, never `<Image>` from React Native — it has disk caching, `contentFit`, blurhash placeholders and proper memory recycling.
- Server generates 128px and 512px WebP thumbnails; lists render thumbnails, and full resolution loads only in the viewer.
- `recyclingKey` set on all list images so FlashList recycling does not flash the wrong image.
- `cachePolicy="memory-disk"`, 200 MB LRU cap, clearable from Settings.
- Client-side compression before upload (§10.5) keeps typical bills under 400 KB.

## 14.4 Database Performance

- Every filterable and sortable field is indexed; a CI check cross-references filter schemas against `pg_indexes` and fails on a gap.
- **`EXPLAIN ANALYZE` is mandatory in the PR description** for any new query touching `expenses`, `dues`, `payments` or `audit_logs`. A sequential scan on a tenant table is a blocking review comment.
- `member_balances` is a maintained summary table, not a computed aggregate — the dashboard never runs `SUM` over dues.
- Monthly report aggregates are materialised on cycle close into `report_monthly_snapshots`, so an AGM report reads rows instead of scanning three years.
- Reports run against the **read replica**; transactional paths never touch it.
- Connection pooling through PgBouncer in transaction mode; the application pool is sized at `2 × vCPU + 1`, not the default.
- Partition `expenses`, `dues`, `payments`, `audit_logs`, `notifications` by month via `pg_partman` once any exceeds ~10M rows.
- `statement_timeout = 10s` for API connections, `120s` for worker connections. A runaway query must not take the service down.

## 14.5 Pagination and Infinite Scroll

```ts
const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
  queryKey: qk.expenses(sid, filters),
  queryFn: ({ pageParam }) => expenseApi.list(sid, { ...filters, cursor: pageParam, limit: 20 }),
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (last) => last.meta.nextCursor,
});

<FlashList
  data={data?.pages.flatMap(p => p.data) ?? []}
  estimatedItemSize={88}
  onEndReached={() => hasNextPage && !isFetchingNextPage && fetchNextPage()}
  onEndReachedThreshold={0.5}
  keyExtractor={(i) => i.id}
  ListFooterComponent={isFetchingNextPage ? <RowSkeleton /> : null}
/>
```

Page size 20 on good networks, 10 on poor ones. `estimatedItemSize` must be measured, not guessed — a wrong value defeats FlashList's recycling and is a common source of scroll jank.

## 14.6 Memoization

Applied deliberately, not reflexively — `React.memo` on a cheap component costs more than it saves.

- `React.memo` on list row components only, with an explicit comparator on the fields that actually render.
- `useMemo` for split calculations, currency formatting over large lists, and derived aggregates — not for object literals passed as props.
- `useCallback` for handlers passed to memoised children or into FlashList's `renderItem`.
- Zustand selectors are always narrow: `useSocietyStore(s => s.activeSocietyId)`, never `useSocietyStore()`.
- Reanimated worklets for animations so they run on the UI thread, never through React state.
- A `why-did-you-render` pass on the dashboard, expense list and cycle grid before each release; every avoidable re-render is a bug, not an optimisation opportunity.

## 14.7 Bundle Splitting and Startup

- Hermes enabled; bytecode precompiled at build time.
- `expo-atlas` bundle report generated per PR, with a size-delta comment; a 50 KB regression requires justification.
- Tree-shaking preserved by banning barrel re-exports and by importing `lodash-es` submodules directly (`import debounce from 'lodash-es/debounce'`).
- ProGuard/R8 enabled for Android release; unused resources stripped.
- The splash screen is held only until fonts, theme and the cached session are ready — **never** until the first network call completes.
- Inline requires enabled in Metro so rarely-used modules are not evaluated at startup.

## 14.8 Backend Performance

- Fastify adapter; JSON serialisation via schema-compiled serialisers on hot endpoints.
- Redis caching for society settings (24h), membership lookups (5m) and outstanding summaries (60s). Never for balances.
- BullMQ concurrency tuned per queue: notifications 20, reports 2, OCR 5, cycle publish 1 per society (prevents concurrent publishes of the same cycle).
- Bulk inserts use multi-row `INSERT … VALUES` batches of 1,000 (or `COPY` above 10,000 rows) — never a loop of single inserts, which is the difference between 8 seconds and 8 minutes on a cycle publish.
- Graceful shutdown: stop accepting connections, drain in-flight requests (30s), close the pool.

---

# 15. Testing Strategy

## 15.1 Pyramid and Ownership

```mermaid
graph TB
    E["E2E — Maestro · 8 flows<br/>~5% of tests, runs nightly"]
    I["Integration — API + DB · Testcontainers<br/>~20%, every PR"]
    C["Component — RNTL<br/>~25%, every PR"]
    U["Unit — domain, split engine, hooks<br/>~50%, every PR"]
    U --> C --> I --> E
```

## 15.2 Unit Tests

**Scope:** `packages/domain`, `packages/split-engine`, use cases (with in-memory repositories), mappers, hooks, utility functions.

**Coverage requirements — enforced per-path in `jest.config`, not as a single global number:**

| Path | Lines | Branches |
|---|---|---|
| `packages/split-engine/**` | **100%** | **100%** |
| `packages/domain/src/shared/money*` | **100%** | **100%** |
| `packages/domain/src/member/permission-evaluator*` | **100%** | **100%** |
| `**/payment-allocator*`, `**/dues-calculator*` | **100%** | **100%** |
| `apps/api/src/modules/**/use-cases/**` | 90% | 85% |
| Everything else | 80% | 70% |

**Property-based tests** (fast-check) are mandatory on the split engine:

```ts
test.prop([fc.bigInt({ min: 1n, max: 10_000_000_00n }), fc.array(fc.nat({ max: 5000 }), { minLength: 1, maxLength: 500 })])
  ('allocations always sum exactly to the total', (amount, weights) => {
    const result = splitEngine.compute({ amount: Money.fromPaise(amount), strategy: 'shares', weights });
    const sum = result.allocations.reduce((s, a) => s + a.amount.toPaise(), 0n);
    expect(sum).toBe(amount);                       // never off by a paisa
    expect(result.residualPaise).toBe(0);
  });

test.prop([/* … */])('computation is deterministic', (input) => {
  expect(splitEngine.compute(input)).toEqual(splitEngine.compute(input));
});
```

Run with 10,000 iterations in CI. This single test class prevents the highest-severity bug in the product.

## 15.3 Component Tests

React Native Testing Library. **Test behaviour, never implementation.**

```ts
it('blocks saving a custom split until the remainder is zero', async () => {
  renderWithProviders(<SplitConfigurator amountPaise={100000n} participants={three} />);
  await userEvent.type(screen.getByLabelText('Amount for A-101'), '400');
  expect(screen.getByText('Remaining: ₹600.00')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
});
```

Every form, every shared `ui/` primitive, every screen's four states (loading, empty, error, success). Queries use accessible roles and labels — which means writing the test also verifies the screen is accessible. Never `getByTestId` where a role query works.

## 15.4 Integration / API Tests

Jest + Supertest + **Testcontainers** (real Postgres, real Redis, real migrations). No mocked database — a mocked database cannot catch a broken constraint, and constraints are load-bearing here.

Every endpoint gets five cases, minimum:
1. Happy path with the correct role.
2. Unauthenticated → 401.
3. Authenticated but wrong role → 403.
4. **Cross-tenant access → 404** (generated automatically for every endpoint from the route inventory).
5. Validation failure → 422 with the right `field`.

Financial endpoints add: idempotency replay, concurrent-request behaviour, and post-condition assertions on `SUM(splits)`, `member_balances` and `audit_logs`.

External services are mocked at the HTTP boundary with **MSW**, using recorded real responses — including Razorpay's webhook payloads and failure modes.

## 15.5 E2E Tests — Maestro

Eight flows, run nightly on `main` and before every release, on a real low-end Android device in Firebase Test Lab plus an iOS simulator:

1. Signup (phone OTP) → create society → generate 64 apartments → invite
2. Join by code → approval → dashboard
3. Add expense → attach bill → configure per-sqft split → publish → verify dues
4. Pay dues online (Razorpay test mode) → receipt → share
5. **Offline: create expense + complaint → kill app → reopen → reconnect → verify sync**
6. Generate cycle → override a charge → publish → verify notifications
7. Raise complaint → assign → resolve → rate → close
8. Visitor approval from a push notification on a locked device

Flow 5 is the one that catches the most regressions; never skip it to save CI minutes.

## 15.6 Other Test Types

| Type | Tool | Gate |
|---|---|---|
| Contract | OpenAPI diff | Breaking change fails CI |
| Load | k6 | Cycle publish 2,000 flats < 30 s; 500 concurrent payments; 10k concurrent sync pulls |
| Accessibility | RNTL a11y queries + manual TalkBack/VoiceOver | Top 6 screens each release |
| Visual regression | Storybook + Chromatic (optional) | Shared `ui/` only |
| Security | CodeQL, Snyk, tenant-isolation suite | Blocking |
| Migration | Up/down on a production-shaped dump | Blocking |

## 15.7 Manual QA

Automated tests cannot cover these; each release runs a scripted manual pass:

- **Device matrix:** one ₹8,000-class Android (Redmi/Realme, 2 GB RAM, Android 12), one mid Android, one recent iPhone, one iPhone SE (small screen).
- **Network conditions:** airplane mode, 2G throttling, captive portal, mid-request connection drop.
- **Real Razorpay test payments** across UPI intent, UPI collect, card, netbanking, and each failure mode.
- **Locale pass:** Hindi rendering, long-string layout overflow, `fontScale: 2`.
- **Fresh install vs upgrade:** verify migrations and cache busting from the previous released version.
- **Exploratory session** on the newest feature, time-boxed to 60 minutes, findings logged regardless of severity.

## 15.8 Test Rules

- Every bug fix ships with a regression test reproducing the bug first.
- Never mock the unit under test; mock the network boundary only.
- Test data comes from factories (`packages/test-factories`), never inline literals — a factory change updates every test at once.
- Time is injected via the `Clock` port; no test reads the system clock.
- Tests run in parallel and must be order-independent; a test that only passes in sequence is broken.
- Flaky tests are quarantined within 24 hours and fixed or deleted within a week. A tolerated flaky test trains the team to ignore red builds.

---

# 16. CI/CD

## 16.1 Repository and Branching

GitHub, trunk-based. `main` is always releasable. Feature branches live under 3 days; anything longer sits behind a feature flag.

Branch protection on `main`: 1 approval, all checks green, no force-push, signed commits on release tags, linear history (squash merge only), `CODEOWNERS` review required for `packages/split-engine`, `packages/domain`, migrations and CI config.

## 16.2 Pipelines

```mermaid
graph TB
    PR["Pull Request"] --> CI["ci.yml<br/>typecheck · lint · unit · integration · build"]
    PR --> SEC["security.yml<br/>CodeQL · Snyk · gitleaks"]
    PR --> CON["contract-check.yml<br/>OpenAPI breaking diff"]
    PR --> PREV["mobile-preview.yml<br/>EAS preview build + QR"]
    CI --> MERGE{"Merge to main"}
    MERGE --> STG["api-deploy.yml → staging"]
    MERGE --> OTA["EAS Update → preview channel"]
    MERGE --> E2E["e2e.yml nightly (Maestro)"]
    STG --> TAG{"Release tag v*"}
    TAG --> PROD["api-deploy.yml → production<br/>blue-green"]
    TAG --> STORE["mobile-release.yml<br/>EAS Build + Submit"]
    PROD --> SMOKE["Smoke tests + health gate"]
```

### `ci.yml` (every PR, target < 8 minutes)
```yaml
jobs:
  setup:      # pnpm install --frozen-lockfile, Turbo remote cache restore
  typecheck:  # tsc --noEmit across all workspaces
  lint:       # eslint + dependency-cruiser (layer boundaries) + prettier check
  test-unit:  # jest --coverage, per-path thresholds enforced
  test-integration:  # Testcontainers Postgres + Redis
  build:      # nest build + expo export (verifies the bundle compiles)
  bundle-size: # expo-atlas report, comment delta, fail > +50KB unjustified
```

## 16.3 Preview Builds

Every PR touching `apps/mobile` triggers an **EAS preview build** on the `preview` channel, and a bot comments with a QR code and install link. Reviewers test on a real device before approving UI changes — screenshots in a PR description are not sufficient for touch-target, font-scaling or dark-mode verification.

API PRs deploy to an ephemeral preview environment with a seeded database, torn down on merge.

## 16.4 Production Builds

**Backend** — blue-green on tag:
1. Build and push the Docker image (tagged with the git SHA).
2. Run migrations **before** deploying the new version (expand-phase migrations only, always backward-compatible with the running version).
3. Deploy green alongside blue; run smoke tests against green.
4. Shift traffic 10% → 50% → 100%, watching error rate and p95 latency at each step.
5. Blue stays warm for 30 minutes for instant rollback.

**Mobile** — `eas build --profile production` for both platforms, auto-submitted via `eas submit`. Staged rollout 10% → 50% → 100% over 72 hours, gated on Sentry crash-free rate staying above 99.5%. An automated check halts the rollout if it drops.

## 16.5 OTA Updates

EAS Update, channel-per-environment (`development`, `preview`, `production`).

**OTA is permitted for:** JS-only bug fixes, copy and translation changes, style fixes, feature-flag defaults, minor UI adjustments.

**OTA is forbidden for:** anything touching native modules, permission strings, the payment flow, the sync engine's conflict logic, or database migration-dependent code. These require a store build, because an OTA can land on a device mid-session and a half-updated payment flow is a money bug.

Rules: an OTA must be compatible with the native runtime version it targets (`runtimeVersion` policy `appVersion`). Every OTA is staged at 10% for 2 hours with crash monitoring before full rollout. `eas update:rollback` is one command and is rehearsed quarterly.

## 16.6 Release Strategy and Versioning

**Semantic versioning** driven by Conventional Commits via `semantic-release`:
- `fix:` → patch, `feat:` → minor, `feat!:`/`BREAKING CHANGE:` → major.
- The app version and the API version are versioned independently; compatibility is declared in `/config` as `minSupportedVersion`.
- `buildNumber`/`versionCode` auto-increment from the CI run number.

**Cadence:** store releases every 2 weeks; OTA as needed; hotfixes immediately via a `hotfix/` branch cut from the release tag, merged back to `main`.

**Release checklist (automated where possible):** changelog generated, migrations reviewed and tested against a production-shaped dump, feature flags set to their launch state, Sentry release created with source maps uploaded, store metadata and screenshots updated, rollback plan stated in the release notes.

---

# 17. Monitoring

## 17.1 The Four Signals

| Signal | Tool | Primary use |
|---|---|---|
| **Errors** | Sentry (mobile + API) | Crash-free rate, error grouping, release regression detection |
| **Product** | PostHog | Funnels, retention, feature adoption, flags, session replay |
| **Traces & metrics** | OpenTelemetry → Grafana/Tempo | Latency, dependency timing, queue depth |
| **Logs** | Structured JSON → Better Stack | Investigation, correlated by `requestId` |

## 17.2 Crash Reporting

`sentry-expo` on mobile, `@sentry/node` on the API, sharing a `requestId` so a mobile error links to its server-side trace.

- Source maps uploaded on every build; a release with missing source maps fails the release job.
- **PII scrubbing before send** is mandatory: `beforeSend` strips tokens, phone numbers, email addresses and any key matching the log deny-list.
- Breadcrumbs capture navigation, API calls (method + path + status, never body), and sync events — enough to reconstruct what the user did without recording what they saw.
- Release health gates the staged rollout; a crash-free session rate below 99.5% halts it automatically.
- Alert routing: crash-free < 99% → page on-call; a new error affecting > 50 users in an hour → page; anything touching the payment or sync path → page regardless of volume.

## 17.3 Analytics

PostHog, with the event taxonomy from PRD §12.2. Architectural rules:

- Events are emitted through `lib/analytics.ts`, never by calling the SDK directly — this is the single place scrubbing and consent are applied.
- Every event carries `societyId` (hashed), `role`, `plan`, `platform`, `appVersion`, `isOffline`, `societySizeBucket`.
- **No PII in properties.** Amounts are bucketed, never exact.
- Events are queued offline and flushed on reconnect, so offline usage is not invisible in the funnel.
- Consent-gated: opting out disables product analytics but not anonymised crash reporting (disclosed in the privacy policy).
- Feature flags are served by PostHog with a local cache, so a flag service outage never blocks the app — flags fall back to their bundled defaults.

## 17.4 Logging

Structured JSON with `requestId` propagated end to end via `AsyncLocalStorage` and returned in every response, so a user reporting a problem can quote one string that finds the exact trace.

Levels: `error` (needs human attention), `warn` (degraded but handled — a fallback fired, a retry succeeded), `info` (business events: cycle published, payment verified), `debug` (dev only, stripped in production).

Retention: 30 days hot, 1 year cold for security-relevant logs, 7 years for `audit_logs` (in Postgres, not the log pipeline).

## 17.5 Health Checks

| Endpoint | Purpose | Checks |
|---|---|---|
| `GET /health/live` | Liveness probe | Process responsive. No dependency checks — a database blip must not restart the pod |
| `GET /health/ready` | Readiness probe | Postgres `SELECT 1`, Redis `PING`, migrations current |
| `GET /health/deep` | Ops dashboard (authenticated) | Above + storage reachable, Razorpay API reachable, queue depths, replica lag |

Synthetic monitoring from three Indian regions every minute: login, dashboard load, expense list. Because a green health check while real users cannot log in is the failure mode that health checks alone miss.

## 17.6 Performance Monitoring

**Mobile:** Sentry Performance for cold/warm start, screen render times, and API call duration as experienced by the device (the number that actually matters — server p95 says nothing about a user on 3G). App-start spans instrumented explicitly.

**Backend:** OpenTelemetry auto-instrumentation for HTTP, Postgres and Redis, plus manual spans around use-case execution, split computation, and gateway calls. Track p50/p95/p99 per route, database query duration, queue wait and processing time, cache hit rate, and external dependency latency.

**Database:** `pg_stat_statements` reviewed weekly; alerts on replica lag > 10s, connection pool saturation > 80%, any query exceeding 1s, dead-tuple ratio > 20%.

## 17.7 Alerting and On-Call

| Severity | Examples | Response |
|---|---|---|
| **Sev-1** | Payments failing, **any confirmed balance discrepancy**, data loss, auth outage, cross-tenant leak | Page immediately, 15-min ack, all-hands, status page update |
| **Sev-2** | Cycle publish failing, push delivery < 80%, p95 > 2s, sync failure rate > 5% | Page during business hours, 1-hour ack |
| **Sev-3** | Elevated error rate, a degraded non-critical feature, AI provider down | Ticket, next business day |

**Business-metric alerts matter as much as technical ones:** payment success rate below 85% for an hour, zero cycles published on the 1st of a month (means the scheduler died), a spike in `SPLIT_MISMATCH` errors, or balance-reconciliation drift detected by the nightly job. The last one is Sev-1 by definition — it means a resident may be looking at a wrong number.

Runbooks live in `docs/runbooks/` and are linked directly from each alert.

---

# 18. Coding Standards

## 18.1 Naming

| Element | Convention | Example |
|---|---|---|
| Component file + name | PascalCase | `ExpenseCard.tsx` → `ExpenseCard` |
| Hook file + name | camelCase, `use` prefix | `useExpenseList.ts` |
| Route file | kebab-case | `payment-history.tsx` |
| Other TS file | camelCase | `splitEngine.ts`, `money.vo.ts` |
| Use case | `{Verb}{Noun}UseCase` | `PublishExpenseUseCase` |
| Repository interface / impl | `I{Noun}Repository` / `{Tech}{Noun}Repository` | `IExpenseRepository`, `DrizzleExpenseRepository` |
| DTO / schema | `{Verb}{Noun}Request` / `Response` | `CreateExpenseRequest` |
| Command | `{Verb}{Noun}Command` | `PublishExpenseCommand` |
| Entity | Singular noun | `Expense`, `Member` |
| Value object | `{Noun}.vo.ts` | `money.vo.ts` |
| Domain event | Past tense | `ExpensePublishedEvent` |
| Class | PascalCase | `SplitEngine` |
| Function | camelCase, verb-first | `computeSplit`, `fetchExpenses` |
| Boolean | `is`/`has`/`can`/`should` | `isOverdue`, `canPublish` |
| Handler (impl / prop) | `handleX` / `onX` | `handleSubmit` / `onSubmit` |
| Constant | SCREAMING_SNAKE | `MAX_ATTACHMENT_BYTES` |
| Type / Interface | PascalCase, **no `I` prefix** except ports | `ExpenseFilters`, `IExpenseRepository` |
| Enum type / values | PascalCase / snake_case strings | `ExpenseStatus` / `'pending_approval'` |
| DB table / column | snake_case, plural / singular | `expense_splits.amount_paise` |
| JSON field | camelCase | `amountPaise` |
| **Money field** | **always suffixed `Paise` / `_paise`** | `totalPaise` — no exceptions |
| Test file | `*.test.ts(x)` beside source | `splitEngine.test.ts` |
| Branch | `type/TICKET-slug` | `feat/SES-142-split-editor` |

## 18.2 Folder Rules

1. **Feature-first, not type-first.** Everything for expenses lives under `features/expenses/` (mobile) or `modules/expenses/` (API).
2. **No cross-feature imports.** If `payments` needs something from `expenses`, it belongs in `packages/domain` or `lib/`. Enforced by `dependency-cruiser`.
3. **The dependency rule is enforced, not documented.** `domain/` may not import from `application/`, `infrastructure/` or any framework. CI fails on violation.
4. **No barrel files** re-exporting an entire folder.
5. **Routes are wrappers.** `app/**/*.tsx` imports a screen and renders it. Target under 20 lines.
6. **Tests live beside the code** they test, except integration and E2E suites.
7. **Shared means shared by two or more features.** Used once? It stays in the feature.

## 18.3 Components

```tsx
type ExpenseCardProps = {
  expense: ExpenseSummary;
  onPress: (id: ExpenseId) => void;
  showSyncState?: boolean;
};

export function ExpenseCard({ expense, onPress, showSyncState = false }: ExpenseCardProps) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onPress(expense.id), [expense.id, onPress]);

  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={t('expense.cardLabel', { title: expense.title, amount: formatMoney(expense.amountPaise) })}
      className="min-h-[48px] flex-row items-center gap-3 rounded-xl bg-surface-container p-4 active:opacity-70"
    >
      <CategoryIcon category={expense.category} />
      <View className="flex-1">
        <Text className="text-body-large text-on-surface" numberOfLines={1}>{expense.title}</Text>
        <Text className="text-body-small text-on-surface-variant">{formatDate(expense.expenseDate)}</Text>
      </View>
      <Money paise={expense.amountPaise} className="text-title-medium" />
      {showSyncState && expense.isPending && <SyncChip />}
    </Pressable>
  );
}
```

Rules: function components only; one component per file; a component over ~200 lines is decomposed; props destructured with defaults; no prop drilling beyond two levels; **no business logic in JSX** — a component computing a balance inline is a bug; every interactive element has an accessibility role and label; minimum 48dp touch targets; all strings through `t()`.

## 18.4 Hooks

- Prefix `use`, one responsibility each.
- Data-fetching hooks live in `features/*/hooks/` and wrap TanStack Query — **never** `useEffect` + `fetch`.
- Return objects, not positional tuples, beyond two values.
- Hooks contain no JSX. Components contain no data-fetching logic.
- A hook composing more than three other hooks is doing too much; split it.

## 18.5 Services and Use Cases

- One use case, one business operation, one public `execute()`.
- Depend on ports; never construct a dependency inside a use case.
- Own the transaction boundary; nothing below opens a transaction.
- Return `Result<T, E>` for expected failures; `throw` only for programmer errors.
- Never import an HTTP type. A use case does not know what a request is.
- A use case over ~80 lines usually hides a domain service that should be extracted.

## 18.6 DTOs, Interfaces, Enums

- DTOs are Zod schemas in `packages/contracts`, with types inferred (`z.infer`) — never hand-written twice.
- `.strict()` on every request schema.
- Entities are never returned from a controller; an explicit mapper produces the response DTO. This is what makes over-exposure of fields impossible.
- Interfaces for contracts that others implement (ports); `type` for data shapes and unions.
- Prefer **union types over TypeScript enums** — they erase to plain strings, serialise cleanly and match database enums exactly:
  ```ts
  export const EXPENSE_STATUSES = ['draft','pending_approval','published','void'] as const;
  export type ExpenseStatus = typeof EXPENSE_STATUSES[number];
  ```
- Branded types for every id and for money. Passing a `MemberId` where an `ExpenseId` belongs must not compile.

## 18.7 Error Handling

```ts
// Expected failures: Result. Unexpected: throw.
async function publish(cmd: Command): Promise<Result<Output, AppError>> {
  const expense = await repo.findById(cmd.id, cmd.societyId);
  if (!expense) return err(AppError.notFound('Expense'));        // expected
  const published = expense.publish(allocations, clock);
  if (published.isErr()) return err(AppError.fromDomain(published.error));
  await repo.save(expense);                                       // throws → 500, Sentry
  return ok(Output.from(expense));
}
```

Rules: never swallow an error silently; never `catch (e) {}`; never `console.log` in committed code (lint error) — use `logger` with a level. Error messages are actionable and safe to display. Internal details never reach the client. Every `catch` either handles, wraps with context, or rethrows — never all three ambiguously.

## 18.8 Comments and Documentation

Comments explain **why**, never what. A comment restating the code is deleted in review.

```ts
// Residual paise go to the largest fractional shares, tie-broken by apartment number.
// This makes the outcome deterministic and auditable — a treasurer must be able to
// explain to a resident why their flat pays ₹0.01 more than the one next door.
function distributeResidual(allocations: Allocation[], residual: bigint): Allocation[] { … }
```

- JSDoc on every exported function in `packages/*`, with `@throws` where applicable.
- Every non-obvious architectural choice gets an ADR in `docs/ARCHITECTURE_DECISIONS/`, numbered, with Context / Decision / Consequences / Alternatives considered.
- Every module carries a `README.md` stating its responsibility and public interface.
- `TODO` comments must include an owner and a ticket: `// TODO(SES-412, ramesh): handle partial refunds`. Un-ticketed TODOs fail lint.

## 18.9 Commit Messages

Conventional Commits, enforced by commitlint:

```
<type>(<scope>): <subject>

<body — why, not what>

<footer — BREAKING CHANGE / Refs: SES-142>
```

Types: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `chore`, `ci`, `build`, `revert`.
Scopes: `expenses`, `payments`, `sync`, `auth`, `db`, `ui`, `api`, `mobile`, `split-engine`, `ci`.

```
feat(split-engine): add per-floor-band apartment basis

Lift maintenance is conventionally billed with ground floor exempt and
upper floors weighted higher. Previously treasurers worked around this
with a custom split, re-entered every month.

Refs: SES-142
```

Subject in imperative mood, under 72 characters, no trailing period.

## 18.10 Branch Strategy

Trunk-based. `main` always releasable.

```
main ────────●────────●────────●────────●──────► (tagged v1.2.0, v1.2.1)
              \      /          \      /
      feat/SES-142          fix/SES-158
```

- Feature branches under 3 days; anything longer goes behind a feature flag and merges incrementally.
- Rebase on `main` before opening a PR; squash merge to keep history linear.
- `hotfix/*` branches from a release tag, merge to `main` and cherry-pick to the release.
- PRs under ~400 changed lines. Larger ones get split — review quality collapses beyond that, and this is a codebase where a missed review comment can mean a wrong bill.

---

# 19. Deployment

## 19.1 Environments

| | Development | Staging | Production |
|---|---|---|---|
| **API** | Local Docker Compose | Fly.io / Railway, 1 instance | Fly.io → AWS ECS `ap-south-1`, ≥ 2 instances |
| **Database** | Local Postgres 15 | Supabase (free/small) | Supabase Pro → RDS with a read replica |
| **Redis** | Local container | Managed, 128 MB | Managed, 512 MB, persistence on |
| **Storage** | MinIO (S3-compatible) | Supabase Storage | Supabase Storage → R2 |
| **Razorpay** | Test mode | Test mode | **Live mode** |
| **Notifications** | Console logging | Real push, emails to a catch-all mailbox, **SMS disabled** | Fully live |
| **LLM** | Real, low quota | Real, low quota | Real, per-plan quota |
| **Mobile channel** | `development` (dev client) | `preview` (internal testers) | `production` (stores) |
| **Data** | Seeded synthetic | **Anonymised** production-shaped dump | Real |
| **Deploy trigger** | Manual | Auto on merge to `main` | Manual on release tag |

Staging is production-shaped, not production-lite: same Postgres major version, same migrations, same row-count order of magnitude. A staging environment with 40 rows tests nothing about a cycle publish for 200 flats.

**Never** point a non-production environment at production data or live Razorpay keys. The anonymisation script (`scripts/db/anonymise-dump.ts`) replaces names, phones and emails while preserving row counts, distributions and referential integrity — it is a security control, so it is reviewed like one.

## 19.2 Environment Variables

Validated at boot with Zod; the process **refuses to start** on a missing or malformed variable. A config error must fail loudly at deploy time, never silently at 2am when a code path first reads `undefined`.

```ts
// apps/api/src/config/validation.schema.ts
export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development','staging','production']),
  PORT: z.coerce.number().default(3000),

  DATABASE_URL: z.string().url(),
  DATABASE_REPLICA_URL: z.string().url().optional(),
  REDIS_URL: z.string().url(),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(32),
  SUPABASE_JWT_ISSUER: z.string().url(),

  RAZORPAY_KEY_ID: z.string().startsWith('rzp_'),
  RAZORPAY_KEY_SECRET: z.string().min(16),
  RAZORPAY_WEBHOOK_SECRET: z.string().min(16),

  MSG91_AUTH_KEY: z.string(),
  RESEND_API_KEY: z.string().startsWith('re_'),
  EXPO_ACCESS_TOKEN: z.string(),

  STORAGE_PROVIDER: z.enum(['supabase','r2','s3']),
  STORAGE_BUCKET: z.string(),

  ANTHROPIC_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),

  SENTRY_DSN: z.string().url().optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),

  ENCRYPTION_KEY: z.string().length(64),           // hex, 32 bytes
}).superRefine((env, ctx) => {
  if (env.NODE_ENV === 'production') {
    if (!env.SENTRY_DSN) ctx.addIssue({ code: 'custom', message: 'SENTRY_DSN required in production' });
    if (env.RAZORPAY_KEY_ID.startsWith('rzp_test_'))
      ctx.addIssue({ code: 'custom', message: 'Test Razorpay key in production' });
  }
});
```

That last check has saved real companies real money. Keep it.

**Mobile:** `EXPO_PUBLIC_*` variables are **public** — they ship in the bundle and can be read by anyone with the APK. Only the API base URL, the Razorpay *key id*, the Sentry DSN and the PostHog public key belong there. Anything else goes through EAS Secrets and is used at build time only.

## 19.3 Deployment Process

**Backend (blue-green):**
```
1. Tag v1.2.0 → CI builds and pushes image:sha
2. Run expand-phase migrations (backward-compatible with running version)
3. Deploy green; wait for /health/ready
4. Smoke tests against green (login, dashboard, expense list, health/deep)
5. Shift traffic 10% → watch 5 min → 50% → watch 5 min → 100%
6. Blue warm for 30 min
7. Contract-phase migrations only after all clients have upgraded
```

**Workers** deploy after the API, drain gracefully (finish in-flight jobs, stop polling, exit within 60s), and BullMQ redelivers anything interrupted — every processor must therefore be idempotent, which is asserted in its tests.

**Mobile:** `eas build --profile production` → `eas submit` → staged rollout 10/50/100 over 72 hours, gated on crash-free rate.

## 19.4 Rollback

| Failure | Rollback | Time |
|---|---|---|
| API bug | Shift traffic to blue | < 2 min |
| Bad OTA | `eas update:rollback --channel production` | < 5 min (takes effect on next app launch) |
| Bad store build | Halt the staged rollout; publish the previous build | Hours (store-dependent) — **this is why the OTA/store split in §16.5 matters** |
| Bad migration | Run the tested `down` migration; if data-destructive, restore from PITR | 5 min – 1 hour |
| Data corruption | PITR restore to just before the incident + replay from audit log | Up to 1 hour (rehearsed quarterly) |

**Migration rollback is the dangerous one.** A migration that drops a column cannot be undone by a `down` script. Hence expand→migrate→contract: the contract phase runs days later, once the new version is confirmed stable, and only for changes that are genuinely safe to make irreversible.

**Backups:** PITR with 7-day retention, nightly snapshots retained 30 days, weekly snapshots retained 90 days, all in `ap-south-1` with a cross-region encrypted copy. **Quarterly restore drills** into a scratch environment, timed and documented — an untested backup is not a backup.

## 19.5 Disaster Recovery

| Scenario | RTO | RPO | Plan |
|---|---|---|---|
| API instance failure | 0 (redundant) | 0 | Load balancer removes it; auto-replace |
| Database failure | < 15 min | < 1 min | Promote replica; update connection string |
| Region outage | < 4 h | < 5 min | Restore from cross-region backup into a secondary region |
| Accidental data deletion | < 1 h | Point in time | PITR restore to a scratch database, extract, re-import |
| Storage loss | < 2 h | < 24 h | Versioned buckets + cross-region replication |
| Razorpay outage | Degraded | 0 | Offline payment recording continues; queued intents retried; users informed in-app |

---

# 20. Future Scalability

## 20.1 Microservices Readiness

The modular monolith is already decomposed along the seams a service split would follow. Extraction requires no rewrite because each module owns its tables, communicates through interfaces, and emits events rather than calling peers directly.

```mermaid
graph TB
    subgraph Now["Now — one deployable"]
        M["NestJS monolith<br/>expenses · payments · maintenance<br/>notifications · ai · reports"]
    end
    subgraph Later["Later — extracted in this order"]
        S1["Notification Service<br/>first: stateless, event-driven, bursty"]
        S2["Report Service<br/>second: CPU-heavy, isolable, read-only"]
        S3["AI Service<br/>third: different scaling and cost profile"]
        S4["Core Financial Service<br/>last, possibly never"]
    end
    M -.->|extract| S1 --> S2 --> S3 --> S4
```

**Extraction order is deliberate.** Notifications first — stateless, already event-driven, and its load spikes independently (a cycle publish fans out to 2,000 pushes). Reports second — CPU-bound PDF generation that should not share a process with request handling. AI third — different cost model and scaling curve. The financial core goes **last, and possibly never**: publishing a cycle must atomically write expenses, splits, dues and balances, and distributing that transaction across services buys nothing but sagas, eventual inconsistency and a new class of money bug.

Readiness work to do now (cheap now, expensive later):
- Modules communicate via an event bus interface, not direct imports — swapping in-process dispatch for Redis Streams or SQS becomes a provider change.
- No cross-module foreign keys outside a module's own aggregate; cross-aggregate references are by id, resolved through a public interface.
- Every module exposes an explicit public API (`index.ts` with named exports); internals are unreachable.
- `requestId` propagates through every call and every event — distributed tracing works the day a service is extracted.

## 20.2 Multi-Society Support

Already the core model, but three levels of scale-out are anticipated:

**Level 1 — a user in many societies (built).** Memberships are per-society; `activeSocietyId` scopes every query key and API call.

**Level 2 — portfolio view (Phase 3).** A facility-management company or a federation managing 40 societies needs cross-society aggregation. Add a `portfolios` table and `portfolio_memberships`; queries aggregate across `society_id IN (…)`. The RLS policies already accept a set rather than a single value, so this requires no schema rework on existing tables.

**Level 3 — tenant isolation tiers (Phase 4).** Enterprise customers demanding physical isolation get a dedicated database with the *same* schema and migrations; a routing layer maps `societyId → connection`. Because tenancy is a column and not a schema, both models coexist without forking the codebase.

## 20.3 Internationalization

Built in from day one, activated progressively.

- All strings through `i18next`; a lint rule bans literals in JSX. Catalogues in `packages/i18n`, keys namespaced by feature.
- ICU message format for plurals and gender (essential for Hindi, Marathi, Tamil).
- **Locale-aware money formatting is already abstracted** — `formatMoney` takes a locale; the Indian lakh/crore grouping is one implementation among several.
- Dates through a `date.ts` wrapper with an injected timezone; the financial-year start month is a society setting (April in India, January elsewhere), already in `society_settings`.
- `currency` is a column on `societies` with a `CHECK` limiting it to INR today; `Money` already carries a currency and refuses cross-currency arithmetic, so multi-currency is a data change rather than a refactor.
- RTL-safe layout primitives (`start`/`end` rather than `left`/`right` in NativeWind classes) from the beginning, even though no RTL language ships initially.
- Translation workflow: extract with `i18n-extract`, translate in Crowdin, PR back. Untranslated keys fall back to English and are reported in CI.

## 20.4 Plugin Architecture (Phase 4)

For white-label and enterprise customisation without forking:

```ts
export interface SocietyPlugin {
  id: string;
  version: string;
  hooks: {
    onExpensePublished?(e: ExpensePublishedEvent, ctx: PluginContext): Promise<void>;
    onPaymentVerified?(e: PaymentVerifiedEvent, ctx: PluginContext): Promise<void>;
    onCyclePublished?(e: CyclePublishedEvent, ctx: PluginContext): Promise<void>;
    beforeSplitCompute?(input: SplitInput): SplitInput;        // custom split rules
  };
  screens?: PluginScreen[];                                     // registered mobile routes
  permissions: Permission[];                                    // declared, granted per society
}
```

Constraints from day one: plugins run in a sandboxed worker with a time budget and no direct database access (only `PluginContext`'s scoped API); a plugin failure is logged and swallowed, never propagated into a financial transaction; plugins can observe and extend, never mutate the ledger directly. The event bus (§20.1) is the extension point, which is another reason to build it now.

## 20.5 Web Support

Expo Web already produces a build. The staged plan:

- **Phase 2:** read-only report viewing via signed guest links (`/r/{token}`) — no auth, no app install. This is how auditors and prospective buyers get access, and it is already in the PRD as Guest Viewer.
- **Phase 3:** a **separate Next.js admin console** (`apps/admin`) rather than a full Expo Web app. Reason: treasurer workflows that are genuinely better on a desktop — bulk apartment import, the cycle preview grid at 2,000 rows, reconciliation against a bank statement, report design — need real tables, keyboard navigation and multi-pane layouts. Forcing those through a mobile-first component library produces a worse product than a purpose-built web app. It shares `packages/contracts`, `packages/domain` and the API, so there is no duplicated logic — only duplicated presentation, which is the correct thing to duplicate.
- **Phase 4:** a resident-facing PWA for societies where some owners refuse to install an app (common with elderly owners) — a meaningful adoption blocker worth solving.

## 20.6 Admin Dashboard (internal)

An internal operations console, separate from the customer-facing admin:
- Society lookup, plan management, manual entitlement grants, trial extension.
- Support tools: impersonation **with explicit consent and full audit logging** (never silent), balance rebuild, webhook replay, sync-conflict inspection.
- Financial ops: settlement reconciliation, refund initiation, failed-payment investigation.
- Platform health: queue depths, AI cost per society, feature-flag state, error budgets.

Access via SSO with hardware-key MFA; every action writes to a separate `platform_audit_logs` table. Impersonation surfaces a persistent banner to the impersonated user's own session history — the user must be able to see that it happened.

## 20.7 White Labeling (Phase 4)

For builders and facility-management companies:
- **Branding as data:** logo, colour seed, app name and support contact live in `society_settings` / a `brands` table. Because the theme is generated from a seed colour through MD3 tonal palettes, rebranding is one hex value, not a stylesheet fork.
- **Custom app builds** via EAS with a `brandId` build-time variable selecting assets, bundle identifier and store listing. One codebase, N build profiles.
- **Custom domains** for the web console and report links, with automated certificate provisioning.
- Email and WhatsApp templates take brand variables; receipts and bills already render the society's logo.

Deliberate limit: white-label changes presentation and distribution, never behaviour. A forked product line is how a small team dies — the plugin architecture (§20.4) is the supported path for behavioural customisation.

---

# 21. Implementation Summary

**Build a modular-monolith NestJS API in front of PostgreSQL, with an offline-first Expo client, and share the money logic between them as a single package.**

The ten decisions that carry the most weight:

1. **`packages/split-engine` and `packages/domain` are shared by client and server.** The preview a treasurer sees and the bill residents receive come from the same code. This is the single most important structural choice in the system.
2. **All money is `bigint` paise behind a branded `Money` value object.** No floats, no `parseFloat`, no `* 100` outside the money module. A rounding bug here is a Sev-1 by definition.
3. **The server is the sole authority on financial state.** The client previews and queues; the server decides. SQLite is a replica with an outbox, never a source of truth.
4. **Four layers with an enforced dependency rule.** `domain/` imports no framework. CI fails on violation — this is a build gate, not a style guide.
5. **Tenancy is enforced three times:** UI affordance, API guard, and Postgres RLS. A cross-tenant test runs against every endpoint on every PR, and cross-tenant access returns 404, never 403.
6. **Idempotency keys on every money-moving POST**, with the mobile outbox's `opId` doubling as the key. This is what makes offline retries and webhook replays safe by construction rather than by luck.
7. **Conflicts are resolved per entity class**, not by one global rule: server authority for money, LWW for user-owned text, merge for append-only streams, state-machine precedence for status. No financial conflict is ever auto-resolved.
8. **AI is advisory and behind a gateway.** Schema-validated output, deterministic engines for anything numeric, a working fallback for every feature, and no code path from a model response to a ledger write.
9. **Database constraints enforce the money invariants** — deferred triggers on split totals and allocation ceilings, append-only grants on audit tables, plus a nightly reconciliation job that recomputes balances from source and pages on drift.
10. **OTA for JS, store builds for anything touching payments, sync or native.** A half-updated payment flow mid-session is a money bug; the release split exists to make that impossible.

**Build order.** Foundations and the split engine first (it is the riskiest component and everything depends on it). Then auth and tenancy, because every subsequent feature sits on top of the guard chain. Then expenses, then payments, then cycles — each fully tested before the next, since each builds on the previous one's invariants. Community features, reports, offline sync hardening, AI and subscriptions follow. The PRD's 52-task roadmap maps onto this order directly; this document supplies the *how* for each of those tasks.

**The one test that must never go red:** for any amount and any participant set, the split engine's allocations sum to exactly the total, deterministically. Everything else in this architecture is recoverable. That one is not.

---

*End of Software Architecture Document.*
