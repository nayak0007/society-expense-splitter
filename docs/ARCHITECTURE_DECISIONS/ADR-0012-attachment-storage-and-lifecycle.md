# ADR-0012 — Attachment storage and lifecycle

**Status:** Accepted · **Date:** 2026-10-07 · **Scope:** T071, binding on T073 / T076 / T132 / T107

> **Note on D1.** The first design for the upload size gate — a presigned POST
> policy with `["content-length-range", 1, cap]` — was **refuted by measurement**
> against the staging/production provider before implementation: Supabase
> accepted a 10 MB + 1 byte upload under a 10 MB policy and served it. D1 below is
> the measured replacement, approved on the same evidence. The refuted design and
> its evidence are preserved in D1 and in "Rejected alternatives" so the deviation
> from SAD §10.1's literal wording is auditable.

> **Deployment note (2026-10-07, recorded when T071 was closed).** Production
> infrastructure is intended to run **Supabase for PostgreSQL and Auth only**, with
> the NestJS API, Redis and an **S3-compatible object store on a VPS**. Supabase
> Storage is therefore a **supported, verified-compatible provider — not a required
> one**. D1's hosted measurements were taken against it because SAD §14.2 then named
> it for staging and production, and they remain valid evidence about the _port_:
> one S3-compatible adapter, with endpoint, region, credentials, bucket and
> path-style addressing determining which store the bytes reach. The only store this
> repository pins is the **local/test** object store the integration suite starts
> (an archived build — explicitly not a production recommendation); which
> S3-compatible product a VPS deployment runs is a separate deployment decision and
> remains open. Nothing in D1–D6 changes.

## Context

T071 introduces attachments: an object store holds bytes, the API holds a verified
reference. Its Roadmap acceptance sentence is:

> `IStorageProvider` per SAD §10.2 · Presigned PUT valid 15 minutes with a
> content-length range enforced · Key layout matches SAD §10.3 · Completion
> verifies checksum and magic bytes, not the extension · Plan quota checked before
> issuing a URL · MinIO used locally, Supabase in staging and production

and its tests demand:

> Oversized upload rejected by the storage layer · Mismatched checksum rejected at
> completion · A `.jpg` with PDF magic bytes rejected

Nine pre-implementation questions had no written answer (the Roadmap describes
files that exist nowhere in this repository; PRD §8.2 and SAD §10.1 describe
different routes; PRD §7.4, SAD §8.5 and SAD §10.7 give three different versions
of the `attachments` table). The audit that raised them resolved them as D1–D6.
Three facts shaped the constraints:

1. **T071 moves no money.** It touches no expense, split, due, balance, revision
   or roster row — only a new `attachments` table and the object store.
2. **The size gate has to be real.** A pre-signed URL hands the device a
   credential that lets it write to our storage. If the API cannot bound the
   bytes that credential admits, the "10 MB bill" rule is enforced by nothing but
   client good behaviour, and an offender can exhaust the plan quota of a whole
   society.
3. **The size gate has to be enforced by the storage layer, not by us after the
   fact**, because T071's own test list says so, and because a post-hoc refusal
   still lets the bytes land.

## Decisions

### D1 — Presigned PUT with an exact-size signature; the cap is three measured layers

The upload credential is a **presigned `PutObject` URL whose signature pins the
exact object size**: `ContentLength` = the `sizeBytes` the client declared at
presign time, which appears in the signature as
`X-Amz-SignedHeaders=content-length;host`. The per-type cap from SAD §10.4 is then
enforced by three layers, **each measured working on the hosted provider**:

1. **exact-size pinning** — a payload of any other size is refused by the storage
   layer (`403 SignatureDoesNotMatch`); the client cannot re-sign, so it cannot
   widen its own grant. Because the client already declares its byte count, this
   is _stricter_ than a range and doubles as truncation detection;
