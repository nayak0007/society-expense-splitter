# Authentication — end-to-end testing checklist

Runnable verification for the auth module: Supabase email sign-up, email
verification, password reset, profile bootstrap, session restoration, and the RLS
policies that back all of it.

Everything here is manual or SQL-driven **on purpose**. Roadmap T014 (Jest) and
T035 (Maestro) are not wired up yet — `pnpm test` is still a stub — so the
automated suite is listed under _Remaining_ at the end rather than pretended
into existence. When those land, sections 5A–5H are the cases they must cover.

Legend: ☐ not run · ✅ pass · ❌ fail (raise an issue with the device + the step
number) · ⏭️ not applicable on this device.

---

## 1. Prerequisites

- [ ] Supabase project created; `apps/mobile/.env` filled from `.env.example`
      (`EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`) — see
      `LOCAL_SETUP.md`.
- [ ] Both migrations applied, in filename order:
      `supabase/migrations/20260920120000_auth_profiles.sql`,
      `supabase/migrations/20260920120100_auth_profiles_rls.sql`.
- [ ] Auth → URL configuration: `societyexpense://auth/callback` present in
      **Redirect URLs**; Site URL set to the production web origin.
- [ ] Auth → Email: **Confirm email** enabled (the flows below assume it; with it
      off, sign-up signs the user straight in and step 5A.2 becomes ⏭️).
- [ ] Auth → Email templates for _Confirm signup_ and _Reset password_ use the
      token-hash form:
      `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=signup&redirect_to=societyexpense://auth/callback`
      The default template also works (see 5A.6), but the token-hash form is the
      one that survives mail-client link rewriting.
- [ ] Auth → Providers → Google enabled, with the iOS/Android client IDs; the
      same redirect URL allowlisted (needed for 5B.5).
- [ ] A dev build installed on a physical Android device and an iOS device
      (deep links and SecureStore behave differently from Expo Go).
- [ ] A second account available (`person2@example.com`) for the cross-user
      probes in section 6.
- [ ] SMTP configured for anything beyond testing, if reset emails must reach
      real inboxes.

## 2. Automated gates

Run from the repo root; all four must be clean before manual testing.

```bash
pnpm typecheck        # strict, including exactOptionalPropertyTypes
pnpm lint             # app + root ESLint configs
pnpm format:check     # Prettier
pnpm test             # currently a stub — see "Remaining"
```

Metro must also bundle, because a type-clean app can still fail to resolve a
module at runtime:

```bash
cd apps/mobile && pnpm exec expo export --platform android
```

- [ ] `typecheck` 0 errors
- [ ] `lint` clean (only the known non-fatal `react-native/index.js` parse noise
      from `import/no-cycle` traversal is acceptable)
- [ ] `format:check` clean
- [ ] `expo export` succeeds

## 3. Database-level verification (SQL editor)

These prove the _server_ enforces what the app assumes. Run as the SQL editor's
`postgres` role; `authenticated` is what a real client is.

**3.1 — the trigger creates a profile**

```sql
-- After signing up one account in the app:
select p.id, p.email, p.full_name, p.email_verified_at, p.is_profile_complete
  from public.profiles p
 order by p.created_at desc
 limit 5;
```

- [ ] Exactly one row per auth user; `full_name` populated from the sign-up form
- [ ] `is_profile_complete` is `false` until a name is saved, then `true`

**3.2 — a profile cannot exist without an auth user**

```sql
-- Expect: foreign key violation (23503)
insert into public.profiles (id, email) values (gen_random_uuid(), 'ghost@example.com');
```

- [ ] Rejected with `23503`

**3.3 — RLS is on, and forced**

```sql
select relname, relrowsecurity, relforcerowsecurity
  from pg_class where relname = 'profiles';
```

- [ ] Both `relrowsecurity` and `relforcerowsecurity` are `true`

**3.4 — a signed-in user sees only their own row**

```sql
-- As user A (their JWT `sub` is <uuid-a>):
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"<uuid-a>","role":"authenticated"}';

select count(*) as visible_rows from public.profiles;         -- expect 1
select count(*) as other_rows from public.profiles where id <> '<uuid-a>'; -- expect 0

rollback;
```

- [ ] `visible_rows = 1`, `other_rows = 0`

**3.5 — a user cannot write protected columns**

```sql
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"<uuid-a>","role":"authenticated"}';

-- Expect: permission denied (42501) — email is not in the column grant.
update public.profiles set email = 'stolen@example.com' where id = '<uuid-a>';
-- Expect: permission denied (42501)
update public.profiles set email_verified_at = now(), status = 'active' where id = '<uuid-a>';

rollback;
```

