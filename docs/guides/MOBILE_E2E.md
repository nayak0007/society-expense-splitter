# Mobile end-to-end tests — Maestro

The three journeys in `apps/mobile/.maestro` drive the real app on a real device or simulator.
They answer the one question the Jest suites cannot: whether the client and the API agree —
that the form writes what the detail screen reads, that Publish is offered to the roles the
matrix allows, and that a session survives the route resolver.

Legend for what has actually been run: ☐ not run · ✅ pass · ❌ fail.

## What the journeys cover

| Flow                      | Covers                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `01-signup.yaml`          | Welcome → create account → validation → submit → the post-sign-up route            |
| `02-login-email.yaml`     | Signed out → email/password → the app shell → a relaunch that proves the session   |
| `03-expense-publish.yaml` | Sign in → draft an expense through the real form → confirm → the published summary |

`subflows/sign-in.yaml` is a fragment (`runFlow`), not a flow: it is not listed in `config.yaml`,
so Maestro never runs it on its own. It still declares the same `appId` and `---` header as its
callers, because Maestro 2.x refuses a YAML file with no config section (`Config Section
Required`) even when its commands are merged into the caller.

## Prerequisites

- A build of the app installed on a device, an Android emulator or an iOS simulator. The
  flows use `launchApp.clearState`, so the app must be **installed**, not merely running in
  Expo Go — the native modules this feature set depends on (SecureStore, image picker,
  file system) behave differently there, and the app id (`com.resident360.app`) is what
  Maestro launches.
- `apps/mobile/.env` pointing at an API the device can reach. An emulator is not the host:
  `http://localhost:3000/v1` from inside an Android emulator is the emulator itself, and the
  host is `http://10.0.2.2:3000/v1`. On a **physical device over USB**, `localhost` works only
  because of the tunnel — `adb reverse tcp:3000 tcp:3000` and `adb reverse tcp:8081 tcp:8081`
  (Metro as well, since the dev build loads its bundle from it). Those mappings are
  **not sticky**: they vanish whenever adb reconnects, and the symptom is an app that starts and
  then shows _"Unable to load script"_ or an empty screen, not an obviously broken tunnel. Re-add
  them immediately before a run. Over Wi-Fi, skip the tunnel entirely: point `.env` at the host's
  LAN address (e.g. `http://192.168.0.238:3000/v1`) and start the API with `HOST=0.0.0.0`, since
  the default binds loopback only.
- **An unlocked device, kept awake.** A locked phone shows only the lock screen to the driver,
  so every selector fails (and the charging screen saver counts as a locked screen). On Android,
  unlock it and run `adb shell svc power stayon true` plus
  `adb shell settings put secure screensaver_enabled 0` before the suite. If the first assertion
  instead _hangs_ and `~/.maestro/tests/<run>/maestro.log` holds
  `UNAVAILABLE: End of stream`, the driver's port forward is missing — add
  `adb forward tcp:<port> tcp:7001` for the port that log names.
- A seeded account, in a society with active expense categories, holding **Admin or
  Treasurer** — journey 3 publishes, and `expense.publish` is those two roles (PRD §2.1).
  Journeys 2 and 3 change nothing about that account except creating one expense.