2. **bucket `file_size_limit`** — set to the largest live per-type cap (10 MB,
   SAD §10.4's expense bill row), enforced by the storage layer with
   `413 EntityTooLarge`. **This is the one provider-specific layer of the three**:
   where the configured store offers no per-object cap — measured absent on the
   pinned local MinIO (probe 28) and not assumed of a VPS store — the portable
   guarantee rests on layers 1 and 3, which ask nothing of the provider;
3. **completion verification** — `HEAD` (`head(key)`) plus checksum and
   magic-byte checks against the object actually stored, which remain the
   authoritative record. Layer 3 is mandatory regardless of layers 1–2.

**Bucket topology: one bucket.** A bucket limit is per-bucket, so the smaller
per-type caps (8 / 5 / 3 / 2 MB for complaints, payment proof, profile photos,
visitor photos, meter photos) are carried by exact-size pinning plus API
validation against the per-type cap map, with the 10 MB bucket limit as the
backstop. The cap map lives in the API; the key layout stays SAD §10.3's
`societies/{societyId}/{entityType}/{entityId}/{attachmentId}.{ext}`.

Deletion and refusal are the last line: an object that somehow lands above the
per-type cap is never referenced by a completed attachment and is deleted by the
completion path and by the sweep (see Consequences).

#### Measurement provenance (2026-10-07)

Hosted dev project, direct storage hostname
`https://<ref>.storage.supabase.co/storage/v1/s3`, path-style addressing,
`@aws-sdk/client-s3` + `@aws-sdk/s3-presigned-post` + `@aws-sdk/s3-request-presigner`
3.1147.0. Authentication used Supabase's documented S3 session-token mode
(`accessKeyId = project_ref`, `secretAccessKey = anon key`, `sessionToken` = a
project JWT) — a server-side, RLS-bypassing mode suitable for a spike, **not** the
application's credential path; a deployed environment uses generated S3 access keys
held server-side (or the equivalent long-lived credentials for whichever
S3-compatible endpoint it targets). All spike buckets and objects were deleted
afterwards and the project's bucket list was re-verified empty — **no bucket exists
in the hosted project**, and nothing in the shipped configuration depends on
Supabase Storage at runtime.

| #   | Probe                                                             | Result                                                                                                                          |
| --- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Endpoint reachable, path-style addressing                         | OK                                                                                                                              |
| 2   | Method advertisement                                              | `OPTIONS` → `200`, `Allow: GET, HEAD, POST, OPTIONS` (bucket and object paths)                                                  |
| 3   | Presigned POST policy generation (cap 10 MB)                      | policy contains `["content-length-range",1,10485760]`, `expiration = now + 900 s`                                               |
| 4   | Within-limit upload (1 KB, cap 10 MB)                             | **200 accepted**                                                                                                                |
| 5   | **Oversized upload (10 MB + 1 byte, same signed policy)**         | **200 accepted, stored and served — `HEAD` returned `ContentLength=10485761`**                                                  |
| 6   | POST policy `eq` condition (`$x-amz-checksum-sha256`)             | enforced — mismatching field → `403 AccessDenied "Policy condition failed"`                                                     |
| 7   | POST policy expiry (`Expires: 1 s`, used 4 s later)               | enforced — `400 ExpiredToken`                                                                                                   |
| 8   | Does the checksum condition hash the bytes?                       | **No** — different bytes with the policy's signed checksum field → **200**. It pins the declaration, it does not verify content |
| 9   | Bucket `file_size_limit` (2 MB) vs a 3 MB POST                    | **enforced** — `413 EntityTooLarge "The object exceeded the maximum allowed size"`                                              |
| 10  | Presigned PUT with pinned `ContentLength` (`content-length;host`) | **enforced** — 2 MB body against a 1 KB signature → `403 SignatureDoesNotMatch`; the exact body → `200`                         |
| 11  | Presigned PUT **without** a pinned length                         | a 2 MB body → **200 accepted** (the gate is the pinning, not the method — so the pin is not optional)                           |
| 12  | `HEAD`                                                            | authoritative `ContentLength` / `ContentType` / `ETag`                                                                          |
| 13  | `DELETE`, then `HEAD`                                             | object removed; subsequent `HEAD` → `404 NotFound`                                                                              |
| 14  | Unsigned public GET                                               | refused (private-bucket existence masked)                                                                                       |
| 15  | SigV4 region                                                      | not validated — `ap-northeast-2` and `us-east-1` both accepted                                                                  |

#### Measurement provenance — MinIO (2026-10-07)

The same mechanism was then measured against a **real local MinIO** so the local
development store is not a promise. Server: the release this repository pins for
local development and the integration suite
(`bitnamilegacy/minio:2025.7.23-debian-12-r5`) running in a container on the local
Docker engine — the **local/test** provider only, never a production
recommendation. Endpoint reached path-style with
`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` 3.1147.0 and the server's own
root credentials. All probe buckets and objects were deleted afterwards and the
container removed.

| #   | Probe                                                          | Result                                                                                                                                                                         |
| --- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 16  | Presigned PUT, signed `ContentLength` = 1024, body 1024 B      | **200**; `HEAD` → `ContentLength=1024`, `ContentType=application/octet-stream`, `ETag` a quoted MD5                                                                            |
| 17  | Signed 1024 B / body **2048 B**                                | **403 `SignatureDoesNotMatch`** — and **no object was created** (`HEAD` → 404)                                                                                                 |
| 18  | Signed 1024 B / body **512 B**                                 | **403 `SignatureDoesNotMatch`** — and no object was created                                                                                                                    |
| 19  | Signed length, `Content-Length` header omitted (chunked)       | reported at the time as **`411 MissingContentLength`**; **superseded** — not reproducible on the pinned release, see the re-measurement below. Either way no object is created |
| 20  | `X-Amz-SignedHeaders=content-length;host`, `X-Amz-Expires=900` | present on the URL — the 15-minute window is expressible                                                                                                                       |
| 21  | A 1 s presign used ~3.5 s later                                | **403 `AccessDenied "Request has expired"`**                                                                                                                                   |
| 22  | `x-amz-checksum-sha256` matching the bytes                     | accepted                                                                                                                                                                       |
| 23  | Different bytes carrying the policy's checksum header          | **400 `XAmzContentChecksumMismatch`** — but the header is _not_ in `X-Amz-SignedHeaders`, so this is a client-supplied strengthening, not a signature-pinned gate              |
| 24  | Unsigned object GET                                            | **403 `AccessDenied`**                                                                                                                                                         |
| 25  | `HEAD`                                                         | authoritative `ContentLength` / `ContentType` / `ETag`                                                                                                                         |
| 26  | `DELETE`, then `HEAD`                                          | object removed; subsequent `HEAD` → 404                                                                                                                                        |
| 27  | SigV4 region                                                   | not validated — `ap-northeast-2` and `us-east-1` both accepted                                                                                                                 |
| 28  | Per-object size cap equivalent to Supabase's `file_size_limit` | **does not exist** — a 10 MB + 1 B object was accepted (200); MinIO's only aggregate cap is a bucket quota in _total_ bytes, which is not an equivalent backstop               |

#### Re-measurement of the framing cases (2026-10-07, the pinned image, T071's own suite)

Row 19's `411` could not be reproduced against the release the repository now pins,
and the omitted-length case is load-bearing documentation — so it was measured
properly, by hand, through the same `node:http` client T071's storage suite uses.
Three request framings were sent against a URL that pins the length, and the same
three against a URL that does not. Whether the earlier `411` came from a differently
framed request or a different release is not known; what is recorded here is what
was measured, twice, on the image this repository ships.

| #   | Probe                                                                            | Result                                                                                                                                                                                                                      |
| --- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 29  | **Pinned** URL, body sent with no `Content-Length` and no `Transfer-Encoding`    | **403 `SignatureDoesNotMatch`** — no object                                                                                                                                                                                 |
| 30  | **Pinned** URL, `Transfer-Encoding: chunked`                                     | **400 `BadRequest`** ("unsupported API call…") — no object                                                                                                                                                                  |
| 31  | **Pinned** URL, `Content-Length: 2048` against a 1 KB signature                  | **403 `SignatureDoesNotMatch`** — no object                                                                                                                                                                                 |
| 32  | Signed headers the SDK emits when `ContentLength` is set on a `PutObjectCommand` | `content-length;host` — **also** when `signableHeaders` is not passed, so the pin the adapter asks for is the SDK's own default for this command                                                                            |
| 33  | **Unpinned** URL (`signed=host`), 1 KB body with no framing                      | **200, and `HEAD` reports `ContentLength=0`** — an unframed body is silently discarded and an _empty_ object is stored                                                                                                      |
| 34  | **Unpinned** URL, `Transfer-Encoding: chunked`                                   | **400 `BadRequest`** — no object                                                                                                                                                                                            |
| 35  | **Unpinned** URL, a 2 MB body                                                    | **200, `ContentLength=2097152`** — probe 11 re-confirmed on the local store                                                                                                                                                 |
| 36  | The URL the SDK mints for a presigned PUT, default settings                      | carries an unsigned `x-amz-checksum-crc32` + `x-amz-sdk-checksum-algorithm=CRC32` pair computed over the **empty** body; `requestChecksumCalculation: "WHEN_REQUIRED"` removes both and leaves `content-length;host` intact |

Two consequences, both now implemented rather than recorded:

- **Row 19 is superseded, and the correction strengthens the gate rather than
  weakening it.** With `content-length` in `X-Amz-SignedHeaders`, a request that omits
  the header is not _required_ to supply one — it is _verified not to have removed it_:
  the signature itself fails (`403`). The `411` semantics only appear on a URL that
  never pinned a length, which is precisely the configuration probes 33 and 35 show
  accepting an empty object and a 2 MB one. The signatures in `ports.ts`,
  `s3-storage.provider.ts` and the storage integration suite were corrected to state
  the measured answer.
- **Row 36 is why the adapter passes `requestChecksumCalculation: "WHEN_REQUIRED"`.**
  The default is a `CRC32` of an empty body travelling on a URL handed to a client:
  unsigned, meaningless, and exactly the kind of vendor-specific extra that a
  different S3-compatible provider may choose to validate and reject. Turning it off
  restores the URL to the method, key, pin and expiry the contract describes — and the
  measured proof that it stays off is probe 36's column.

Two conclusions follow, and both are binding on the implementation:

1. **One S3-compatible adapter remains valid.** The local store and the hosted
   provider differ only in endpoint, region, credentials, bucket and
   `forcePathStyle` — no branch, no second algorithm. MinIO enforces the exact signed
   `Content-Length` in _both_ directions and for an omitted header alike (`403` larger,
   `403` smaller, `403` omitted — probes 17, 18, 29–31) and leaves no partial object
   behind on a refusal, so D1's layer 1 is the local size gate and it is genuinely
   enforced by the storage layer.
2. **The bucket `file_size_limit` is a Supabase-specific layer, not part of the
   provider contract.** It is defense-in-depth where the hosted provider offers it;
   locally the guarantee rests on layer 1 (exact-size pinning) plus layer 3
   (mandatory completion verification). Anything that assumed a bucket cap existed
   on every provider would have been wrong.

The MinIO distribution used for the probe is pinned by immutable tag in
`infra/docker/docker-compose.dev.yml`; the upstream project no longer publishes
anonymous server images, and that is recorded there and in `docs/guides/LOCAL_SETUP.md`
as replacement debt rather than quietly substituted with a different store. That
pin covers **local development and the test suite only**: it is an archived build,
it is not a production recommendation, and the S3-compatible product a VPS
deployment runs is a deployment decision still open. The adapter is provider-neutral
(`STORAGE_PROVIDER=s3` plus endpoint, region, credentials and bucket), so that
decision — like a future replacement of this pin — is configuration, not code.

**This is a documented deviation** from SAD §10.1's literal "create presigned PUT
(15 min, content-length-range enforced)" and from the Roadmap's "Presigned PUT
valid 15 minutes with a content-length range enforced": S3 presigned PUTs cannot
express a range, and the one mechanism that can — a POST policy — is not enforced
by the provider we ship on. It must be reported the way T060's deviations were.

### D2 — Plan quota is a local byte map, evaluated per society, before issuance

There is no entitlement service and no `PlanGuard` (SAD §9.4 stage 5; it is listed
as not built in `docs/guides/AUTHORIZATION.md` §7). T071 therefore owns a small
plan → byte-cap map in the API config layer (PRD §13.1: Free 500 MB, Premium
5 GB) and evaluates:

```text
sum(size_bytes) over society's completed attachments
+ sum(size_bytes) over society's non-expired outstanding presigns
<= planCap(society)
```

The reservation is derived from the attachment row itself (an upload that has not
completed), not from new infrastructure. Refusal is the existing
`PLAN_LIMIT_EXCEEDED` → **402**. Quota is **per society** (SAD §10.3's society
prefix exists precisely so quota, export and delete-on-churn are prefix
operations). A full entitlement service remains deferred; when it lands, T071's
check becomes a caller of it rather than its owner.

Quota accounting takes the `societies` row before writing the attachment row, so
the only new lock edge is `societies → attachments`. It never crosses the money
ordering (`expense → dues → member_balances`), so it cannot deadlock against
publish, recalculate, void or approve.

### D3 — `scan_status` exists and gates serving; nothing can write `clean` yet

`attachments.scan_status` ships with the SAD §10.7 values
(`pending → clean | infected | failed`) and the serving gate reads it:
`presignDownload` refuses and the API answers `409 SCAN_PENDING` or
`403 FILE_QUARANTINED`.

**No scanner exists, and no Roadmap task owns one.** If the gate were armed
without a writer for `clean`, every bill of every society would be permanently
unservable. Resolution: `clean` is written **only when a scanner is configured**;
with no scanner configured the gate is **inert** (reads still succeed), and
`409 SCAN_PENDING` / `403 FILE_QUARANTINED` are unreachable-but-shaped code paths.
Arming the gate is then configuration plus the scanner job, not a re-design.

Virus scanning and infection notification are **formally deferred**; there is no
T107-independent owner in the plan, which is recorded as a known gap rather than
silently closed.

### D4 — Routes

```text
POST   /v1/expenses/:expenseId/attachments   -> 201 {attachmentId, uploadUrl, storageKey, expiresAt}
POST   /v1/attachments/:attachmentId/complete -> 200 {status: 'processing'}
DELETE /v1/attachments/:attachmentId         -> 204
```

The upload route is expense-scoped because the only live `entity_type` in T071 is
`expense`: the permission check, the resource narrowing and the key layout all
need the expense, so taking it from the path keeps one authorization path instead
of a body field that must be re-validated. PRD §8.2's
`POST /expenses/:eid/attachments` and `DELETE /attachments/:aid` are honoured;
SAD §10.1's flat `POST /attachments/presign {entityType, entityId, …}` body is
**not** shipped — it is the generic form a later multi-entity task can add as an
alias over the same use-case. (D1's mechanism makes the response a single URL
rather than a form, so the presign response is `{attachmentId, uploadUrl,
storageKey, expiresAt}` as SAD §10.1's shape implies.)

**No list route ships in T071.** The consumers (T073 expense detail, T076 capture
flow, T132 OCR) need the presign/complete/delete trio plus a download URL;
`presignDownload(key, ttlSeconds)` ships on the port, its route is deferred.

### D5 — Authorization reuses the expense capability cells

`ACTIONS` has no `attachment.*` member and PRD §2.1 has no attachment row, so
inventing either would mean fabricating a product decision. T071 therefore reuses
the existing cells with `canOnResource` narrowing against the persisted expense:

| Operation                 | Action reused    |
| ------------------------- | ---------------- |
| presign upload            | `expense.create` |
| complete upload           | `expense.create` |
| delete attachment         | `expense.void`   |
| download (deferred route) | `expense.view`   |

Committee-Member narrowing follows the T065/T069 precedent (`snapshotOf` against
the stored row, `published: status !== 'draft'`), and every narrowed route is
added to `NARROWED_ROUTES` in `apps/api/test/route-inventory.e2e-spec.ts` with its
justification comment — an unnarrowed participant route fails that suite on
purpose. Cross-society and unknown ids are **404**, never 403. No new permission
family is introduced.

### D6 — Lifecycle

1. **Attachments may be added while the expense is `draft`, `pending_approval` or
   `published`; never while it is `void`.** A voided expense is immutable
   historical financial evidence. The refusal uses the existing
   lifecycle/conflict convention and **mutates nothing on the expense**.
2. **Attachment mutation never invalidates T070 approval.** Adding, completing or
   deleting an attachment leaves `approved_by` / `approved_at` byte-identical:
   ADR-0011 D8 protects approval against changes to approved **content and
   financial/allocation inputs**, and an attachment changes none of them — not
   `amount_paise`, category, payee, expense date, due date, participant selector,
   split strategy, split config, apartment basis, `expense_splits`, `dues` or
   `member_balances`. Proven by integration test, not by argument.
3. **Delete order: attachment row first, object second.** A stranded object is
   invisible to the application and sweepable; a stranded row pointing at a
   missing object is a broken live reference, which is worse. If the object
   deletion fails after the row is gone: do **not** recreate the row, do **not**
   report a failed transaction, log enough to sweep, and the object stays
   unreachable through application lookup. Requires an **abandoned-object sweep**
   obligation (see Consequences).
4. **Delete is permitted to the uploader or to a caller authorized to manage the
   expense** under D5's cells — not uploader-only, and never a role string
   checked inline.
5. **Hard-deleting a draft expense removes its attachments.** The polymorphic
   `(entity_type, entity_id)` pair cannot carry a real FK, so cleanup is
   application-orchestrated inside the authoritative draft-deletion workflow:
   identify the draft's attachment rows, remove their DB references as part of
   that deletion, then clean the objects. **No attachment row may survive
   pointing at a deleted draft**, and object cleanup failures become sweepable
   orphan-storage failures. Published and void expenses are never hard-deleted,
   so this rule does not extend to them.

### Cross-cutting properties (binding on the implementation)

- **T071 changes zero financial state.** No split, due, balance, `advance_paise`,
  `oldest_due_date`, `expense.amount_paise` or revision row may change. The
  integration suite asserts the money numbers byte-identical across
  add/complete/delete.
- **No `expense_revisions` row** is created by any attachment operation.
- **No new domain event.** The catalogue in SAD §3.2 is closed and contains no
  attachment event; nothing is invented.
- **T050 audit remains deferred** — the durable evidence is the attachment row
  itself (`uploaded_by`, `created_at`, `size_bytes`, `checksum`, `scan_status`).
  Download auditing is explicitly **not** available in T071.
- **T107 notification remains deferred** — including §10.7's "uploader is
  notified" on an infected file.
- **Completion replay is a 200 no-op** (idempotent), not a 409. No idempotency
  key is introduced: PRD §11.5 scopes idempotency keys to money-moving POSTs.
- **No `expectedVersion`.** Attachments are not versioned content and cannot be
  raced into a stale write.
- **`entity_type` is `expense` only** in T071, with SAD §10.4's per-type cap map
  (10 MB, jpg/png/heic/pdf) as the only live row; the `CHECK (size_bytes <=
10485760)` from SAD §8.5 backs it in the database.
- **Completion must verify checksum and magic bytes against the stored object**,
  never the extension and never the client's claim — required independently of
  the upload mechanism, and doubly so because D1's measurement showed that an
  upload-time checksum condition pins the declaration rather than hashing the
  bytes.

## Consequences

- One migration (`#33`, timestamped) creates `attachments` **merging** PRD §7.4's
  columns, SAD §8.5's indexes/`CHECK`, and SAD §10.7's `scan_status`; the
  Roadmap's `0011_attachments.sql` name violates the runner's filename pattern
  and is not used.
- Polymorphic `(entity_type, entity_id)` means no FK: integrity is
  application-enforced, which is why D6.5 exists.
- **Abandoned-presign and abandoned-object sweep** is a required obligation: a
  presign that is never completed, and an object whose row was deleted but whose
  deletion failed, both need a sweeper. T071 records the requirement; the sweeper
  may be a later task.
- The per-type cap is enforced in two places (API validation and exact-size
  pinning) and backstopped in a third (bucket limit); a change to SAD §10.4's
  table is a change to the API cap map, not to the bucket.
- Attachments are never served without a time-limited URL; no bucket is public.
- Because attachment reads are auditable only as far as the row goes, the
  "who downloaded this bill" question stays open until T050.

## Rejected alternatives

- **Presigned POST policy with `["content-length-range", 1, cap]`** — the design
  the audit recommended and this session measured: Supabase accepted a 10 MB +
  1 byte upload under a 10 MB policy and served it (D1, probe 5). It fails open on
  the provider we ship on. Its equality conditions and expiry do work, which is
  why the evidence is kept here rather than discarded.
- **Presigned PUT with a bucket limit but no signed length** — probe 11: a
  payload larger than the cap is only caught by the bucket limit, and per-type
  caps smaller than the bucket limit would not be enforced at all.
- **Proxy the upload through the API** — the SAD's own reasoning stands: a 10 MB
  body through a Node event loop doubles bandwidth, occupies the request thread
  and makes cycle-time uploads an API bottleneck.
- **Trust the declared size** — the Roadmap's own test list forbids it
  ("oversized upload rejected by the storage layer").
- **One bucket per cap class** — multiplies key prefixes, quota sums and access
  configuration to express a rule the API already knows; the bucket is a
  backstop, not the policy.
- **Invent `attachment.*` permissions or a PRD §2.1 row** — a fabricated product
  decision, and `AUTHORIZATION.md` §4 forbids the inline role check that would
  replace it.
- **Omit `scan_status`** — SAD §10.7's gate would then need a second migration
  and a re-shaped serving path; shipping the column inert is cheaper and honest.
- **Delete the object before the row** — a broken live reference is worse than an
  invisible stranded object.
- **Add an attachment domain event** — the catalogue is closed (ADR-0011 D6 took
  the same position).
- **Clear approval on attachment change (D8 extended)** — attachments are not
  approved content; doing so would force re-approval of unchanged amounts.
