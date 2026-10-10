# Expenses (mobile) — Roadmap T073

The read-only expense list and detail surface: `GET /expenses` (filtered, cursor-paginated),
`GET /expenses/:id`, `…/splits`, `…/revisions`, `…/comments` and `…/attachments`, plus the
per-attachment download route. Nothing here writes money.

## Layout

| Path                                                              | What it is                                                   |
| ----------------------------------------------------------------- | ------------------------------------------------------------ |
| `screens/ExpenseListScreen.tsx`                                   | The ledger: filters, month grouping, infinite scroll, states |
| `screens/ExpenseDetailScreen.tsx`                                 | One expense: header, split table, revisions, notes, bills    |
| `screens/expense-list-rows.ts`                                    | Pure: month groups → the flat row list `FlashList` renders   |
| `components/ExpenseCard.tsx`                                      | One list row (+ its `StatusBadge`)                           |
| `components/SplitTable.tsx`                                       | The current split table and its conservation footer          |
| `components/RevisionChip.tsx`                                     | The "edited" chip that opens the history                     |
| `components/ExpenseFilters.tsx`                                   | The controlled filter panel + `toExpenseListQuery`           |
| `hooks/use-expenses.ts`                                           | Infinite list, month grouping, category/building options     |
| `hooks/use-expense.ts`                                            | Detail, splits, revisions, comments, attachments, download   |
| `repository/expense.repository*.ts`                               | The read-only port, its API adapter and the composition root |
| `services/expense.service.ts`                                     | Repository wiring + error → copy                             |
| `schemas/expense.schemas.ts`                                      | Labels and integer-paise/Indian-grouping formatting          |
| `__fixtures__/expense-perf-fixture.ts`                            | The deterministic 1 000-expense dataset                      |
| `screens/SplitConfiguratorScreen.tsx`                             | The split editor: strategy, per-flat values, live preview    |
| `screens/ParticipantSelectorScreen.tsx`                           | The selector: scope, building/wing/floor/occupancy, excludes |
| `components/SplitSection.tsx`                                     | The form's split summary + the two entry points              |
| `components/StrategySelector.tsx`                                 | The five strategies and the six apartment bases              |
| `components/{Percentage,Shares,CustomAmount,FloorBand}Editor.tsx` | One editor per strategy                                      |
| `hooks/use-split-preview.ts`                                      | Roster + debounced preview, offline fallback                 |
| `hooks/use-split-config.ts`                                       | `useSyncExternalStore` over the split workspace              |
| `services/split-config.store.ts`                                  | The route-safe workspace (keyed by the draft key)            |
| `services/offline-snapshot.store.ts`                              | The last resolved participant snapshot, for offline          |
| `schemas/split.schemas.ts`                                        | Editor text ⇄ the contract's integer scales + payloads       |
| `split/offline-preview.ts`                                        | `@ses/split-engine` run on-device over a snapshot            |

## `FlashList` version reconciliation

The installed major is **`@shopify/flash-list` 2.0.2**. The Roadmap's wording assumes v1's API:

- **v1** required (and auto-computed from) an `estimatedItemSize` prop.
- **v2** **measures** item sizes itself. `estimatedItemSize` is neither required nor accepted;
  passing it does nothing. The screen therefore configures sizing by **not** passing it, and
  instead supplies `getItemType` so a month header and an expense row are recycled as distinct
  component types rather than reshaped from one another.

`data` is a single flat array (`expense-list-rows.ts`) because v2 takes a flat `data` list, not
a sectioned one; month headers are rows of their own.

## Performance fixture and methodology

`__fixtures__/expense-perf-fixture.ts` builds a **deterministic** 1 000-expense dataset (seeded
mulberry32 PRNG, 24 months, four statuses, four amount magnitudes) and the same set cut into
cursor pages, so a measurement run does not first have to invent data.

The Roadmap's acceptance is _60 fps over 1 000 expenses on a low-end device_. That is a **device**
measurement and has **not** been performed here — no emulator or physical low-end Android device
is available in this environment — so the criterion is reported **UNVERIFIED**, with this method
intended for whoever runs it:

1. Load the app on the target device in a **release/`--variant release`** build (never a dev build;
   the JS dev bundle is not representative).
2. Point it at a society seeded with `makePerfExpenses(1000)`, or copy the fixture into the API's
   integration fixtures and publish it there.