- **At least one billable flat, with somebody to charge.** Publish resolves the expense's
  participant selector against `apartments` and `members` server-side, so a society with
  categories but no structure cannot complete journey 3: the API answers `422` —
  _"The participant selector matches no billable flats in this society."_ — and the flow stops
  at its last assertion. A flat is billable when `is_billable` is true and, if it is `vacant`,
  when the society's `bill_vacant_flats` allows it; a billable flat with no primary occupant is
  refused instead, as `unassigned_participants` (T066's fail-closed rule). One building, one
  wing and one owner-occupied flat whose primary member is the seeded account is enough — and
  the seeded **staging** society is in that state as of 2026-10-19 (building `A`, flats
  `A-101`–`A-104`, all four owner-occupied and billable).
- A catch-all inbox for `MAESTRO_SIGNUP_EMAIL`: journey 1 creates an account, so its address
  is derived per run (`+run-<id>`) and must be deliverable if the project requires email
  confirmation.
- The Maestro CLI: `curl -Ls "https://get.maestro.mobile.dev" | bash`, then
  `export PATH="$HOME/.maestro/bin:$PATH"`.

## Running

```bash
cd apps/mobile

# Journeys 2 and 3 — the seeded account.
maestro test .maestro/02-login-email.yaml .maestro/03-expense-publish.yaml \
  -e MAESTRO_EMAIL="treasurer@example.com" \
  -e MAESTRO_PASSWORD="…" \
  -e MAESTRO_NAME="Asha Rao" \
  -e MAESTRO_CATEGORY="Sinking Fund" \
  -e MAESTRO_TITLE="Lift AMC - October" \
  -e MAESTRO_AMOUNT="4000"

# Journey 1 — a fresh address, because it creates the account.
maestro test .maestro/01-signup.yaml \
  -e MAESTRO_EMAIL="e2e+run-$(date +%s)@example.com" \
  -e MAESTRO_PASSWORD="…" \
  -e MAESTRO_NAME="Asha Rao"
```

`maestro test .maestro` with no arguments runs `config.yaml`'s three flows in order, which is
only correct when `MAESTRO_EMAIL` is an address that does not exist yet — that is why the CI
script runs the two groups separately (`scripts/ci/maestro.sh`).

**Run artefacts are sensitive.** Maestro writes `~/.maestro/tests/<run>/` on the machine driving
the device: `commands.json` stores every `-e` value **in plaintext** — the seeded password
included — and `maestro.log` echoes the evaluated commands. Screenshots and the screen hierarchy
capture whatever was on screen, and on a personal phone that can include notification content.
Never share or commit those directories. The CI workflow strips the credential-bearing files and
uploads only the rest, but that says nothing about what stays on a developer's machine.

### Two values that are not free choices

**`MAESTRO_AMOUNT` must be below the society's `approval_threshold_paise`.** An expense _at or
above_ the threshold is created as `pending_approval`, not `draft` (PRD §2.2, ADR-0011 D3), and a
pending expense has no publish to confirm — the journey would create a row and then find no card
to tap. The seeded society's threshold is ₹5,000, which is why the example above types `4000`
and not a round `6000`: the published summary the flow asserts is only reachable below the line.
This is the _product's_ rule being respected by the test data, not a workaround.

**Keep `MAESTRO_TITLE` ASCII on Windows.** Maestro passes `-e` values through the shell it was
launched from, and a Git Bash / `cmd` console on Windows mangles non-ASCII — an em dash arrives
at the app as `?` (or as the CLI's U+FFFD), and the flow then fails at
`Assert that "${MAESTRO_TITLE}" is visible` on a title the app rendered perfectly. A hyphen is
the same title to a reader and survives the trip; CI is Linux and unaffected.

## Selector conventions

Maestro's `text:` match is a **contains** regex, not an equality test, which is why three
conventions exist rather than one:

- **Text first, anchored where a sibling contains the label.** "Save expense", "New" and a
  category's name are tapped by their visible text. A password field is tapped as `'^Password$'`
  (and `'^Confirm password$'`), because the reveal toggle beside it carries the accessibility
  label "Show password" — an unanchored `Password` matches the toggle as well as the field.
  A test that needed a coordinate would be telling us the screen is not usable.
- **`id:` where the text is not unique or not stable.** The publish control carries
  `testID="publish-expense"` because it sits under a card whose heading is also "Publish" and
  whose native alert action is also "Publish"; `Button` gained an optional `testID` for exactly
  this case (it was the only component that could not be addressed).
- **Positional addressing for the two submit buttons that collide with a header.** The login
  screen's header title and its button are both "Log in" (and the register screen's are both
  "Create account"), so those taps are `below:` the last field rather than a bare label.

### Two labels the flows handle, and one that is a known risk

`'Expenses'` is both a tab label and (later) a screen header: the flow taps it from the home
screen, where only the tab matches. The publish card is addressed by `id`, never by its heading.

**`'Publish'` is the one genuinely ambiguous tap in the suite**, and it is called out rather
than glossed: the native confirmation's confirm action is exactly `Publish`, and so is the
publish card's heading — and Maestro matches `text:` by _contains_, so the required
`- tapOn: 'Publish'` on the alert can see more than one element. `Alert.alert` renders a native
dialog with no `testID` to address, so there is no id-based fix available on the client side.
This is therefore the **most likely first-run failure**, and it fails loudly (the tap lands on
the covered card, the dialog stays open and the `Published …` assertion times out) rather than
passing wrongly. The fix when it is observed is one of: give the card heading a distinct string
(it is decorative next to a button already labelled "Publish expense"), or replace the native
alert with the app's own confirm modal, which can carry a `testID`. Both are product decisions
for whoever sees the failure — not a coordinate, and not a weakened assertion.

## Test data, isolation and cleanup

- **Journey 1** creates one auth user per run. Its address is derived (`+run-<id>` on the
  catch-all inbox in `MAESTRO_SIGNUP_EMAIL`), so two runs never collide and no run can ever
  "already be registered".
- **Journey 3** writes one **published** expense into the seeded society. A published bill
  cannot be deleted — the API deliberately withholds that, and the product voids instead — so the
  script suffixes the title with the run id (`"<MAESTRO_TITLE> — e2e <run id>"`). That makes the
  row a run created identifiable in the ledger, and keeps two runs from colliding on a title.
  Cleanup is by voiding that run's own expense through the app (the detail screen offers it to the
  roles that may void) or by leaving it in staging; **never** by editing rows in a shared database.
