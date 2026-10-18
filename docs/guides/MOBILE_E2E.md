# Mobile end-to-end tests — Maestro

The three journeys in `apps/mobile/.maestro` drive the real app on a real device or simulator.
They answer the one question the Jest suites cannot: whether the client and the API agree —
that the form writes what the detail screen reads, that Publish is offered to the roles the
matrix allows, and that a session survives the route resolver.

Legend for what has actually been run: ☐ not run · ✅ pass · ❌ fail.

## What the journeys cover

| Flow                      | Covers                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `01-signup.yaml`          | Welcome → create account → the form's validation surface → the post-sign-up route  |
| `02-login-email.yaml`     | Signed out → email/password → the app shell (profile, memberships, resolver)       |
| `03-expense-publish.yaml` | Sign in → draft an expense through the real form → confirm → the published summary |

`subflows/sign-in.yaml` is a fragment (`runFlow`), not a flow: it has no `appId` header and is
not listed in `config.yaml`, so it is never run on its own.

## Prerequisites

- A build of the app installed on a device, an Android emulator or an iOS simulator. The
  flows use `launchApp.clearState`, so the app must be **installed**, not merely running in
  Expo Go — the native modules this feature set depends on (SecureStore, image picker,
  file system) behave differently there, and the app id (`com.resident360.app`) is what
  Maestro launches.
- `apps/mobile/.env` pointing at an API the device can reach. An emulator is not the host:
  `http://localhost:3000/v1` from inside an Android emulator is the emulator itself, and the
  host is `http://10.0.2.2:3000/v1`.
- A seeded account, in a society with active expense categories, holding **Admin or
  Treasurer** — journey 3 publishes, and `expense.publish` is those two roles (PRD §2.1).
  Journeys 2 and 3 change nothing about that account except creating one expense.
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
  -e MAESTRO_TITLE="Lift AMC — October" \
  -e MAESTRO_AMOUNT="6000"

# Journey 1 — a fresh address, because it creates the account.
maestro test .maestro/01-signup.yaml \
  -e MAESTRO_EMAIL="e2e+run-$(date +%s)@example.com" \
  -e MAESTRO_PASSWORD="…" \
  -e MAESTRO_NAME="Asha Rao"
```

`maestro test .maestro` with no arguments runs `config.yaml`'s three flows in order, which is
only correct when `MAESTRO_EMAIL` is an address that does not exist yet — that is why the CI
script runs the two groups separately (`scripts/ci/maestro.sh`).

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

**It cannot target production by accident.** The first step of both jobs reads
`EXPO_PUBLIC_API_URL` and fails the run if it is empty or if its **host** is exactly
`api.resident360.com`, printing the host it will use otherwise. The comparison is on the parsed
host rather than on the string, because `staging-api.resident360.com` _contains_
`api.resident360.com` — a substring test would refuse the one environment the job is for. The
refusal is deliberate rather than defensive: the journeys create an account and publish a bill,
and a published bill is not deletable.

## Verification status

☐ **None of the three journeys has been executed, and `e2e.yml` has never run.** They were
authored in an environment with no emulator, no simulator, no device and no reachable API, so
what has been verified is: YAML structure (parsed, Prettier-clean), `bash -n` on the runner
script, that `config.yaml` lists exactly the three runnable journeys and no subflow, that every
referenced subflow path exists, and — for the production guard — the guard's own logic
exercised locally
as a shell snippet (staging host allowed, production host refused, empty refused, emulator host
allowed). The selector choices were checked against each screen's source, but **not** against a
rendered accessibility tree; the expected first-run failures are ambiguous matches, which is why
the anchoring and `testID` conventions above exist. The first run on hardware is the real test.

Reviewed and confirmed read-only (no testID, label or screen was invented):

- `id: 'publish-expense'` exists on the publish `Button` (`ExpenseDetailScreen.tsx`).
- `'Expenses'` / `'Payments'` are the tab labels in `app/(app)/_layout.tsx`.
- The home screen's only stable copy is its `PlaceholderScreen` description, which the sign-in
  subflow asserts.
- `'Amount'`, `'Title'`, `'Full name'`, `'Email'`, `'^Password$'` and `'Expense date'` are
  `TextInput` labels, and `TextInput` sets `accessibilityLabel={label}` on the input itself.
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