- [ ] Both updates rejected (`42501`) — a client cannot mark itself verified

**3.6 — a user cannot create a profile for somebody else**

```sql
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"<uuid-a>","role":"authenticated"}';

-- Expect: row-level security violation (42501 / 23514-style RLS error)
insert into public.profiles (id, email) values ('<uuid-b>', 'b@example.com');

rollback;
```

- [ ] Rejected — the `WITH CHECK` pins the row to `auth.uid()`

**3.7 — the anon key reads nothing**

```sql
set role anon;
select * from public.profiles;   -- expect: permission denied for table profiles
reset role;
```

- [ ] Denied — this is the probe that matters most, because the anon key ships
      inside the APK

## 4. Device matrix

| Case                      | Device / state                                        |
| ------------------------- | ----------------------------------------------------- |
| 5A Sign-up + verification | Android 10+ physical, iOS physical                    |
| 5B Login                  | both, plus one low-end Android (~₹8,000 class)        |
| 5C Password reset         | both, mail client on the same device and on a desktop |
| 5D Profile bootstrap      | both                                                  |
| 5E Session restore        | both, including airplane mode                         |
| 5F Verification gating    | either                                                |
| 5G Deep links             | both, cold start and warm start                       |
| 5H Logout / scope         | two devices signed in as the same user                |

## 5. Scenarios

### 5A — Sign-up and email verification

1. ☐ Welcome → **Create an account** → all fields empty → submit → field errors
   for name, email, password, confirm, and terms; no request is sent.
2. ☐ Valid details with mismatched passwords → inline "Passwords do not match"
   on the confirm field only.
3. ☐ Password `password123` → rejected by the common-password rule (shared
   contract, not a Supabase setting).
4. ☐ Password `abcdefgh` (no digit) → rejected; `abc12345` → passes.
5. ☐ Valid sign-up → lands on **Confirm your email**, showing the address typed;
   Supabase returns no session at this point.
6. ☐ Email arrives; open the link **on the device** → app opens → verify screen
   shows _Email verified_ → Continue → profile setup → app.
7. ☐ Resend: tap **Resend verification email** → success notice, button shows a
   60 s countdown and is disabled; tapping before the countdown ends is
   impossible, and after it ends a second email arrives.
8. ☐ Open an already-used confirmation link → login screen shows "That link has
   expired or has already been used", not a raw error.
9. ☐ Sign up with an email that already exists → neutral outcome (Supabase
   obfuscates; the app shows the verify screen or an "already exists" message)
   — **no indication of whether the password matched the existing account**.
10. ☐ "Use a different email" returns to sign-up with the form empty.

### 5B — Login

1. ☐ Wrong password → "Email or password is incorrect." (neutral, PRD §3.1)
2. ☐ Non-existent email → word-for-word the same message as 5B.1.
3. ☐ Correct credentials → app group; profile name appears in More.
4. ☐ Account with an unconfirmed email → routed to the verify screen with a
   resend, not left on the login form.
5. ☐ Google sign-in: browser opens, consent completes, app returns and is signed
   in. Then repeat with the sheet cancelled → no crash, calm copy.
6. ☐ Six wrong passwords in a row → rate-limit copy ("Too many attempts…"), not a
   raw Supabase code.
7. ☐ Email is trimmed and lower-cased: ` Ramesh@Example.COM` signs in as
   `ramesh@example.com`.

### 5C — Forgot / reset password

1. ☐ Forgot password with an address that exists → "If an account exists…".
2. ☐ Forgot password with an address that does not exist → **identical** copy.
3. ☐ Open the reset link on the device → app opens on **Choose a new password**.
4. ☐ Open the same link a second time → "This link is no longer valid" with a
   route to request a new one (not a form that cannot submit).
5. ☐ Open the link in a desktop browser, then copy the URL into the device →
   handled: expired-link state, because no recovery session was installed.
6. ☐ New password shorter than 8, or without a digit → rejected by the shared
   policy, with the field-level message.
7. ☐ Successful reset → "Password updated"; **all other sessions are logged
   out** (verify on the second device: its next action lands on login).
8. ☐ Sign in with the new password → works; with the old password → neutral
   failure.
9. ☐ No password value appears in any log output or on screen after submission.

### 5D — Profile bootstrap

1. ☐ A brand-new account (5A.6) lands on **Your details**, not the app.
2. ☐ Save a name → routed onward (society choice for a fresh account).
3. ☐ Delete the profile row in SQL, then reopen the app → the bootstrap
   **re-creates** it (`ensureProfile`) instead of erroring.