- **A failed journey 3 leaves a draft behind**, not a published row: the form saves the draft
  (`Save expense`) and `main`'s cleanup path voids what was published, but an interrupted run's
  draft stays in the ledger and a later run would create a second row with the same title. Drafts
  are deletable through the app (`DELETE /expenses/:expenseId` admits them and nothing else),
  which is the tidy way to remove them between runs.
- **Journeys 2 and 3 change nothing else.** They sign in and read; the only write is the one
  expense. They do not switch societies, edit members or touch settings.
- **Device state is cleared first.** Every journey starts with `clearState: true` **and**
  `clearKeychain: true`. The second half matters on iOS: the session lives in the keychain
  (`expo-secure-store`), which `clearState` does not wipe, so a leftover session would land the
  flow inside `(app)` and its opening assertion (the welcome screen) would never appear. Without
  it, flow 01 passes once and fails after that on a simulator that has run before.

## What the flows deliberately do not assert

The publication's financial post-conditions — the split summing to the amount, one due per
participant, the balance equation and the audit row — are asserted against real PostgreSQL in
`apps/api/test/integration/expenses.integration-spec.ts`. A UI test cannot see those rows, and
a UI test that claimed to would be asserting the screen's optimism rather than the database's
state.

## CI

`.github/workflows/e2e.yml` builds the app (Android: `expo prebuild` + `assembleDebug`; iOS:
`expo run:ios` on a simulator), then calls `scripts/ci/maestro.sh`. It is **`workflow_dispatch`
only**: a real run needs a Supabase project, a reachable API and a seeded society, none of
which a pull request carries, and a red check meaning "no environment" is worse than no check.

Runtime, identified rather than implied:

|        | Android                                                                         | iOS                                  |
| ------ | ------------------------------------------------------------------------------- | ------------------------------------ |
| Runner | `ubuntu-latest` (KVM)                                                           | `macos-latest`                       |
| Target | **API 34 `google_apis` x86_64** emulator                                        | **iPhone 15** simulator              |
| Build  | `expo prebuild` + `./gradlew assembleDebug` (a debug APK, unsigned for release) | `expo run:ios --configuration Debug` |
| API    | whatever `EXPO_PUBLIC_API_URL` names — expected **staging**                     | same                                 |

Neither job starts an API, a database or a Supabase project of its own: both are prerequisites,
not something the workflow creates.