3. Record a scroll with the platform profiler (`adb shell dumpsys gfxinfo <pkg> framestats`, or
   Perfetto), discard the first and last 250 ms, and report the 90th/99th-percentile frame time
   and the jank percentage.
4. The target is ≤ 16.7 ms per frame (60 fps) over the steady-state scroll window.

A Jest component test is not a substitute for this and is not reported as one.

### What _is_ measured here

Two measurements are taken in the suite and printed on every run, both on the deterministic 1 000-row
dataset. They bound the **JavaScript** cost of the surface; they say nothing about the frame rate.

| Measurement                                           | Where                          | Value (this machine, 2026-10-08)          |
| ----------------------------------------------------- | ------------------------------ | ----------------------------------------- |
| `groupExpensesByMonth` + `toRows` over 1 000 expenses | `expense-perf-fixture.test.ts` | **0.10 – 0.20 ms** (three runs)           |
| Full mount of the screen with 1 000 rows + 24 headers | `ExpenseListScreen.test.tsx`   | **1 066 / 1 120 / 1 091 ms** (three runs) |

The first is the projection the list recomputes; at ~0.15 ms it cannot be what a frame costs. The
second is deliberately larger because the `FlashList` double **mounts every row at once** — 1 000
`ExpenseCard`s in a single React pass, ~1.1 ms per row — where the real v2 list recycles a
screenful. It is therefore an upper bound on construction cost, not a frame time, and it is the
figure to re-check if the projection or the row ever becomes O(n²).

Both use `process.hrtime.bigint()`, because the React Native Jest preset replaces the global
`performance` with a mock whose `now()` returns a constant — the first version of the pipeline
measurement silently reported `0.00 ms`.

The suite's remaining perf assertions are about the dataset's **scale and integrity** (1 000 unique
ids, 40 cursor pages reassembling without duplicates, one row per expense plus its month header).

## The split configurator (T075)

The editor is **two pushed routes** that read and write one **route-safe workspace**
(`services/split-config.store.ts`), keyed by the same `user`/`society`/`expense` draft key the
form's autosave uses. Nothing travels through navigation parameters, so a large participant
snapshot cannot appear in a deep-link URL, and one member's half-configured split can never
surface in another member's form. The form seeds the workspace before the configurator can open
and mirrors it into its own four contract fields (`splitStrategy`, `apartmentBasis`, `splitConfig`,
`participantSelector`), which is also what the draft persists.

The preview is **debounced 400 ms** (`SPLIT_PREVIEW_DEBOUNCE_MS`), collapses a burst of edits into
one request, drops a slow earlier answer rather than letting it overwrite a later one, and keeps
the last good result marked stale while a newer one is in flight.

**Offline, the app runs the real engine, never an estimate:** `split/offline-preview.ts` projects
the last resolved snapshot through `computeSplit` from `@ses/split-engine` — a direct
`@ses/mobile` dependency for exactly this — and when it cannot, it says so instead of inventing
numbers: no snapshot held, a snapshot from another society, a snapshot resolved against a
different selector, or one older than its freshness bound each produce a refusal sentence.

The custom strategy is blocked until the remainder is exactly ₹0: the editor shows a live
`Remaining: ₹X` (never clamped — an over-allocation reads negative) and `splitStateProblem`
disables **Done** until the configuration is coherent, which is also how a percentage split is
held to 100% before the configurator returns.

### What is _not_ verified here (device-only)

The offline path is proven in-process (engine parity over the same facts, plus the hook's fallback
on a network failure) and **not** on a device with the radio actually off. No emulator or physical
handset is available in this environment, so these remain open and are reported as exceptions
rather than claimed:

1. Put the target device in **airplane mode**, open a draft that has resolved participants once,
   edit the split, and confirm the preview numbers match the online result for the same snapshot —
   then confirm that clearing the app data (so no snapshot is held) replaces the numbers with the
   refusal sentence instead of a fabricated split.
2. On the same device, confirm the configurator's Done button is unreachable while the remainder
   is not ₹0 and that the participant selector's controls are comfortably tappable in one hand.

A Jest component test asserts structure and behaviour; it is not a device measurement and is not
reported as one.

## Bill capture, compression, upload and viewing (T076)

Three pushed surfaces over one module-level upload register:

| Path                                    | What it is                                                      |
| --------------------------------------- | --------------------------------------------------------------- |
| `screens/BillScannerScreen.tsx`         | Camera / gallery / PDF capture, the ready list, explicit Upload |
| `screens/AttachmentViewerScreen.tsx`    | Authorized fetch, `ZoomableImage`, or a platform PDF viewer     |
| `components/AttachmentGrid.tsx`         | Stored rows (size + scan status) beside in-flight uploads       |
| `components/UploadProgress.tsx`         | One upload's step, progress and the actions its state allows    |
| `components/ZoomableImage.tsx`          | Pinch/pan over RN core `Animated` + `PanResponder` (no new dep) |
| `hooks/use-attachment-upload.ts`        | Pickers, permissions, the controller, `useAttachmentUploads`    |
| `services/attachment.service.ts`        | The compression/validation pipeline and the SHA-256             |
| `services/attachment-upload.store.ts`   | The state machine, the reservation, scope isolation, staging    |
| `services/attachment-upload.service.ts` | `runAttachmentUpload` — reserve → PUT → complete, step recovery |
| `lib/storage/files.ts`                  | Byte primitives: size, read, delete, SHA-256, raw-binary `PUT`  |
| `schemas/attachment.schemas.ts`         | T071 limits from `@ses/domain`, MIME resolution, labels, format |

Picking a file **never uploads it**: it is compressed, hashed and left `ready` until the user taps
Upload. The upload itself is reservation → raw `PUT` → completion, with a `PUT success` deliberately
**not** treated as completion. A reservation is reused across a retry (one server row, not two), and
a `confirm`-stage failure re-calls only `complete`, whose replay the API answers as a 200 no-op.
Everything is keyed `"{society}:{user}"`, so switching society or account abandons the previous
tenant's items and aborts their transports.

**Compression:** longest edge ≤ 1600 px (never upscaled), primary `q0.7`, a second pass at `q0.55`
only above the **400 KB target** (not a gate), and PDFs passed through untouched. HEIC/PNG become
JPEG because `SaveFormat.JPEG` writes new pixels — which **is** the EXIF strip and the orientation
bake-in. The SHA-256 is taken over the compressed output, i.e. the exact bytes that are uploaded and
that the presigned signature pins.

### What is _not_ verified here (device-only)

Every one of these needs real hardware, which is unavailable in this environment, so they are open
and reported as exceptions rather than claimed:

1. **Camera capture and its crop.** In-app tests drive a picker double; confirm on device that the
   system camera opens, the crop step is offered, and a denied permission shows the fallback copy
   without throwing.
2. **A real 4 MB photo uploading as under 400 KB.** Capture a genuine 4 MB JPEG/HEIC, attach it, and
   confirm the object in storage is a JPEG under 400 KB at ≤ 1600 px on its longest edge. The unit
   tests prove the pipeline's arithmetic on sized fixtures; only the device proves it on real bytes.
3. **EXIF absent from the uploaded object.** Re-download the completed object and inspect it with a
   metadata reader (`exiftool`, `identify -verbose`) to confirm no EXIF/GPS/orientation block. The
   tests prove the _format_ is a re-encode; they do not read the shipped object's tags.
4. **Upload progress accuracy** on a live, throttled network.
5. **Zoom/pan feel** in the viewer, and that a PDF opens in the platform viewer.
6. **Both themes** (light and dark) on real screens for the scanner, the grid and the viewer.

A Jest component test is not a device measurement and is not reported as one.

## Deferred: bill thumbnails

The Roadmap's detail acceptance names "bill thumbnails". They **cannot be delivered** under the
current architecture and are **not** implemented here:

- no scanner exists, so nothing writes `scan_status = 'clean'` (ADR-0012 D3 — the serving gate is
  inert, and unscanned files must not be rendered inline); and
- no thumbnail worker exists (SAD §10.3's thumbnail pipeline is not implemented by any task).

The detail screen therefore shows each bill's **metadata and scan status** with a safe,
short-lived, authorized **download** affordance — never an inline render of an untrusted original.
Delivering thumbnails requires a separate milestone: a scanner + thumbnail worker that produces a
derived, sanitised preview object, after which a thumbnail can be served like any other scanned
object. Until then this acceptance criterion is incomplete and is reported as such.