4. ☐ Rename via re-running profile setup → member list / More shows the new name.
5. ☐ Attempt to save a one-character name → rejected client-side and by the
   database check constraint.
6. ☐ Confirm `email_verified_at` in the row matches the auth user's
   confirmation state after verifying and after changing the email.

### 5E — Session restoration

1. ☐ Sign in, kill the app, reopen → lands directly in the app group with **no
   flash of the welcome screen** (the MMKV snapshot paints frame one).
2. ☐ Same, in airplane mode → still lands in the app (snapshot + cached session),
   no crash, no logout.
3. ☐ Cold start with no `.env`/invalid env → fail-loud error naming the missing
   variable, not a silent unauthenticated state.
4. ☐ Revoke the session from another device (Supabase dashboard → sign out all
   sessions), then reopen → the app signs out cleanly (`getUser()` returns
   401).
5. ☐ Go to background, wait ~10 minutes, return → the session is still valid and
   refresh timers have resumed (`startAutoRefresh` on foreground).
6. ☐ Verify an email in a desktop browser while the app sits on the verify
   screen, then foreground the app → the verification flag updates without a
   restart.
7. ☐ Inspect MMKV (`React Native Debugger` or a dev-build inspector): the
   snapshot holds `userId`, `email`, `emailVerified`, `savedAt` — **no token
   string anywhere**.

### 5F — Verification gating

1. ☐ Unverified account → More shows the "Verify your email" card.
2. ☐ After verifying, the card disappears on the next foreground.
3. ☐ (Server-side rule, pending T021/T046) promoting an unverified account to
   Admin or Treasurer is refused by the API — blocked today by the absence of
   the endpoint, recorded here so it is not forgotten.

### 5G — Deep links

1. ☐ `societyexpense://join?code=ABC123` cold start (app not running) → opens
   the join screen with the code prefilled.
2. ☐ Same link warm (app in background, already signed in) → same result.
3. ☐ Confirmation link cold start → verify screen, session installed.
4. ☐ Recovery link cold start → reset screen, not the welcome screen.
5. ☐ A URL that is not ours (`societyexpense://nonsense`) → ignored, no crash, app
   stays where it was.

### 5H — Logout

1. ☐ **Log out** on device A → device B stays signed in (scope `local`).
2. ☐ Log out with no network → the device still ends up signed out locally, and
   the snapshot is cleared.
3. ☐ After logout, reopen the app → welcome screen, and the previous profile name
   never flashes.

## 6. Security probes

- [ ] Extract the anon key from the built bundle and query
      `{SUPABASE_URL}/rest/v1/profiles?select=*` with it → `401`/no rows.
- [ ] Query the same endpoint with user A's access token and
      `?id=eq.<uuid-b>` → empty result, never B's row.
- [ ] `PATCH` user B's row with A's token → no rows updated (RLS `USING`).
- [ ] `PATCH` own row with `email`/`email_verified_at` → rejected by the column
      grants (`42501`).
- [ ] `DELETE` own profile row → rejected (no delete policy; erasure is
      server-side, PRD §3.1).
- [ ] Search the MMKV store and any log output for the access token, refresh
      token and password → none present.
- [ ] Confirm the login screen's copy for a non-existent account and a wrong
      password are byte-identical (account enumeration).

## 7. Remaining (not covered by this checklist)

| Item                                             | Why it is not here                                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Automated unit/integration tests                 | Jest (T014) and the API integration suite (T034) are not wired up; `pnpm test` is a stub |
| Maestro E2E flows                                | T035 — needs a dev client, a staging project and CI                                      |
| Phone OTP sign-in/verification                   | T023/T024 — needs MSG91 and DLT-registered templates                                     |
| Apple Sign-In                                    | T025/T032 — App Store guideline 4.8 requirement once Google ships on iOS                 |
| `/auth/me` with memberships                      | T027 — needs the API; the client reads `profiles` + memberships separately today         |
| Login lockout escalation (15 min → 1 h → 24 h)   | T021 — Supabase rate-limits, but the PRD's escalating lockout is its own rule            |
| Unverified accounts blocked from Admin/Treasurer | T021/T046 — server-side role rule                                                        |

## 8. Sign-off

- [ ] Sections 1–4 complete on the target commit
- [ ] All of 5A–5H executed on both platforms, findings recorded
- [ ] Section 6 clean
- [ ] Failures filed with device model, OS version and the step number