**It cannot target production by accident.** The first step of both jobs refuses to start unless
`EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` are all set
— naming whichever one is missing, instead of letting the app fail to boot later — and refuses a
`EXPO_PUBLIC_API_URL` whose **host** is exactly `api.resident360.com`, printing the host it will
use otherwise. The comparison is on the parsed
host rather than on the string, because `staging-api.resident360.com` _contains_
`api.resident360.com` — a substring test would refuse the one environment the job is for. The
refusal is deliberate rather than defensive: the journeys create an account and publish a bill,
and a published bill is not deletable.

**Static review 2026-10-19, and the four defects it found.** The workflow still has not been
dispatched, but reading it against what the device run actually needed showed it would have
failed on its first run: the debug APK was built and **never installed** on the emulator; a
debug build loads its JS from **Metro**, which the job never started; the generated
`apps/mobile/.env` omitted `EXPO_PUBLIC_RAZORPAY_KEY_ID`, which `src/constants/config.ts`
requires at module load (so the app throws before its first frame); and the upload step shipped
`~/.maestro/tests` whole. Each is fixed in the workflow — install, Metro, the environment
variable, and a strip step before the upload.

**The artefact leak was the serious one.** Maestro records every `-e` value in its run
artefacts: `commands.json` holds `MAESTRO_EMAIL` and `MAESTRO_PASSWORD` in plaintext (79 files
across the local run history, measured) and `maestro.log` echoes the evaluated commands. The
uploaded archive would therefore have carried the seeded account's password to anyone who could
download it. The workflow now deletes those files (and the `logs/` directories), then **verifies**
that no credential-bearing file name and no known secret value survives, and the upload is
**gated** on that step succeeding — a strip that fails uploads nothing rather than the raw
directory. Measured locally on the real run history: 70 files contained the seeded password
value before the step and 0 after (screenshot directories kept: 17); an injected marker control
was refused, so the check is load-bearing rather than a no-op. The retained files were also
scanned and hold no JWT, anon key, `access_token`/`refresh_token`, `Bearer` header or magic-link
token. **Treat `~/.maestro/tests` as credential-bearing**: any new `-e` value lands in it.

**What has not run, and is therefore not claimed:** neither job has been dispatched, so there is
no Android-emulator and no iOS-simulator evidence; the nightly schedule does not exist (the
workflow is manual-dispatch only, deliberately, until a dispatch passes once); and the
six-minute runtime target is unmeasured — a cold runner downloads Gradle and boots an emulator
before the flows start, so that budget is a number to re-measure, not one to assert.

**What a first dispatch still needs**, none of which lives in the repository: the secrets
`EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY` (optionally
`EXPO_PUBLIC_RAZORPAY_KEY_ID`, otherwise a public placeholder is used), `MAESTRO_EMAIL`,
`MAESTRO_PASSWORD`, `MAESTRO_NAME`, `MAESTRO_CATEGORY`, `MAESTRO_TITLE`, `MAESTRO_AMOUNT` and
`MAESTRO_SIGNUP_EMAIL` — a **deliverable** catch-all inbox, because journey 1 creates an account
and `example.com` is refused with `400 email_address_invalid`; a reachable staging API; and a
Supabase project whose sign-up confirmation setting the flows can rely on. Dispatch it manually
and read the artefact when it fails; do not add a pull-request trigger until it has passed once.

## Verification status

Journeys **2 and 3 pass on real hardware** (Pixel 10, Android 17 / API 37, arm64 dev build,
against the staging project); **journey 1 was executed on 2026-10-19 and reached the API but
could not complete** (the confirmation mail is rate-limited and unreadable), and `e2e.yml` has
never run.

| Flow                      | Status | Last run   | Notes                                                                |
| ------------------------- | ------ | ---------- | -------------------------------------------------------------------- |
| `01-signup.yaml`          | ❌     | 2026-10-19 | form and submit executed; blocked by the staging mailer's rate limit |
| `02-login-email.yaml`     | ✅     | 2026-10-19 | signed in, reached the shell, survived a relaunch                    |
| `03-expense-publish.yaml` | ✅     | 2026-10-19 | drafted, saved, confirmed, published                                 |

The run of 2026-10-19 was the first, and it did what a first run is for — every failure below is
something the flows or the app changed because of it, not something that was known in advance:

1. **The category chips were unreachable by a plain tap.** The seeded vocabulary is nineteen
   chips and `MAESTRO_CATEGORY` is seventeenth, so the flow now scrolls to it. It has to scroll
   _after_ the keyboard is dismissed: the drags that dismiss it are the ones Maestro needs, and a
   `scrollUntilVisible` that cannot scroll reports the chip missing while scrolling past it. The
   ordering in `03-expense-publish.yaml` is load-bearing and says so.
2. **The detail screen needed longer than 15 s.** It renders nothing until five reads (expense,
   splits, revisions, comments, attachments) have all landed — 5–7 s each against the staging
   API over Wi-Fi, ~13 s to first paint, measured. The save that precedes it is not free either:
   `POST /v1/expenses` measured **10.0–10.3 s over three probes**, and one device run took **89 s**
   before the row committed (the request was logged as aborted while the write still landed).
   The wait after `Save expense` is therefore **60 s** and the publish wait **45 s** (a publish
   measured 18.7 s). Both stay bounded: a screen that never renders still fails.
3. **Every expense write answered `500` against staging.** Not the flow at all: the staging
   database was three migrations behind the API build, so the write transaction's
   `public.write_audit_logs(jsonb)` — added by `20261015120000_audit_logs.sql` — did not exist,
   and `unit-of-work.ts` flushes audit rows inside the business transaction by design. Applying
   the migrations fixed it. **Apply `pnpm db:migrate` before blaming the journey**: the API's
   write path assumes HEAD, and a pending migration shows up as a generic `INTERNAL`, never as a
   schema error.
4. **Publish then refused with `422`** — _"The participant selector matches no billable flats in
   this society."_ The seeded staging society had categories and members but no buildings or
   flats, so nothing was billable. That is the prerequisite above, and the reason it is stated as
   one.

Three **app-level** defects also had to be fixed before any flow could pass, and they were found
by the same run rather than known in advance: the global providers lived under `app/providers/`,
which Expo Router treats as a route (the navigator rendered an empty screen), so they now live in
`src/providers/` as a byte-identical move; `ThemeProvider`'s root `View` had no `flex: 1`, so
every screen's `flex-1` resolved against a zero-height parent and the app was blank; and
`SecureStoreAdapter.getItem` returned the chunk **count** that `setItem` writes instead of
reassembling the parts, so no session ever restored.

The `'Publish'` ambiguity called out above — the one genuinely ambiguous tap in the suite — **did
not** bite in this run: the alert's action resolved unambiguously on Android 17. It remains the
first thing to check if journey 3 starts failing at the confirmation.

What the runs asserted beyond the screens, checkable afterwards on the seeded society: the
publication wrote **four splits of ₹1,000 summing to ₹4,000** (the flow's amount), and
`public.audit_logs` holds **`expense.created` and `expense.published`** for that expense,
recorded against `actor_role = treasurer` — the same trail the integration suite asserts, seen
there for real. (The conservation, the dues and the audit row remain integration-test
assertions; this was a read of what real runs left behind, not a substitute for them.)

After the waits above were widened, journey 3 was run again end to end and passed
(`exit=0`, every step `COMPLETED`), leaving the same shape in staging: one `published`
expense of ₹4,000, four splits of ₹1,000, and both audit rows against `treasurer`. The
wider bounds are what makes the run repeatable — at 30 s the save plus the detail reads sat
inside a single window's margin.

### Journey 1 — what was executed, and what remains

Journey 1 was run for the first time on 2026-10-19, and its first two failures were **flow
defects found by running it** (both fixed, neither by weakening an assertion):

1. **The consent row was unreachable.** It sits below two password fields while the keyboard is
   still up, so the tap failed with `Element not found` — Maestro cannot see an element behind
   Gboard. The flow now sends Back (which dismisses the keyboard while a field has focus rather
   than navigating), asserts it is still on the form, scrolls to the row by its short
   `accessibilityLabel` (`Accept the terms and privacy policy`, not the long visible sentence),
   and taps that.
2. **The submit was asserted immediately.** Both `when` branches skipped while the request was in
   flight, and the flow then failed on a secondary assertion. It now waits (bounded, 30 s) for
   the consent row to disappear — the form is replaced only when the submit actually navigated —
   so a 4xx, a 5xx or a dead API fails at the submit instead of being silently skipped.
   (`example.com` is also not a usable address: the project refuses it with
   `400 email_address_invalid`.)

The run then stopped at the API, and this is the honest boundary: **submission is covered,
completion is not.** The project has confirmation enabled and a shared built-in mailer; sign-up
answered `429 over_email_send_rate_limit` once the quota was spent, so no account was created, no
session was issued and the emailed link was never followed. The seeded identity is `…@ses.test`
— a reserved domain with no inbox — and no catch-all inbox is configured, so no automation here
can follow the link. Completing sign-up needs one of: a dedicated test project with **Confirm
email** disabled for the E2E environment, a project whose SMTP is not shared and rate-limited, or
a catch-all inbox the runner can read. Until then journey 1 proves the screen, the client-side
policy, consent, the request and the route handling — not the email round trip.

Still unverified: `e2e.yml` has never executed, journey 1 has never completed, and journey 3
covers only the add → publish → summary path — it does not attach a bill, configure a per-sqft
split, or verify dues from a resident account.

### Cleaning up after a device run

The USB tunnel and the wake settings outlive the suite while the device stays attached. Put the
phone back with:

```bash
adb shell svc power stayon false
adb shell settings put secure screensaver_enabled 1
adb reverse --remove tcp:3000
adb reverse --remove tcp:8081
adb forward --remove tcp:<port>   # the port maestro.log named
```

`adb reverse --remove-all` / `adb forward --remove-all` are the blunt alternatives. They also drop
rules another active session may be using, so prefer the targeted removals unless nothing else is
attached. The forwards and reverses belong to the device: disconnecting it removes them, and
`adb forward --list` / `adb reverse --list` show only what the currently attached device has.

Reviewed and confirmed read-only (no testID, label or screen was invented):

- `id: 'publish-expense'` exists on the publish `Button` (`ExpenseDetailScreen.tsx`).
- `'Expenses'` / `'Payments'` are the tab labels in `app/(app)/_layout.tsx`.
- The home screen's only stable copy is its `PlaceholderScreen` description, which the sign-in
  subflow asserts.
- `'Amount'`, `'Title'`, `'Full name'`, `'Email'`, `'^Password$'` and `'Expense date'` are
  `TextInput` labels, and `TextInput` sets `accessibilityLabel={label}` on the input itself.
- `'Accept the terms and privacy policy'` is the consent `Pressable`'s `accessibilityLabel`
  (`register.tsx`), which is why the flow addresses the row by that and not by its long child
  text.
- `'Save expense'`, `'New'`, `'Filter expenses'`, `'Publish expense'`, `'Create account'`,
  `'Create an account'`, `'Log in'`, `'Resend verification email'`, `'Confirm your email'`,
  `'Tell us your name'` and `'Your details'` all exist as rendered text in the screens named.
- `'Dues summary, notices and quick actions will live here.'` is the home tab's description.

Two divergences from the Roadmap are recorded here rather than hidden:

1. **T035's declared `01-signup-otp.yaml` is `01-signup.yaml`.** The app has no OTP step:
   `register.tsx` calls Supabase's `signUp` with an emailed confirmation link, and the only
   phone identity in the PRD is a future module ("Phone is not collected here — it is an
   identity with an OTP step", `app/(setup)/profile-setup.tsx`). A flow named for an OTP
   screen would have had to assert a screen that does not exist.
2. **`e2e.yml` is new, not a modification.** T035/T077 describe "modify `e2e.yml`", but
   `.github/workflows` had no such file; the harness is built from nothing, as T035's own
   status records.
