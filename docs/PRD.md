# Society Expense Splitter — Product Requirements Document

**Version:** 1.0
**Status:** Source of truth for implementation
**Platform:** Expo (React Native) · iOS · Android · Expo Web (read-only admin views)
**Primary market:** India

> **How to read this document.** This PRD is written to be executed by an AI coding agent. Section 7 (database), Section 8 (API) and the Implementation Roadmap at the end are normative — build exactly what they specify. Sections 1–6 are behavioural specs. Where this document conflicts with a coding agent's defaults, this document wins.

---

## Table of Contents

1. [Product Vision](#1-product-vision)
2. [User Roles](#2-user-roles)
3. [Core Features](#3-core-features)
4. [Screens](#4-screens)
5. [User Flow](#5-user-flow)
6. [UX Guidelines](#6-ux-guidelines)
7. [Database Design](#7-database-design)
8. [API Design](#8-api-design)
9. [State Management](#9-state-management)
10. [Offline Support](#10-offline-support)
11. [Security](#11-security)
12. [Analytics](#12-analytics)
13. [Subscription Model](#13-subscription-model)
14. [Monetization](#14-monetization)
15. [Future Roadmap](#15-future-roadmap)
16. [Technical Stack](#16-technical-stack)
17. [Folder Structure](#17-folder-structure)
18. [Coding Standards](#18-coding-standards)
19. [Risks](#19-risks)
20. [Success Metrics](#20-success-metrics)
21. [MVP Checklist](#21-mvp-checklist)
22. [Implementation Roadmap](#22-implementation-roadmap)

---

# 1. Product Vision

## 1.1 Problem Statement

Indian residential societies run on money that nobody can see clearly.

A typical 120-flat society collects ₹2,000–₹6,000 per flat per month. That is ₹30–85 lakh a year moving through a treasurer's personal spreadsheet, a WhatsApp group, a shared Google Sheet that three people have edit access to, and a bundle of paper receipts in a committee member's cupboard. The consequences are consistent across the country:

- **Opacity breeds suspicion.** Residents cannot see what was spent, on what, or whether their own payment was recorded. Every AGM turns into an audit.
- **Collection is manual and adversarial.** The treasurer chases defaulters personally over WhatsApp. There is no shared record of who has paid, so reminders feel like accusations.
- **Handover destroys history.** Committees rotate every 1–2 years. The spreadsheet, the bank statements and the context leave with the outgoing treasurer.
- **Splitting rules are not uniform.** Lift maintenance is split by floor, water by flat area or family size, security equally, a one-off painting job by carpet area. A single "split equally" tool cannot model this.
- **Existing software is the wrong shape.** Splitwise is built for friends on a trip and has no concept of a flat, a tenant, or a recurring maintenance cycle. Full ERP-style society software (MyGate, ADDA, NoBrokerHood) is sold top-down to builders and committees at a price and onboarding cost that a 30-flat society or a 5-person roommate group will never pay.

**The gap:** there is no *bottom-up, self-serve, mobile-first* tool that a treasurer can set up alone in 20 minutes, that models Indian society realities (wings, flats, tenants, maintenance cycles, GST bills, UPI), and that is transparent to every resident by default.

## 1.2 Goals

| # | Goal | Measurable target |
|---|---|---|
| G1 | A treasurer can create a society, import flats and send invites in under 20 minutes, with no sales call. | Median time-to-first-expense < 20 min |
| G2 | Every resident can see, at any moment, exactly what they owe and why. | Dues screen loads in < 1s, offline-capable |
| G3 | Splitting logic covers ≥ 95% of real Indian society expense patterns out of the box. | 5 split strategies + per-apartment overrides |
| G4 | Collection effort drops sharply for treasurers. | ≥ 40% reduction in self-reported chase time by month 3 |
| G5 | Financial history survives committee handover. | Immutable audit log; role transfer without data loss |
| G6 | The app is usable on a ₹8,000 Android phone on a 3G connection. | Cold start < 3s, full offline read, APK < 40 MB |
| G7 | Monetization is society-level and India-priced. | Free tier viable up to 25 flats |

## 1.3 Non-Goals

Explicitly **out of scope** for v1–v3. Do not build these; do not design for them speculatively.

- **Not an accounting/ERP system.** No double-entry ledger, no Tally export, no balance sheet, no statutory audit reports. (Revisit in Phase 4 as an export, not a core model.)
- **Not a banking product.** The app never holds funds. Razorpay settles directly to the society's bank account. No wallet, no escrow, no lending.
- **Not a full security/gate-management system.** Visitor management in v1 is a lightweight log with approvals — not a replacement for a gate ERP with boom barriers, RFID or ANPR hardware.
- **Not a society-wide social network.** Notice board and complaints only. No chat, no forums, no marketplace, no classifieds in v1.
- **Not a facility booking system** (clubhouse, party hall) in v1 — Phase 3.
- **No web-first admin console** in v1. Expo Web ships read-only report views only.
- **No multi-currency.** INR only. Architecture stores currency code but ships INR.
- **No statutory compliance guarantees.** GST fields are recorded for bookkeeping, not filed.

## 1.4 Target Audience

**Primary (paying decision-maker):** The society treasurer or secretary — typically 35–60, salaried or retired, moderately tech-comfortable, currently using Excel + WhatsApp + a bank passbook. Feels the pain most acutely and personally.

**Secondary (volume users):** Residents — owners and tenants, 22–70, wide device and literacy spread. They need one screen: *what do I owe and how do I pay it*.

**Tertiary (growth wedge):** Roommate groups and small shared houses (3–8 people) in metros. They adopt for free, churn fast, but drive organic discovery and app-store ranking.

**Segments by size:**
| Segment | Flats | Buying behaviour |
|---|---|---|
| Roommates / PG | 3–8 | Free tier forever, viral |
| Small society | 8–40 | Self-serve, card/UPI, ₹ low |
| Mid society | 40–200 | Committee decision, annual plan |
| Large complex | 200–2,000 | Needs multi-building, RBAC, invoicing, sales touch |

## 1.5 User Personas

### Persona 1 — Ramesh Iyer, 52, Treasurer
*Bengaluru · 96-flat society · Retired bank manager · Android (Redmi Note), Excel power user*

Manages ₹42 lakh/year. Keeps three spreadsheets and reconciles the bank statement by hand every month. Spends ~10 hours/month on collections and another 6 on reconciliation. Posts a photo of the expense sheet to WhatsApp monthly and receives 40 replies, half of them disputes.

- **Needs:** a single source of truth, bulk reminders that do not feel personal, receipts attached to expenses, a report he can present at the AGM.
- **Fears:** being accused of mishandling money; losing data; a system so complex that residents call *him* for support.
- **Success looks like:** "I pressed one button and everyone got their bill."

### Persona 2 — Priya Nair, 34, Resident & Owner
*Pune · Working mother, IT professional · iPhone, UPI-native*

Pays maintenance by UPI when she remembers, which is late. Has no idea whether last month's payment was recorded. Suspects the security contract is overpriced but has no data.

- **Needs:** a dues screen, a pay button, a receipt, a push reminder 3 days before due date.
- **Fears:** paying twice; being publicly listed as a defaulter.
- **Success looks like:** "Zero due" badge on her dashboard.

### Persona 3 — Arjun Mehta, 26, Tenant
*Gurugram · Rents a 2BHK, shares with a flatmate · Android, price-sensitive*

Pays maintenance because his landlord's agreement says so, but is not an owner. Does not care about the sinking fund and should not be charged for it. Will move out in 11 months.

- **Needs:** visibility of only the charges applicable to tenants; a clean move-out with settled dues; visitor/delivery approvals.
- **Fears:** inheriting the previous tenant's arrears.
- **Success looks like:** correct charges, no capital-expenditure items on his bill.

### Persona 4 — Sunita Rao, 45, Committee Member (Maintenance portfolio)
*Chennai · Homemaker · Android, WhatsApp-first*

Handles complaints about the lift, the borewell and the gardener. Currently tracks them in a notebook.

- **Needs:** complaint queue assigned to her, status changes, photo evidence, a timeline she can show residents.
- **Fears:** being blamed for slow resolution when the vendor is the bottleneck.

### Persona 5 — Vikram Shah, 41, Society Admin / Secretary
*Ahmedabad · Business owner · Both platforms, delegates heavily*

Does not enter data. Approves, reviews and escalates. Signs off on the annual budget.

- **Needs:** approval queue, role management, annual report, a dashboard he can glance at.

### Persona 6 — Deepak, 29, Roommate Group Lead
*Hyderabad · 4-person shared flat · Growth wedge*

Splits rent, groceries, internet, cook and maid. Uses Splitwise but hates that it cannot do "Deepak pays 40% because he has the master bedroom" recurring monthly without re-entry.

- **Needs:** recurring expenses, percentage split, settle-up, free forever.

## 1.6 Competitive Analysis

| Product | Model | Strengths | Weaknesses we exploit |
|---|---|---|---|
| **Splitwise** | Freemium, global | Best-in-class split UX; network effects; simple | No society model (no flats/wings/tenants); no recurring maintenance cycle; no roles; no receipts workflow; no Indian payment rails depth; no complaints/notices |
| **MyGate** | B2B, sold to committees/builders | Dominant in gate security; strong brand; hardware tie-ins | Security-first, finance is secondary; heavy onboarding; needs committee buy-in and often a sales process; overkill and mispriced for <50 flats |
| **ADDA** | B2B SaaS, per-flat pricing | Deep society ERP, accounting, compliance | Dated UX; desktop-era information architecture; slow self-serve; expensive for small societies |
| **NoBrokerHood** | B2B, bundled with NoBroker | Free/subsidised via cross-sell; wide distribution | Monetises via cross-sell into brokerage/services; finance module shallow; societies dislike upsell pressure |
| **Apnacomplex** | B2B SaaS | Mature accounting; long tenure | Legacy UX; mobile is an afterthought |
| **Google Sheets + WhatsApp** | Free, incumbent | Zero cost, zero learning curve, total flexibility | No auth, no audit trail, no reminders, no receipts, breaks on handover — **this is the real competitor** |
| **Khatabook / CashBook** | Freemium ledger | Simple, Bharat-friendly UX | Single-owner ledger, not multi-party shared expense |

**Positioning statement:** *Splitwise's simplicity, with a society's structure, at India's price.* We win the long tail (5–200 units) that B2B ERPs cannot serve economically and that Splitwise cannot model structurally.

**Defensibility:** (a) split-rule engine tuned to Indian society patterns, (b) transparent-by-default ledger that residents trust, (c) bottom-up adoption that bypasses committee sales cycles, (d) switching cost from accumulated financial history.

## 1.7 Value Proposition

**For treasurers:** *Stop chasing. Press one button, everyone gets their bill, and the ledger balances itself.*

**For residents:** *Know exactly what you owe, why, and that your payment was recorded — without asking anyone.*

**For societies:** *Financial history that outlives the committee.*

Core promise in one line: **Transparent society finances, set up in 20 minutes, free for small societies.**

---

# 2. User Roles

Roles are scoped to a **society membership**, not globally to a user. One user may be a Resident in Society A and a Treasurer in Society B. Permissions are evaluated per `society_id`.

## 2.1 Role Matrix

Legend: ✅ full · 🟡 own/assigned records only · ⬜ none

| Capability | Society Admin | Treasurer | Committee Member | Resident | Tenant | Guest |
|---|---|---|---|---|---|---|
| View society dashboard | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 limited |
| Edit society profile & structure | ✅ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| Create/edit buildings, wings, apartments | ✅ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| Invite members | ✅ | ✅ | ⬜ | ⬜ | ⬜ | ⬜ |
| Approve join requests | ✅ | ✅ | ⬜ | ⬜ | ⬜ | ⬜ |
| Assign / change roles | ✅ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| Remove members | ✅ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| Create expense | ✅ | ✅ | 🟡 (draft only) | ⬜ | ⬜ | ⬜ |
| Edit/delete expense | ✅ | ✅ | 🟡 own drafts | ⬜ | ⬜ | ⬜ |
| Approve expense above threshold | ✅ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| Define split rules | ✅ | ✅ | ⬜ | ⬜ | ⬜ | ⬜ |
| View all expenses & receipts | ✅ | ✅ | ✅ | ✅ | ✅ | ⬜ |
| Record offline payment (cash/cheque/NEFT) | ✅ | ✅ | ⬜ | ⬜ | ⬜ | ⬜ |
| Mark payment verified | ✅ | ✅ | ⬜ | ⬜ | ⬜ | ⬜ |
| Pay own dues online | ✅ | ✅ | ✅ | ✅ | ✅ | ⬜ |
| View own payment history | ✅ | ✅ | ✅ | ✅ | ✅ | ⬜ |
| View others' payment status | ✅ | ✅ | ✅ | 🟡 aggregate only | 🟡 aggregate only | ⬜ |
| Create maintenance cycle / run billing | ✅ | ✅ | ⬜ | ⬜ | ⬜ | ⬜ |
| Send reminders | ✅ | ✅ | ⬜ | ⬜ | ⬜ | ⬜ |
| Post notice | ✅ | ✅ | ✅ | ⬜ | ⬜ | ⬜ |
| Post emergency notice | ✅ | ✅ | ✅ | ⬜ | ⬜ | ⬜ |
| Raise complaint | ✅ | ✅ | ✅ | ✅ | ✅ | ⬜ |
| Assign complaint | ✅ | ⬜ | 🟡 to self | ⬜ | ⬜ | ⬜ |
| Resolve complaint | ✅ | ⬜ | 🟡 assigned | 🟡 own (close) | 🟡 own (close) | ⬜ |
| Approve visitor for own flat | ✅ | ✅ | ✅ | ✅ | ✅ | ⬜ |
| Log visitor entry/exit (gate) | ✅ | ⬜ | ⬜ | ⬜ | ⬜ | ✅ (Security sub-role) |
| View reports (society-wide) | ✅ | ✅ | ✅ | 🟡 summary | 🟡 summary | ⬜ |
| Export reports (PDF/CSV) | ✅ | ✅ | ⬜ | ⬜ | ⬜ | ⬜ |
| Manage subscription & billing | ✅ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| View audit log | ✅ | 🟡 financial only | ⬜ | ⬜ | ⬜ | ⬜ |
| Delete society | ✅ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |

**Implementation note:** encode this matrix as a single `PERMISSIONS` map in `src/lib/permissions.ts`, mirrored by Postgres RLS policies. Never branch on role strings inline in components — call `can(user, 'expense.create', societyId)`.

## 2.2 Role Definitions & Workflows

### Society Admin
The owner of the society record. Exactly one primary admin is required; up to 3 admins allowed.

**Primary workflows**
1. **Onboarding:** create society → define structure (buildings → wings → floors → apartments) → bulk-add apartments → invite members → assign Treasurer.
2. **Governance:** approve join requests, assign/revoke roles, set the expense approval threshold (default ₹10,000), manage the subscription.
3. **Handover:** transfer admin rights to an incoming committee member. Old admin is demoted to Resident; all data stays with the society. **Never** allow a society to become admin-less — transfer requires the new admin to accept.

**Constraints:** cannot delete an expense that has settled payments (must reverse instead); deletion of the society requires typing the society name and a 7-day grace period with daily notice to all members.

### Treasurer
The financial operator. Usually 1, maximum 2.

**Primary workflows**
1. **Monthly billing run:** open maintenance cycle → review auto-generated charges → adjust → publish → system generates splits, dues and notifications.
2. **Expense capture:** photograph bill → OCR prefill → choose category and split rule → save → attach GST details if applicable.
3. **Collections:** view Outstanding Payments → filter by ageing bucket → send bulk reminder → record offline payments → verify UPI/bank transfers.
4. **Reconciliation:** match Razorpay settlements against recorded payments; flag mismatches.

**Constraints:** cannot change roles or society structure. Expenses above the approval threshold enter `pending_approval` and require an Admin.

### Committee Member
Portfolio holder (maintenance, security, gardens, events). Read-heavy with scoped write access.

**Primary workflows**
1. Receives complaint assignments; updates status with notes and photos; closes with resolution.
2. Drafts expenses for their portfolio (e.g. a plumber's bill) → submits to Treasurer for approval → cannot publish directly.
3. Posts notices and events.

### Resident (Owner)
The default role for a verified owner of an apartment.

**Primary workflows**
1. View dues → pay via Razorpay (UPI/card/netbanking) or record an offline payment claim → receive receipt.
2. Inspect any expense and its attached bill (full transparency is a product principle).
3. Raise a complaint and track it.
4. Pre-approve visitors and deliveries.
5. Manage family members on the apartment.

**Constraints:** sees other residents' **aggregate** payment status (e.g. "82 of 96 flats paid") but not individual defaulter names, unless the Admin enables `defaulter_list_public` (off by default — a deliberate dignity/privacy default that Admins can override per society by-laws).

### Tenant
Occupies an apartment without owning it. Linked to an apartment with `occupancy_type = 'tenant'` and an optional lease end date.

**Differences from Resident**
- Charge categories flagged `owner_only` (sinking fund, capital expenditure, corpus) are **excluded** from tenant splits and routed to the owner's dues.
- Cannot vote in polls (Phase 3) or hold committee roles by default.
- On lease expiry: membership auto-moves to `inactive`, outstanding dues are frozen and surfaced to the Admin as a move-out settlement task. Tenant retains read-only access to their own payment history for 12 months.
- Owner can see the tenant's dues status for their own apartment.

### Guest
Two distinct meanings — keep them separate in code.

**(a) Guest Viewer** — an invited non-member (a prospective buyer, an auditor, a builder's representative) with a time-boxed, read-only link scoped to specific reports. No app account required; opens a signed web view. Expires in ≤ 30 days. Cannot see individual names or contact details.

**(b) Security Guard (sub-role of Guest, `role = 'guest'`, `scope = 'security'`)** — a gate operator account. Can only: log visitor entry/exit, trigger resident approval requests, view today's expected visitors and deliveries. **No financial visibility whatsoever.** Shift-scoped; auto-logout after 12 hours.

## 2.3 Role Transitions

| From | To | Trigger | Rules |
|---|---|---|---|
| — | Resident/Tenant | Invite accepted or join request approved | Must be linked to an apartment |
| Resident | Committee Member | Admin assigns | Reversible |
| Committee Member | Treasurer | Admin assigns | Max 2 treasurers; triggers audit log entry + notification to all members |
| Treasurer | Resident | Admin revokes or committee rotation | Open cycles must be published or cancelled first |
| Admin | Resident | Admin transfer accepted by another member | Society must always have ≥ 1 admin |
| Tenant | Resident | Owner verification by Admin | Re-evaluates applicable charge categories |
| Any | Inactive | Move-out / removal | Dues frozen; history retained; login to that society blocked |

---

# 3. Core Features

Every feature below is specified as: **purpose → behaviour → rules → edge cases**. An implementing agent should be able to build the feature without asking further questions.

## 3.1 Authentication

**Purpose:** get a user into the right society with the least friction, on low-end Android, with phone number as the durable identity in India.

**Identity model:** `users.id` is the canonical identity. A user may have **both** an email and a phone number attached; either can be used to sign in, and they resolve to the same account. Phone is the preferred primary because invites, OTP and society records key off it.

### Email + Password Login
- Fields: email, password (min 8 chars, must contain a letter and a number; reject the top-1000 common passwords list bundled locally).
- On signup: send a verification email with a 24h token. Account is usable before verification but **cannot be promoted to Admin or Treasurer** until verified.
- Rate limit: 5 failed attempts per email per 15 minutes → exponential backoff lockout (15 min, 1 h, 24 h). Show a neutral error ("Email or password is incorrect") — never reveal whether the email exists.
- Session: access token 60 min, refresh token 60 days, stored in `expo-secure-store`. Silent refresh on app foreground.

### Google Login
- `expo-auth-session` + Google OAuth (iOS, Android and web client IDs).
- On first Google sign-in, if the returned email matches an existing account, **link** the provider to that account rather than creating a duplicate — but require a one-time password confirmation or OTP if the existing account has a password set (prevents account takeover via unverified email claims).
- Request scopes: `openid`, `email`, `profile` only.
- **Apple Sign-In is mandatory** on iOS if Google Login ships (App Store Guideline 4.8). Implement `expo-apple-authentication` alongside.

### OTP (Phone) Login — primary path in India
- Input: +91 default country code, 10-digit validation, auto-format.
- 6-digit OTP, valid 5 minutes, single use.
- Android auto-read via SMS Retriever API (hash appended to the message); iOS uses `textContentType="oneTimeCode"`.
- Resend: disabled for 30s, then 60s, then 120s; maximum 3 sends per number per hour, 10 per day.
- Provider: **MSG91** (DLT-registered templates, required by TRAI) with Twilio as failover. Register the template well before launch — DLT approval takes days.
- Abuse controls: device-fingerprint throttle, block known VOIP ranges, silent-fail on flagged numbers (never confirm to an attacker that a number is blocked).
- **Cost guard:** OTP costs ~₹0.15–0.25 per SMS. Prefer WhatsApp OTP via a BSP where the user has WhatsApp (Phase 2), and cache a 60-day refresh token so OTP is rarely re-sent.

### Forgot Password
- Enter email → always respond "If an account exists, we've sent a link" → email a single-use token valid 60 minutes.
- Reset screen requires the new password twice; on success invalidate **all** existing refresh tokens and notify the user by email and push.
- Phone-only accounts skip passwords entirely — offer "Sign in with OTP instead".

### Session & Multi-Society Handling
- After auth, resolve memberships. Zero → Onboarding Choice screen (Create Society / Join Society). One → land directly on that society's dashboard. Multiple → Society Switcher, with the last-used society remembered.
- `activeSocietyId` is held in a persisted Zustand store and injected into every API call as a header and into every query key.

### Edge Cases
- Number recycled by the telco and used by a new person: Admin can "detach phone" from a membership; requires re-verification.
- User deletes account while holding the sole Admin role: block until admin transfer completes.
- Account deletion: soft-delete the user, anonymise PII (`name → "Removed member"`, null phone/email), but **retain financial rows** with the anonymised reference — ledger integrity beats erasure, and this must be stated in the privacy policy and consented to at signup.

## 3.2 Society Management

### Create Society
Wizard, 4 steps, resumable (persist a draft locally):
1. **Basics:** name, type (`apartment | villa | rowhouse | shared_flat | other`), registration number (optional), address, city, state, PIN, timezone (default `Asia/Kolkata`), currency (INR, locked).
2. **Structure:** number of buildings → per building: name/number, wings, floors, flats per floor. Offer three modes:
   - *Quick:* "4 floors × 4 flats" → auto-generate `101…404`.
   - *Pattern:* choose a numbering pattern (`A-101`, `101`, `1A`, custom prefix/suffix).
   - *Manual/CSV:* paste or upload a list of flat numbers.
3. **Financial defaults:** billing cycle day (default 1st), due day (default 10th), late fee rule (none / flat ₹ / % per month, default none), default split strategy, approval threshold.
4. **Invite:** generate a join code and a shareable WhatsApp link; optionally bulk-import members by CSV (`flat_no, name, phone, email, occupancy_type`).

The creator becomes Society Admin. A `society_settings` row and a default set of expense categories and maintenance charge heads are seeded automatically.

### Join Society
Three paths:
- **Join code:** 6-character alphanumeric, uppercase, ambiguity-free alphabet (no `0/O/1/I`). Regenerable by Admin; optional expiry.
- **Deep link / QR:** `societyexpense://join?code=XXXXXX` plus an `https://` universal link fallback. QR displayed by Admin at the notice board or society gate.
- **Search:** by city + society name; produces a *request to join* (never auto-approve).

Join flow: enter code → preview society (name, city, member count) → select building/wing/flat from the actual apartment list → declare occupancy (`owner | tenant | family_member`) → submit → status `pending` → Admin/Treasurer approves → role assigned.

**Rules:** an apartment can have exactly one `primary_owner` and at most one active `primary_tenant`; additional people attach as family members. If someone claims an already-claimed flat, route it to the Admin with both claims visible — do not auto-reject.

### Invite Members
- Channels: WhatsApp (pre-filled message, the dominant channel in India), SMS, email, copy-link, QR.
- **Targeted invite:** Admin selects a specific flat and sends an invite bound to it (`apartment_id` embedded in the token) → the invitee's flat is pre-selected and auto-approved on acceptance.
- Bulk invite from CSV with a dry-run preview showing parse errors per row.
- Invite tokens expire in 14 days, are single-use, and are revocable. Track `sent → opened → accepted` for funnel analytics.

### Apartment Numbers, Buildings, Wings, Floors
Hierarchy: `Society → Building → Wing → Floor → Apartment`. Wings and floors are **optional** levels — a 6-flat building should not be forced through them. Represent as nullable fields on `apartments` plus an optional `wings` table rather than deep mandatory nesting.

Per-apartment attributes that drive billing: `apartment_number`, `floor`, `wing`, `carpet_area_sqft`, `built_up_area_sqft`, `bhk`, `parking_slots`, `occupancy_status` (`owner_occupied | rented | vacant | under_construction`), `is_commercial`, `share_units` (a manual weight for share-based splits), `is_billable`.

**Rules:** apartment numbers are unique per `(society_id, building_id, apartment_number)`. Renaming is allowed and versioned in the audit log; historical bills keep the label they were issued with. Vacant flats are billable by default for maintenance (societies usually charge them) but this is a toggle: `bill_vacant_flats`.

## 3.3 Member Management

- **Add Members:** via invite acceptance, join approval, or direct add by Admin (name + phone, creates a *shadow member* with no login until they sign up — essential, since many owners never install the app but must still be billed).
- **Remove Members:** soft removal → `status = 'removed'`, `removed_at`, `removed_by`. Blocked if the member has unsettled dues unless the Admin explicitly chooses "remove and write off" (logged, requires a reason). Financial history is never deleted.
- **Change Roles:** Admin-only. Requires a confirmation dialog stating the new capabilities. Writes an audit entry and notifies the affected member and all admins.
- **Occupancy Status:** per membership — `owner_occupied`, `tenant`, `family_member`, `vacant_owner` (owner living elsewhere). Drives which charge heads apply and who receives which notifications.
- **Family Members:** attached to an apartment, not billed separately. Fields: name, relation, age bracket, phone (optional), `can_approve_visitors`, `app_access` (if true, they get a limited Resident login with no payment rights). Cap at 8 per apartment.
- **Member Directory:** searchable list with flat number, role badge, occupancy, dues status (visible per the role matrix). Contact details hidden behind a per-member `share_contact` consent flag, default off.

## 3.4 Expense Management

### Add Expense
Fields:

| Field | Type | Required | Notes |
|---|---|---|---|
| title | string(120) | ✅ | e.g. "Lift AMC — Q3" |
| amount | decimal(12,2) | ✅ | In paise internally (`bigint`), rendered in ₹ |
| currency | char(3) | ✅ | Default INR |
| expense_date | date | ✅ | Defaults to today; cannot be > 30 days in the future |
| category_id | uuid | ✅ | From society's category list |
| paid_by_member_id | uuid | ✅ | Who actually paid (treasurer, a resident, society account) |
| payment_source | enum | ✅ | `society_account \| petty_cash \| member_paid \| vendor_credit` |
| vendor_name | string | ⬜ | |
| split_strategy | enum | ✅ | See 3.5 |
| building_id / wing | uuid/string | ⬜ | Scope the expense to a subset |
| notes | text | ⬜ | Markdown-lite, 2,000 chars |
| attachments | file[] | ⬜ | Up to 5, ≤ 10 MB each |
| gst | object | ⬜ | See below |
| is_recurring | boolean | ⬜ | Links to a recurring template |
| status | enum | ✅ | `draft \| pending_approval \| published \| void` |

**Behaviour:** the form is a single scrollable screen with a sticky "Amount" header, not a multi-step wizard — treasurers enter many expenses in a sitting. Autosave drafts every 3 seconds to local storage. On save with `status = published`, the split engine runs synchronously and creates `expense_splits` + `dues` rows in one transaction.

### Edit Expense
- Freely editable while `draft` or `pending_approval`.
- Once `published`: editing amount, split strategy or participants triggers a **recalculation** with a diff preview ("12 flats will owe ₹85 more"). Recalculation is blocked if any resulting split already has a *verified* payment exceeding the new amount — in that case the treasurer must issue a credit adjustment instead.
- Every edit creates an `expense_revisions` row (full snapshot) and an audit entry. Residents see an "edited" chip with a tap-through history. **This transparency is a core trust feature — do not make it optional.**

### Delete Expense
- Published expenses are **voided**, never hard-deleted: `status = 'void'`, `voided_at`, `voided_by`, `void_reason` (required, min 10 chars). Voiding reverses all dues; payments already made against it convert to an **advance credit** on the member's account, applied to their next due automatically.
- Drafts can be hard-deleted by their creator.

### Categories
Seeded per society, editable: Maintenance, Water, Electricity, Housekeeping, Security, Lift, Gardening, Plumbing, Electrical Repairs, Painting, Pest Control, Generator/Diesel, Festival & Events, Legal & Professional, Insurance, Bank Charges, Sinking Fund, Corpus Fund, Miscellaneous. Each category carries: `icon`, `color`, `default_split_strategy`, `is_owner_only` (excluded from tenants), `is_capital` (excluded from operating-expense trend charts), `gst_applicable`.

### Attach Bills
- Camera capture with edge detection and auto-crop, or gallery/file pick (`expo-image-picker`, `expo-document-picker`).
- Client-side compress to ≤ 1600px longest edge, JPEG q0.7, target < 400 KB. PDFs pass through untouched.
- Upload to object storage under `societies/{society_id}/expenses/{expense_id}/{uuid}.{ext}`; store only the key in the DB and serve via short-lived signed URLs (15 min).
- Offline: queue the local file URI in the outbox, upload on reconnect, show an "uploading" state on the thumbnail.
- OCR runs asynchronously post-upload and prefills amount/date/vendor/GSTIN as *suggestions* the user must accept (see 3.13).

### GST Details
For societies that receive tax invoices and want them recorded:
`gstin` (15-char, checksum-validated), `invoice_number`, `invoice_date`, `taxable_value`, `cgst`, `sgst`, `igst`, `cess`, `hsn_sac`, `place_of_supply`, `is_reverse_charge`, `itc_eligible`.

Rules: `taxable_value + taxes` must equal `amount` (warn, don't block — real invoices have rounding). Intra-state → CGST+SGST; inter-state → IGST; never both. Provide a GST summary export in reports. **We record; we do not file or advise.** Display a one-line disclaimer on the GST section.

### Notes
Free text on the expense, plus a threaded comment stream visible to all members (residents can ask "why did this cost ₹40,000?" in context, which is where most disputes actually belong). Comments are append-only with soft-delete by author or admin.

## 3.5 Expense Split

The split engine is the heart of the product. It is a **pure, deterministic, unit-tested function**:

```ts
computeSplit(input: SplitInput): SplitResult
// SplitInput  = { amountPaise, strategy, participants[], config, rounding }
// SplitResult = { allocations: { memberId, apartmentId, amountPaise, weight }[], residualPaise }
```

All money is handled as integer **paise**. Never use floats for currency anywhere in this codebase.

### Strategies

**1. Equal Split** — amount ÷ number of participants.
Example: ₹12,000 across 96 flats = ₹125.00 each.

**2. Percentage Split** — explicit percentage per participant; must total 100.00% (2 decimal places). Validation blocks save if off by more than 0.01%.
Example: Deepak 40%, three flatmates 20% each on a ₹25,000 rent.

**3. Shares (weights)** — integer or decimal share units per participant; each pays `amount × share ÷ totalShares`.
Example: 3BHK = 3 shares, 2BHK = 2 shares, 1BHK = 1 share. A ₹60,000 expense over 10×3BHK + 20×2BHK + 20×1BHK (30+40+20 = 90 shares) → 3BHK pays ₹2,000, 2BHK ₹1,333.34, 1BHK ₹666.67.

**4. Apartment Based Split** — weight derived from an apartment attribute:
  - `per_flat` (identical to equal, but scoped to flats not people)
  - `per_sqft` — `carpet_area` or `built_up_area` (the most common fair method for maintenance in India)
  - `per_bhk`
  - `per_floor_band` — e.g. lift charges: ground floor 0×, floors 1–3 1×, floors 4+ 1.5×
  - `per_parking_slot`
  - `occupied_only` — skip vacant flats

**5. Custom Split** — treasurer types an exact amount per participant. Live "remaining: ₹X" indicator; save blocked until remaining is ₹0. Supports excluding participants entirely.

### Rounding
Rule: divide in paise, floor each allocation, then distribute the residual paise **one paise at a time** to allocations in descending order of fractional remainder, tie-broken by apartment number ascending. This guarantees `Σ allocations = amount` exactly, every time, deterministically. Surface the rule in a tooltip ("₹0.01 adjustments are distributed to the largest fractional shares").

### Participant Resolution
Participants are resolved at publish time from a **selector**, not a hard-coded list:
```json
{ "scope": "society", "buildings": ["uuid"], "wings": ["A"], "floors": [1,2,3],
  "occupancy": ["owner_occupied","rented"], "excludeApartments": ["uuid"],
  "includeVacant": false, "ownerOnly": true }
```
The resolved list is **snapshotted** into `expense_splits` at publish so later membership changes never silently rewrite history.

### Automatic Due Calculation
On publish: for each allocation create/update a `dues` row (`member_id`, `apartment_id`, `expense_id`, `amount_paise`, `due_date`, `status = 'pending'`). A member's **outstanding balance** is a derived value:

```
outstanding = Σ(dues.amount) − Σ(payments.allocated_amount where verified) − Σ(credits) + Σ(late_fees)
```

Maintain a `member_balances` materialised summary refreshed transactionally on every due/payment write, so the dashboard never runs an aggregate scan. Reconcile nightly with a job that recomputes from source and alerts on drift.

### Owner vs Tenant Routing
If `category.is_owner_only` and the resolved participant is a tenant, the due is assigned to the apartment's **owner** membership instead, with `assigned_reason = 'owner_only_category'` shown on both parties' screens. If no owner membership exists, the due attaches to the apartment and shows as "unassigned" in the Treasurer's queue.

## 3.6 Payments

### Statuses
`pending` → `partial` → `paid`, plus `overdue`, `waived`, `written_off`, `advance` (credit balance).

### Online payment (Razorpay)
1. Resident taps Pay → optionally edits amount (partial allowed if the society enables `allow_partial_payments`, default on).
2. Client calls `POST /payments/intent` → server creates a Razorpay Order (`amount`, `currency`, `receipt = payment_id`, `notes = { society_id, member_id, due_ids }`) and returns `order_id` + key.
3. Razorpay React Native SDK opens the checkout (UPI intent, UPI collect, cards, netbanking, wallets). UPI intent is listed first — it is what Indians actually use.
4. On success the client posts the signature back **and** the server independently verifies the `payment.captured` webhook. **The webhook is authoritative; the client callback is only a UX accelerator.** Verify `X-Razorpay-Signature` with HMAC-SHA256 against the webhook secret.
5. Server marks the payment `verified`, allocates it across the selected dues oldest-first, updates balances, generates a receipt, pushes a notification.
6. Idempotency: `razorpay_payment_id` is UNIQUE. Replayed webhooks are no-ops.

### Offline payment
Cash, cheque, NEFT/IMPS, direct UPI to the society VPA. Two entry points:
- **Resident claims:** "I paid ₹5,000 by UPI on 3rd" + optional screenshot → `status = 'unverified'` → appears in Treasurer's verification queue → approve/reject with reason.
- **Treasurer records directly:** immediately `verified`.
Cheques carry `cheque_number`, `bank`, `cheque_date` and a `cleared` flag; uncleared cheques do not reduce outstanding.

### Partial Payment
A payment of less than the due amount sets the due to `partial` and stores `paid_amount`. Allocation order across multiple dues: **oldest due date first, then late fees, then principal** — display the allocation breakdown on the receipt so it is never a surprise.

### Payment History
Per member and per society. Filters: date range, status, method, cycle. Each row expands to the full allocation. Every verified payment generates a numbered receipt (`RCPT/{society_short}/{FY}/{0001}`) as a PDF stored in object storage, downloadable and shareable to WhatsApp. Receipt numbering is gapless per financial year — allocate numbers from a Postgres sequence inside the payment transaction.

### Refunds / Adjustments
Treasurer can issue a credit note (reason required). Razorpay refunds are initiated server-side and tracked to completion via webhook; the refund reverses the allocation and restores the due.

## 3.7 Monthly Maintenance

The recurring-billing engine. This is what makes the app *sticky* — expenses are episodic, maintenance is monthly.

### Charge Heads
A society defines reusable **charge heads**, each with: name, amount or rate, split strategy, applicability (all / building / wing / occupancy), `is_owner_only`, `is_taxable`, `active_from`, `active_to`.

Seeded heads: **Maintenance (base)**, **Water** (flat, per-head, or per-KL from meter reading), **Electricity — common area**, **Parking** (per slot; separate two-wheeler/four-wheeler rates), **Lift Maintenance** (floor-banded; ground floor often exempt), **Security**, **Housekeeping**, **Sinking Fund** (owner-only, per-sqft), **Corpus/Repair Fund** (owner-only), **Club/Amenities**, **Generator/Diesel**, **Custom Charges** (unlimited, society-defined).

### Cycle Lifecycle
`draft → generated → published → closed`
1. On the configured day (default the 1st), a scheduled job creates a `maintenance_cycles` row in `draft` for the period and materialises the per-apartment charge lines from the active heads.
2. Treasurer reviews a **preview table** (apartment × charge head × amount, with totals) and can override individual cells; overrides are logged with a reason.
3. **Publish** → creates one parent expense per charge head (or a single composite bill per flat — configurable via `bill_presentation`), generates dues, sets `due_date = cycle.due_day`, sends notifications, emails/WhatsApps a PDF bill per flat.
4. Reminders auto-fire at T−3 days, on the due date, and at T+3, T+7, T+15 for unpaid dues.
5. Late fee (if configured) is applied by a daily job after a grace period, as a separate `late_fee` due line so it is always visible and separately waivable.
6. `closed` after the next cycle publishes; closed cycles are immutable except via explicit adjustments.

### Meter-based charges
Optional per-apartment readings (`previous`, `current`, `rate_per_unit`, `reading_date`, photo of the meter). Consumption = current − previous, with a validation warning on negative or >3× rolling-average consumption (meter rollover or misread). Used for water and individual electricity.

### Arrears carry-forward
Each bill shows: previous balance + current charges + late fee − payments received = net payable. This single line resolves the majority of resident confusion.

## 3.8 Visitor Management

Lightweight by design (see Non-Goals). The point is resident convenience and a searchable log, not gate hardware.

- **Visitor Entry:** Security logs name, phone (optional), purpose, flat visiting, vehicle number, photo (optional), entry time. Or a resident **pre-approves** a visitor in advance, generating a 6-digit gate PIN valid for a time window.
- **Approval flow:** unexpected visitor → security taps "Request approval" → push notification to all app-enabled members of that flat with Approve / Deny / Call → 90-second timeout → escalate to the next family member → fall back to "waiting at gate" state. Every decision records who decided and when.
- **Delivery Tracking:** couriers/food/e-commerce. Fields: provider (Amazon, Flipkart, Swiggy, Zomato, Blinkit, other), OTP/tracking ref, `left_at_gate | delivered_to_flat | collected`. Resident gets a push when a parcel is logged and a reminder if uncollected after 4 hours.
- **Staff/daily help:** recurring entries (maid, cook, driver, milkman) with a saved profile and one-tap check-in; weekly attendance view (useful, and genuinely requested).
- **Exit logging** and an auto-close job for entries open > 12 hours.
- **Visitor log:** searchable by date, flat, name, vehicle; exportable by Admin. Retention 12 months, then auto-purge (privacy).
- **Privacy rules:** residents see only visitors for their own flat plus society-wide *aggregate* counts. Security sees today's log only, never history, never finances.

## 3.9 Notice Board

- **Announcement types:** `general`, `event`, `emergency`, `maintenance_alert` (water/power shutdown), `agm`, `poll` (Phase 3).
- Fields: title, body (rich-text-lite: bold, italic, bullets, links), attachments (≤ 3), audience selector (all / building / wing / owners / tenants / committee), `pinned`, `publish_at`, `expires_at`.
- **Emergency notices** bypass notification preferences and quiet hours, use a critical push channel, show a red banner on the dashboard, and require an explicit "Acknowledge" tap (Admin sees a read/ack count — the only place we surface per-user read state, and it is disclosed to users).
- **Events** additionally carry `starts_at`, `ends_at`, `venue`, `rsvp_enabled`, and produce an "Add to calendar" action.
- Reactions (👍 / ❤️) and threaded comments, toggleable per notice; Admin can lock comments.
- Notices are append-only with an edit history chip. Drafts and scheduling supported.

## 3.10 Complaint Management

- **Raise Complaint:** category (Plumbing, Electrical, Lift, Security, Housekeeping, Parking, Noise, Water, Common Area, Other), title, description, up to 4 photos, location (my flat / common area + free text), priority (`low | medium | high | urgent`), `is_anonymous` (visible to Admin only, never to other residents).
- **Auto-assignment:** route by category to the committee member holding that portfolio; fall back to Admin. Manual reassignment allowed with a note.
- **Status machine:** `open → acknowledged → in_progress → resolved → closed`, plus `reopened` and `rejected` (reason required). Only the raiser or an Admin may `close`; a `resolved` complaint auto-closes after 7 days of silence.
- **Resolution timeline:** an immutable, visible event stream — created, assigned, acknowledged, each status change, comments, photos, vendor visits, cost incurred. Optionally link a resolved complaint to the expense it generated (closing the loop between "the pump broke" and "₹18,000 pump repair").
- **SLA:** configurable target response and resolution hours per priority (defaults: urgent 2h/24h, high 8h/72h, medium 24h/7d, low 72h/30d). Breaches highlight in the committee queue and surface in reports. No punitive automation — societies are volunteers, not a call centre.
- **Ratings:** raiser rates resolution 1–5 with an optional comment; aggregated per committee member for the Admin's view only.

## 3.11 Reports

All reports render in-app as charts + tables and export as **PDF** (formatted for AGM presentation) and **CSV** (for the treasurer's spreadsheet). Generation happens server-side for anything spanning more than one cycle.

| Report | Contents |
|---|---|
| **Monthly Report** | Opening balance, total billed, total collected, collection %, expenses by category, top 5 expenses, closing balance, defaulter count and ageing, cash vs online split |
| **Annual Report** | FY summary (Apr–Mar), month-by-month income/expense bars, category totals with YoY %, fund positions (maintenance/sinking/corpus), collection efficiency trend, AGM-ready one-pager |
| **Expense Trends** | Category spend over time, moving average, month-on-month and year-on-year deltas, per-flat cost trend, seasonality callouts (monsoon plumbing, summer water tankers) |
| **Outstanding Payments** | Per-flat dues with ageing buckets (0–30 / 31–60 / 61–90 / 90+), total receivables, worst-ageing list, one-tap bulk reminder, exportable defaulter list (Admin/Treasurer only) |
| **Budget Analysis** | Annual budget per category vs actual, variance ₹ and %, burn rate, projected year-end position, over-budget alerts |
| **Member Statement** | Per-member ledger: all dues, payments, credits, late fees, running balance, downloadable (this is the single most requested artefact at handover) |
| **GST Summary** | Invoice-wise taxable value, CGST/SGST/IGST, ITC-eligible total, by period |
| **Collection Efficiency** | % collected within due date, average days-to-pay, trend by month |

Reports respect the role matrix: residents see society-level summaries and their own statement; individual defaulter names are gated.

## 3.12 Notifications

### Channels
| Channel | Provider | Use |
|---|---|---|
| Push | **Expo Push** → FCM (Android) / APNs (iOS) | Primary for everything |
| Email | **Resend** or AWS SES | Bills, receipts, reports, auth |
| SMS | **MSG91** (DLT templates) | OTP + critical financial reminders only (cost control) |
| WhatsApp | Meta Cloud API via a BSP (Phase 2) | Bills and reminders — highest engagement in India |
| In-app | Notification Centre | Full history, always the source of truth |

### Event → Channel Matrix (defaults)
| Event | Push | Email | SMS | In-app |
|---|---|---|---|---|
| New bill generated | ✅ | ✅ | ⬜ | ✅ |
| Due reminder T−3 | ✅ | ⬜ | ⬜ | ✅ |
| Due date today | ✅ | ⬜ | ⬜ | ✅ |
| Overdue T+7 / T+15 | ✅ | ✅ | ✅ (T+15) | ✅ |
| Payment received / receipt | ✅ | ✅ | ⬜ | ✅ |
| Payment verification needed (Treasurer) | ✅ | ⬜ | ⬜ | ✅ |
| New expense published | ✅ | ⬜ | ⬜ | ✅ |
| Expense edited/voided | ✅ | ⬜ | ⬜ | ✅ |
| Notice posted | ✅ | ⬜ | ⬜ | ✅ |
| **Emergency notice** | ✅ critical | ✅ | ✅ | ✅ |
| Complaint status change | ✅ | ⬜ | ⬜ | ✅ |
| Complaint assigned (member) | ✅ | ⬜ | ⬜ | ✅ |
| Visitor approval request | ✅ high-priority | ⬜ | ⬜ | ✅ |
| Delivery at gate | ✅ | ⬜ | ⬜ | ✅ |
| Role changed | ✅ | ✅ | ⬜ | ✅ |
| Monthly report ready | ✅ | ✅ | ⬜ | ✅ |

### Rules
- **Quiet hours** 22:00–07:00 IST: non-urgent pushes are queued to the next morning. Emergency and visitor-approval bypass.
- Per-user, per-category preferences with channel toggles. Digest option (daily/weekly) for low-priority categories.
- Deep-link payload on every push (`{ type, entityId, societyId }`) routing straight to the relevant screen.
- Batching: never send more than 3 pushes per user per hour for non-critical events; collapse into "5 new expenses were added".
- Delivery tracking: store `sent/delivered/opened` per notification; retry failed pushes once; prune invalid Expo tokens on `DeviceNotRegistered`.

## 3.13 AI Features

AI is a **layer on top of a correct ledger, never a substitute for it**. Every AI output is labelled, explainable, reversible, and never auto-commits a financial change without human confirmation.

### Tier 1 — MVP-adjacent (Phase 2)

**1. Bill OCR & Receipt Scanning.** Photograph a bill → extract amount, date, vendor, GSTIN, invoice number, HSN, line items → prefill the expense form as *suggestions* with per-field confidence. User taps to accept. Pipeline: on-device ML Kit text recognition for a fast local guess, then a server-side vision model (Claude/Gemini) for structured extraction of messy Indian invoices (handwritten receipts, thermal prints, bilingual text). Target: ≥ 90% field accuracy on printed invoices, ≥ 65% on handwritten. **Always show the original image next to the extracted fields.**

**2. Duplicate Expense Detection.** On save, flag likely duplicates using a composite signal: amount within ±2%, date within 7 days, vendor string similarity (trigram/Levenshtein), same category, similar attachment hash (perceptual hash on the bill image). Show a non-blocking warning: "This looks like the ₹18,500 plumbing bill added on 12 Sep — still add it?" Catches the classic double-entry after a committee handover.

**3. Expense Anomaly Detection.** Per category, maintain a rolling 12-month distribution. Flag values beyond the 90th percentile or 2σ, plus step-changes in recurring vendors. Message with context: "Security cost ₹68,000 this month, 34% above the 6-month average of ₹50,700." Anomalies appear in the Treasurer dashboard and the monthly report, never as an accusation to residents.

### Tier 2 — Differentiators (Phase 3)

**4. Predict Monthly Maintenance.** Forecast next month's and next quarter's total and per-flat maintenance using seasonal decomposition over 12+ months of history (a simple seasonal-naive + trend baseline beats an LLM here; use the model only to *explain* the forecast). Output: point estimate with a confidence band and the top 3 drivers ("water tanker spend rises 40% in Apr–Jun"). Requires ≥ 6 cycles of data; hide the feature until then rather than showing a bad forecast.

**5. AI Financial Insights.** A monthly digest card generated from the society's own aggregates: collection efficiency trend, categories drifting above budget, ageing concentration ("₹2.1 lakh of the ₹2.8 lakh outstanding sits in 6 flats"), and 2–3 concrete suggested actions. Written in plain language, with every number click-through-able to its source rows. Send only aggregated, de-identified figures to the model — never raw member PII.

**6. Natural Language Search.** "Show me plumbing expenses above ₹5,000 last quarter", "who hasn't paid since July", "how much did we spend on the lift in FY24-25". The LLM translates to a **constrained query DSL** (a JSON filter object), which the backend validates against the user's permissions before execution — the model never emits SQL and never sees data it is not entitled to. Show the interpreted filter as editable chips so the user can see and correct what the AI understood.

**7. AI Assistant ("Ask your society").** An in-app chat scoped to the active society and the user's permissions. Answers: "what do I owe and why", "when is the next AGM", "explain this charge", "how do I add a tenant". Grounded via retrieval over the society's expenses, notices, bylaws and this app's help content; always cites the record it used. Treasurer mode additionally handles "draft a reminder message to 90+ day defaulters" and "summarise last quarter for the AGM". Hard rules: no financial mutations, no cross-society data, refuse and hand off on anything legal or tax-advisory.

### Tier 3 — Exploratory (Phase 4)
**8. Smart reminder timing** — learn per-member the hour/day at which payment most often follows a reminder, and send then (bounded to civil hours).
**9. Vendor benchmarking** — anonymised, aggregated cross-society medians: "societies of your size in Pune pay ₹38–52 per flat for housekeeping." Opt-in, k-anonymity ≥ 20 societies, city-level only.
**10. Bylaw Q&A** — upload the society's registered bylaws; answer governance questions with citations and an explicit "this is not legal advice" boundary.
**11. Complaint triage** — auto-categorise, set priority, detect duplicate complaints about the same issue, and cluster ("7 flats in B wing reported low water pressure today — likely a pump issue").

### AI Governance (applies to all of the above)
- Label every AI-generated element with a consistent badge and a "How was this generated?" sheet.
- No AI output writes to the ledger without an explicit human tap.
- Store a `ai_suggestions` row for every suggestion with accepted/rejected outcome — this is both the audit trail and the training signal for improving prompts.
- Per-society opt-out toggle for all AI features; default on for Tier 1, off for Tier 3.
- PII minimisation: strip names, phone numbers and flat identifiers before any external model call unless the feature inherently requires them and the user initiated it.
- Cost control: cache OCR results by image hash; rate-limit assistant queries (20/user/day free, 200 on paid); use a small model for classification and a large one only for generation.

---

# 4. Screens

Screens are grouped by navigator. Route names use kebab-case file paths under Expo Router; components use PascalCase.

## 4.1 Bootstrap & Auth Stack
| # | Screen | Purpose |
|---|---|---|
| 1 | **Splash** | Logo, token restore, version/force-update check, route decision |
| 2 | **Onboarding Carousel** | 3 slides, value prop; first launch only, skippable |
| 3 | **Welcome / Auth Choice** | Continue with Phone · Google · Apple · Email |
| 4 | **Login (Email)** | Email + password, forgot link |
| 5 | **Signup (Email)** | Name, email, password, T&C consent |
| 6 | **Phone Entry** | Country code + number |
| 7 | **OTP Verify** | 6-box input, autofill, resend timer |
| 8 | **Forgot Password** | Email entry, confirmation state |
| 9 | **Reset Password** | New password × 2 (deep-link entry) |
| 10 | **Profile Setup** | Name, photo, language |

## 4.2 Society Onboarding Stack
| # | Screen | Purpose |
|---|---|---|
| 11 | **Society Choice** | Create a society / Join a society |
| 12 | **Create Society — Basics** | Step 1 |
| 13 | **Create Society — Structure** | Step 2: buildings/wings/floors/flats generator |
| 14 | **Apartment Generator Preview** | Editable grid of generated flats |
| 15 | **Create Society — Financial Defaults** | Step 3 |
| 16 | **Create Society — Invite** | Step 4: join code, QR, WhatsApp share, CSV import |
| 17 | **Join Society** | Enter code / scan QR / search |
| 18 | **Society Preview & Flat Select** | Confirm society, pick building/wing/flat, occupancy |
| 19 | **Join Pending** | Waiting-for-approval state with status |
| 20 | **Society Switcher** | Bottom sheet listing memberships |

## 4.3 Main Tabs
Tabs: **Home · Expenses · Payments · Community · More**

### Home
| # | Screen |
|---|---|
| 21 | **Dashboard (Resident)** — dues card, pay CTA, recent expenses, notices, quick actions |
| 22 | **Dashboard (Treasurer/Admin)** — collection %, outstanding, cycle status, approval queue, anomalies |
| 23 | **Notification Centre** |
| 24 | **Notification Detail / Deep-link resolver** |

### Expenses
| # | Screen |
|---|---|
| 25 | **Expense List** — filters, search, grouping by month/category |
| 26 | **Expense Details** — amount, bill viewer, split table, comments, revision history |
| 27 | **Expense Form (Add/Edit)** |
| 28 | **Category Picker** |
| 29 | **Split Configurator** — strategy selector + per-participant editor |
| 30 | **Participant Selector** — scope by building/wing/floor/occupancy |
| 31 | **Bill Scanner (Camera)** — capture, crop, OCR progress |
| 32 | **OCR Review** — extracted fields vs original image |
| 33 | **GST Details Form** |
| 34 | **Attachment Viewer** — zoom/pan images, PDF viewer |
| 35 | **Expense Approval Queue** (Admin) |
| 36 | **Recurring Expense Templates** |

### Payments
| # | Screen |
|---|---|
| 37 | **My Dues** — itemised, select-to-pay |
| 38 | **Pay Now** — amount, method, Razorpay handoff |
| 39 | **Payment Success / Failure** |
| 40 | **Payment History (Mine)** |
| 41 | **Receipt Viewer** — PDF, share |
| 42 | **Record Offline Payment** |
| 43 | **Payment Verification Queue** (Treasurer) |
| 44 | **Outstanding Payments / Defaulters** (Treasurer) |
| 45 | **Member Statement / Ledger** |
| 46 | **Maintenance Cycles List** |
| 47 | **Cycle Preview & Publish** — apartment × charge-head grid |
| 48 | **Charge Heads Setup** |
| 49 | **Meter Readings Entry** |
| 50 | **Send Reminders** — audience, channel, message preview |

### Community
| # | Screen |
|---|---|
| 51 | **Notice Board** |
| 52 | **Notice Detail** |
| 53 | **Notice Composer** |
| 54 | **Events List / Event Detail (RSVP)** |
| 55 | **Complaints List** — mine / assigned / all |
| 56 | **Complaint Details** — timeline, comments, photos |
| 57 | **Raise Complaint** |
| 58 | **Visitor Management** — today's log, expected |
| 59 | **Visitor Entry Form** (Security) |
| 60 | **Pre-approve Visitor** (Resident) |
| 61 | **Visitor Approval Prompt** — full-screen, from push |
| 62 | **Delivery Log** |
| 63 | **Daily Staff Attendance** |

### More
| # | Screen |
|---|---|
| 64 | **More Menu** |
| 65 | **Reports Hub** |
| 66 | **Report Viewer** — chart + table + export |
| 67 | **Budget Setup & Analysis** |
| 68 | **Society Members Directory** |
| 69 | **Member Detail** — role, apartment, dues, history |
| 70 | **Add / Invite Member** |
| 71 | **Join Requests Queue** |
| 72 | **Role Management** |
| 73 | **Apartments Management** |
| 74 | **Building / Wing Management** |
| 75 | **Family Members** |
| 76 | **Society Settings** — profile, billing config, split defaults, feature toggles |
| 77 | **Profile** |
| 78 | **Edit Profile** |
| 79 | **Notification Preferences** |
| 80 | **Subscription & Plans** |
| 81 | **Payment Methods / Society Bank Details** |
| 82 | **AI Assistant Chat** |
| 83 | **Natural Language Search** |
| 84 | **AI Insights** |
| 85 | **Audit Log** (Admin) |
| 86 | **Help & FAQ** |
| 87 | **Contact Support** |
| 88 | **About / Legal** — T&C, privacy, licences |
| 89 | **Language Selection** |
| 90 | **Appearance** — theme, text size |

## 4.4 System / Utility Screens
| # | Screen |
|---|---|
| 91 | **Offline Banner + Sync Status Sheet** |
| 92 | **Global Error / Retry** |
| 93 | **Empty States** (per list, illustrated) |
| 94 | **Force Update** |
| 95 | **Maintenance Mode** |
| 96 | **Paywall / Upgrade Prompt** |
| 97 | **Permission Denied** |
| 98 | **Search (global)** |
| 99 | **Image Cropper** |
| 100 | **Confirm Destructive Action** (reusable sheet) |

---

# 5. User Flow

## 5.1 Navigation Architecture

```
RootLayout
├── (bootstrap)          Splash → version check → token restore
├── (auth)               Stack — unauthenticated
│    ├── onboarding, welcome, login, signup
│    ├── phone → otp
│    └── forgot-password → reset-password
├── (setup)              Stack — authenticated, no active society
│    ├── profile-setup
│    ├── society-choice
│    ├── create/[step]
│    └── join → preview → pending
└── (app)                Tabs — authenticated + active society
     ├── home/        (dashboard, notifications)
     ├── expenses/    (list, [id], new, split, scan)
     ├── payments/    (dues, history, cycles, outstanding)
     ├── community/   (notices, complaints, visitors)
     └── more/        (reports, members, settings, ai, admin)
Modals (presented over any stack): pay-now, visitor-approval, society-switcher,
attachment-viewer, confirm-destructive, paywall
```

**Routing decision on launch:**
```
Splash
 ├─ no token ................................ → (auth)/welcome
 ├─ token invalid/expired & refresh fails ... → (auth)/welcome  [toast: session expired]
 ├─ token ok, profile incomplete ............ → (setup)/profile-setup
 ├─ token ok, 0 memberships ................. → (setup)/society-choice
 ├─ token ok, only pending membership ....... → (setup)/join-pending
 ├─ token ok, 1 membership .................. → (app)/home
 └─ token ok, N memberships ................. → (app)/home with lastUsedSocietyId
```

## 5.2 Key Journeys

### A. New Treasurer — first society (target: < 20 min)
`Splash → Onboarding → Welcome → Phone Entry → OTP Verify → Profile Setup → Society Choice → Create Basics → Create Structure → Apartment Preview (edit) → Financial Defaults → Invite (share code to WhatsApp) → Dashboard(Treasurer) → [empty state CTA "Add your first expense"] → Expense Form → Bill Scanner → OCR Review → Split Configurator → Save → Expense Details`

Back behaviour: each wizard step pops to the previous with the draft preserved; exiting the wizard prompts "Save draft?".

### B. Resident joins and pays
`Welcome → Phone → OTP → Profile Setup → Society Choice → Join → enter code → Society Preview → select Wing A / Flat 302 / Owner → Submit → Join Pending → [push: approved] → Dashboard → Dues card "₹4,250 due in 3 days" → My Dues → select lines → Pay Now → Razorpay sheet (UPI) → Payment Success → Receipt Viewer → share to WhatsApp → back to Dashboard (now "No dues")`

Failure path: Razorpay failure → Payment Failure screen with the failure reason, a Retry CTA and "Pay another way" (offline claim). Never lose the selected dues on retry.

### C. Monthly billing run
`Dashboard(Treasurer) → banner "October cycle ready to review" → Maintenance Cycles → Cycle Preview (grid) → edit two overrides → Publish (confirm sheet showing totals and recipient count) → progress → Success → auto-navigate to Outstanding Payments`
System side-effects: dues created, bills PDF'd, pushes + emails dispatched, reminders scheduled.

### D. Complaint end to end
`Dashboard → Community tab → Complaints → Raise Complaint → category Plumbing, photos, priority High → Submit → Complaint Details (status open)` → *[committee member]* `push → Complaint Details → Assign to self → Acknowledge → In Progress + note "plumber visiting Thu" → Resolved + photo` → *[raiser]* `push → rate 4★ → Close`

### E. Visitor approval (from locked phone)
`Push (high priority, actionable) → tap → Visitor Approval Prompt (full-screen modal, photo, name, purpose) → Approve → security notified → auto-dismiss`. If the app is killed, the deep link cold-starts the app straight into the modal after auth restore.

### F. Adding an expense offline
`Expense Form (offline banner visible) → fill → attach photo → Save → optimistic insert into local SQLite, "Pending sync" chip on the row → [connectivity returns] → outbox flushes → attachment uploads → server IDs reconciled → chip clears → if conflict: Sync Conflict sheet`

### G. Society switching
Long-press society name in the header or `More → Switch Society` → bottom sheet → select → all query caches keyed by `societyId` swap; no logout, no reload.

## 5.3 Navigation Rules
- **Tab state is preserved** per tab; switching tabs never resets a scroll position or an open form.
- **Deep links** must resolve for every entity: `/expenses/[id]`, `/payments/receipt/[id]`, `/complaints/[id]`, `/notices/[id]`, `/visitors/approve/[id]`. If the user is not authenticated, store the intent, authenticate, then continue to the target.
- **Destructive actions** always use a confirmation sheet naming the consequence and the affected count.
- **Hardware back on Android**: within a tab, pop the stack; at a tab root, switch to Home; at Home, double-tap to exit with a toast.
- **Role-aware rendering:** a resident never sees an admin-only route in the UI *and* the route itself guards with `can()` — hiding is not securing.
- **Paywall interception:** premium routes check entitlement and present the Paywall modal rather than blocking navigation outright, with the feature's value stated in context.

---

# 6. UX Guidelines

## 6.1 Design Principles
1. **Trust through visibility.** Every number is tappable down to its source. Edits show as edits. Nothing financial is ever silently changed.
2. **The treasurer is doing data entry; the resident is checking one number.** Optimise those two jobs ruthlessly and differently.
3. **Assume a bad network and a cheap phone.** Offline is the default assumption, not an error state.
4. **Money is serious; the UI should be calm.** No confetti on a ₹40,000 bill. Restrained motion, clear hierarchy, generous tap targets.
5. **Indian context is not a localisation afterthought.** ₹ formatting with the lakh/crore grouping, DD/MM/YYYY, Apr–Mar financial year, UPI-first payment order.

## 6.2 Material Design 3
- **Library:** `react-native-paper` v5 (MD3) as the component base, with a custom theme. Do not mix component libraries.
- **Colour:** MD3 dynamic tonal palettes generated from a seed. Seed `#2E7D5B` (a calm green — money, growth, not alarm). Full light and dark schemes generated via `material-color-utilities`. Support Android 12+ dynamic colour (Material You) behind a user toggle, defaulting off so the brand stays stable.
- **Semantic roles:** `primary` for CTAs, `error` for overdue/destructive, `tertiary` for AI-generated surfaces, `secondaryContainer` for informational chips. Map dues states to fixed semantic tokens: paid = success green, partial = amber, overdue = error red, advance = blue.
- **Type scale:** MD3 scale (`displaySmall` … `labelSmall`). Font: **Inter** for Latin + **Noto Sans Devanagari** for Hindi/Marathi, loaded via `expo-font`. Tabular figures (`fontVariant: ['tabular-nums']`) everywhere money is shown — misaligned rupee columns read as sloppy bookkeeping.
- **Shape:** 12dp corner radius on cards, 20dp on sheets, fully rounded on chips and FABs.
- **Elevation:** level 1 for cards, level 2 for the FAB, level 3 for bottom sheets. Prefer tonal surfaces over heavy shadows.
- **Components used:** `Card`, `List.Item`, `Chip`, `SegmentedButtons`, `FAB` (extended on Expenses), `Snackbar` (not Alert) for feedback, `BottomSheet` for pickers, `DataTable` for the cycle grid, `ProgressBar` for collection %.

## 6.3 Minimal & Modern
- One primary action per screen. The FAB on list screens; a single sticky bottom CTA on forms.
- Cards over borders; whitespace over dividers. Maximum 3 visual weights per screen.
- Numbers lead; labels follow, smaller and lower contrast.
- Empty states are illustrated and actionable ("No expenses yet — add your first bill" + button), never a bare "No data".
- Skeleton loaders that match the final layout. Never a full-screen spinner on a screen we can partially render from cache.
- Motion: 200–300ms, `easeOutCubic`, via `react-native-reanimated`. Shared-element transition from an expense row to its detail. Respect `prefers-reduced-motion`.

## 6.4 Dark Mode
- Three settings: System (default), Light, Dark. Persisted; applied before first paint to avoid a white flash.
- Dark surfaces are elevated tonal greys (`#121212` base, surfaces stepping up), never pure black on OLED-adjacent content — except an optional AMOLED black theme for battery-conscious users (Phase 2).
- Contrast ratios verified in **both** themes. Charts get a separate dark palette; do not reuse light-mode chart colours.
- All images/illustrations have dark variants or transparent backgrounds. Bill photos render on a neutral backdrop in both themes.

## 6.5 Accessibility (target: WCAG 2.2 AA)
- Text contrast ≥ 4.5:1 (≥ 3:1 for ≥ 18pt); never encode meaning in colour alone — dues states carry an icon and a text label alongside the colour.
- Minimum touch target 48×48dp with 8dp spacing.
- Every interactive element has `accessibilityLabel`, `accessibilityRole` and `accessibilityHint` where the action is non-obvious. Money is announced as "four thousand two hundred fifty rupees", not "₹4250".
- Full support for OS font scaling up to 200%; layouts use flex and wrap, never fixed heights on text containers. Test at `fontScale: 2`.
- Screen-reader flow order tested with TalkBack and VoiceOver on the 6 highest-traffic screens.
- Form errors are announced, tied to their field, and stated as plain instructions ("Enter an amount greater than ₹0"), not codes.
- Haptics via `expo-haptics` on success/failure — a second modality for confirmation, respecting the system setting.
- **Languages:** English, Hindi, Marathi, Tamil, Telugu, Kannada, Bengali, Gujarati in Phase 2. Architect with `i18next` + `expo-localization` from day one — no hardcoded strings, ever. Support RTL-safe layout primitives even though no RTL language ships initially.

## 6.6 Offline-First UX
- A persistent, unobtrusive banner when offline: "Offline — changes will sync". Tapping opens the Sync Status sheet listing pending items.
- Every locally-created record shows a "Pending sync" chip; it clears on confirmation. Failures show "Sync failed — tap to retry" with the reason.
- Reads are always served from cache first, revalidated in the background (stale-while-revalidate). A cached screen shows its data age if older than 1 hour.
- Actions that genuinely cannot work offline (online payment, OTP, OCR, report generation) are visibly disabled with an explanatory tooltip, not silently failing.
- Never block the UI on a network call. Optimistic updates with rollback on failure, and a Snackbar with Undo where reversal is safe.

## 6.7 Performance Budget
| Metric | Target |
|---|---|
| Cold start to interactive (mid-range Android) | < 3.0s |
| Warm start | < 1.0s |
| Dashboard render from cache | < 500ms |
| List scroll | 60fps, `FlashList`, windowed |
| APK size | < 40 MB |
| Memory (steady state) | < 180 MB |
| Crash-free sessions | > 99.5% |

---

# 7. Database Design

**Engine:** PostgreSQL 15+. All tables use `uuid` primary keys (`gen_random_uuid()`), `created_at`/`updated_at` timestamptz, and soft-delete via `deleted_at` where history matters.

**Money rule:** all monetary values are `bigint` **paise**. Never `float`, never `money`. Column names end in `_paise`.

**Multi-tenancy:** every tenant-scoped table carries `society_id` and is protected by Row Level Security keyed to the requesting user's memberships.

## 7.1 Enums

```sql
CREATE TYPE user_status         AS ENUM ('active','suspended','deleted');
CREATE TYPE member_role         AS ENUM ('admin','treasurer','committee','resident','tenant','guest');
CREATE TYPE member_status       AS ENUM ('pending','active','inactive','removed','rejected');
CREATE TYPE occupancy_type      AS ENUM ('owner_occupied','tenant','family_member','vacant_owner');
CREATE TYPE occupancy_status    AS ENUM ('owner_occupied','rented','vacant','under_construction');
CREATE TYPE expense_status      AS ENUM ('draft','pending_approval','published','void');
CREATE TYPE split_strategy      AS ENUM ('equal','percentage','shares','apartment','custom');
CREATE TYPE apartment_basis     AS ENUM ('per_flat','per_sqft_carpet','per_sqft_builtup','per_bhk','per_floor_band','per_parking_slot');
CREATE TYPE due_status          AS ENUM ('pending','partial','paid','overdue','waived','written_off');
CREATE TYPE payment_method      AS ENUM ('upi','card','netbanking','wallet','cash','cheque','neft','imps','adjustment');
CREATE TYPE payment_status      AS ENUM ('initiated','pending','unverified','verified','failed','refunded','cancelled');
CREATE TYPE cycle_status        AS ENUM ('draft','generated','published','closed');
CREATE TYPE complaint_status    AS ENUM ('open','acknowledged','in_progress','resolved','closed','reopened','rejected');
CREATE TYPE priority_level      AS ENUM ('low','medium','high','urgent');
CREATE TYPE visitor_status      AS ENUM ('expected','waiting_approval','approved','denied','entered','exited','expired');
CREATE TYPE visitor_type        AS ENUM ('guest','delivery','cab','service','staff','vendor');
CREATE TYPE notice_type         AS ENUM ('general','event','emergency','maintenance_alert','agm','poll');
CREATE TYPE notification_channel AS ENUM ('push','email','sms','whatsapp','in_app');
CREATE TYPE subscription_plan   AS ENUM ('free','premium','society_pro','enterprise');
```

## 7.2 Core Tables

```sql
-- USERS -----------------------------------------------------------------
CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name        varchar(120) NOT NULL,
  email            citext UNIQUE,
  email_verified_at timestamptz,
  phone            varchar(16) UNIQUE,          -- E.164, +91XXXXXXXXXX
  phone_verified_at timestamptz,
  password_hash    text,                         -- null for OAuth/OTP-only
  avatar_key       text,
  locale           varchar(8) NOT NULL DEFAULT 'en-IN',
  timezone         varchar(48) NOT NULL DEFAULT 'Asia/Kolkata',
  status           user_status NOT NULL DEFAULT 'active',
  last_login_at    timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  CONSTRAINT users_identity_present CHECK (email IS NOT NULL OR phone IS NOT NULL)
);
CREATE INDEX idx_users_phone ON users(phone) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_email ON users(email) WHERE deleted_at IS NULL;

CREATE TABLE auth_identities (          -- OAuth provider links
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider     varchar(24) NOT NULL,     -- 'google' | 'apple'
  provider_uid varchar(191) NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_uid)
);

CREATE TABLE devices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expo_push_token  text NOT NULL,
  platform         varchar(12) NOT NULL,     -- ios | android | web
  app_version      varchar(24),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (expo_push_token)
);

-- SOCIETIES -------------------------------------------------------------
CREATE TABLE societies (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              varchar(160) NOT NULL,
  slug              varchar(180) UNIQUE NOT NULL,
  society_type      varchar(24) NOT NULL DEFAULT 'apartment',
  registration_no   varchar(64),
  address_line1     varchar(200),
  address_line2     varchar(200),
  city              varchar(80) NOT NULL,
  state             varchar(80) NOT NULL,
  pincode           varchar(10),
  country           char(2) NOT NULL DEFAULT 'IN',
  currency          char(3) NOT NULL DEFAULT 'INR',
  timezone          varchar(48) NOT NULL DEFAULT 'Asia/Kolkata',
  logo_key          text,
  join_code         varchar(8) UNIQUE NOT NULL,
  join_code_expires_at timestamptz,
  plan              subscription_plan NOT NULL DEFAULT 'free',
  plan_expires_at   timestamptz,
  created_by        uuid NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);
CREATE INDEX idx_societies_city ON societies(city) WHERE deleted_at IS NULL;

CREATE TABLE society_settings (
  society_id             uuid PRIMARY KEY REFERENCES societies(id) ON DELETE CASCADE,
  billing_day            smallint NOT NULL DEFAULT 1   CHECK (billing_day BETWEEN 1 AND 28),
  due_day                smallint NOT NULL DEFAULT 10  CHECK (due_day BETWEEN 1 AND 28),
  grace_days             smallint NOT NULL DEFAULT 5,
  late_fee_type          varchar(12) NOT NULL DEFAULT 'none', -- none|flat|percent
  late_fee_value_paise   bigint NOT NULL DEFAULT 0,
  late_fee_percent       numeric(5,2) NOT NULL DEFAULT 0,
  default_split_strategy split_strategy NOT NULL DEFAULT 'equal',
  default_apartment_basis apartment_basis,
  approval_threshold_paise bigint NOT NULL DEFAULT 1000000,   -- ₹10,000
  bill_vacant_flats      boolean NOT NULL DEFAULT true,
  allow_partial_payments boolean NOT NULL DEFAULT true,
  defaulter_list_public  boolean NOT NULL DEFAULT false,
  bill_presentation      varchar(16) NOT NULL DEFAULT 'composite', -- composite|per_head
  financial_year_start_month smallint NOT NULL DEFAULT 4,
  ai_features_enabled    boolean NOT NULL DEFAULT true,
  razorpay_account_id    varchar(64),
  bank_account_name      varchar(120),
  bank_account_masked    varchar(24),
  bank_ifsc              varchar(16),
  upi_vpa                varchar(80),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- STRUCTURE -------------------------------------------------------------
CREATE TABLE buildings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id  uuid NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
  name        varchar(80) NOT NULL,
  total_floors smallint,
  display_order smallint NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  UNIQUE (society_id, name)
);
CREATE INDEX idx_buildings_society ON buildings(society_id);

CREATE TABLE wings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  building_id uuid NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  society_id  uuid NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
  name        varchar(40) NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (building_id, name)
);

CREATE TABLE apartments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id         uuid NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
  building_id        uuid NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  wing_id            uuid REFERENCES wings(id) ON DELETE SET NULL,
  apartment_number   varchar(24) NOT NULL,
  floor              smallint,
  bhk                numeric(3,1),
  carpet_area_sqft   numeric(8,2),
  builtup_area_sqft  numeric(8,2),
  parking_slots      smallint NOT NULL DEFAULT 0,
  share_units        numeric(8,3) NOT NULL DEFAULT 1,
  occupancy_status   occupancy_status NOT NULL DEFAULT 'vacant',
  is_commercial      boolean NOT NULL DEFAULT false,
  is_billable        boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  UNIQUE (society_id, building_id, apartment_number)
);
CREATE INDEX idx_apartments_society ON apartments(society_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_apartments_building_floor ON apartments(building_id, floor);

-- MEMBERSHIP ------------------------------------------------------------
CREATE TABLE members (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id     uuid NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
  user_id        uuid REFERENCES users(id) ON DELETE SET NULL,  -- null = shadow member
  apartment_id   uuid REFERENCES apartments(id) ON DELETE SET NULL,
  display_name   varchar(120) NOT NULL,
  phone          varchar(16),
  email          citext,
  role           member_role NOT NULL DEFAULT 'resident',
  status         member_status NOT NULL DEFAULT 'pending',
  occupancy      occupancy_type NOT NULL DEFAULT 'owner_occupied',
  is_primary     boolean NOT NULL DEFAULT false,   -- primary owner/tenant of the flat
  lease_start    date,
  lease_end      date,
  share_contact  boolean NOT NULL DEFAULT false,
  joined_at      timestamptz,
  approved_by    uuid REFERENCES members(id),
  removed_at     timestamptz,
  removed_by     uuid REFERENCES members(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (society_id, user_id)
);
CREATE INDEX idx_members_society_status ON members(society_id, status);
CREATE INDEX idx_members_apartment ON members(apartment_id);
CREATE INDEX idx_members_user ON members(user_id);
-- at most one primary owner and one primary tenant per apartment
CREATE UNIQUE INDEX uq_primary_occupant ON members(apartment_id, occupancy)
  WHERE is_primary AND status = 'active' AND occupancy IN ('owner_occupied','tenant','vacant_owner');

CREATE TABLE family_members (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id    uuid NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
  apartment_id  uuid NOT NULL REFERENCES apartments(id) ON DELETE CASCADE,
  member_id     uuid REFERENCES members(id) ON DELETE SET NULL,
  name          varchar(120) NOT NULL,
  relation      varchar(40),
  age_bracket   varchar(16),
  phone         varchar(16),
  can_approve_visitors boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invitations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id   uuid NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
  apartment_id uuid REFERENCES apartments(id) ON DELETE SET NULL,
  invited_by   uuid NOT NULL REFERENCES members(id),
  channel      varchar(16) NOT NULL,        -- whatsapp|sms|email|link
  phone        varchar(16),
  email        citext,
  role         member_role NOT NULL DEFAULT 'resident',
  token_hash   text NOT NULL,
  status       varchar(16) NOT NULL DEFAULT 'sent', -- sent|opened|accepted|expired|revoked
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_invitations_society_status ON invitations(society_id, status);
```

## 7.3 Financial Tables

```sql
CREATE TABLE expense_categories (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id       uuid NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
  name             varchar(80) NOT NULL,
  icon             varchar(40),
  color            varchar(9),
  default_split_strategy split_strategy NOT NULL DEFAULT 'equal',
  default_apartment_basis apartment_basis,
  is_owner_only    boolean NOT NULL DEFAULT false,
  is_capital       boolean NOT NULL DEFAULT false,
  gst_applicable   boolean NOT NULL DEFAULT false,
  is_active        boolean NOT NULL DEFAULT true,
  display_order    smallint NOT NULL DEFAULT 0,
  UNIQUE (society_id, name)
);

CREATE TABLE expenses (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id         uuid NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
  category_id        uuid NOT NULL REFERENCES expense_categories(id),
  cycle_id           uuid REFERENCES maintenance_cycles(id) ON DELETE SET NULL,
  title              varchar(120) NOT NULL,
  description        text,
  amount_paise       bigint NOT NULL CHECK (amount_paise > 0),
  currency           char(3) NOT NULL DEFAULT 'INR',
  expense_date       date NOT NULL,
  vendor_name        varchar(120),
  payment_source     varchar(24) NOT NULL DEFAULT 'society_account',
  paid_by_member_id  uuid REFERENCES members(id),
  split_strategy     split_strategy NOT NULL,
  apartment_basis    apartment_basis,
  split_config       jsonb NOT NULL DEFAULT '{}'::jsonb,
  participant_selector jsonb NOT NULL DEFAULT '{}'::jsonb,
  status             expense_status NOT NULL DEFAULT 'draft',
  is_recurring       boolean NOT NULL DEFAULT false,
  recurring_template_id uuid REFERENCES recurring_templates(id) ON DELETE SET NULL,
  due_date           date,
  created_by         uuid NOT NULL REFERENCES members(id),
  approved_by        uuid REFERENCES members(id),
  approved_at        timestamptz,
  published_at       timestamptz,
  voided_at          timestamptz,
  voided_by          uuid REFERENCES members(id),
  void_reason        text,
  version            integer NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_expenses_society_date ON expenses(society_id, expense_date DESC);
CREATE INDEX idx_expenses_society_status ON expenses(society_id, status);
CREATE INDEX idx_expenses_category ON expenses(category_id);
CREATE INDEX idx_expenses_cycle ON expenses(cycle_id);
CREATE INDEX idx_expenses_search ON expenses USING gin (to_tsvector('english', title || ' ' || coalesce(description,'') || ' ' || coalesce(vendor_name,'')));

CREATE TABLE expense_gst_details (
  expense_id      uuid PRIMARY KEY REFERENCES expenses(id) ON DELETE CASCADE,
  gstin           varchar(15),
  invoice_number  varchar(64),
  invoice_date    date,
  taxable_value_paise bigint NOT NULL DEFAULT 0,
  cgst_paise      bigint NOT NULL DEFAULT 0,
  sgst_paise      bigint NOT NULL DEFAULT 0,
  igst_paise      bigint NOT NULL DEFAULT 0,
  cess_paise      bigint NOT NULL DEFAULT 0,
  hsn_sac         varchar(16),
  place_of_supply varchar(40),
  is_reverse_charge boolean NOT NULL DEFAULT false,
  itc_eligible    boolean NOT NULL DEFAULT false,
  CONSTRAINT gst_single_regime CHECK (NOT (igst_paise > 0 AND (cgst_paise > 0 OR sgst_paise > 0)))
);

CREATE TABLE expense_splits (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id     uuid NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
  expense_id     uuid NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  member_id      uuid REFERENCES members(id) ON DELETE SET NULL,
  apartment_id   uuid REFERENCES apartments(id) ON DELETE SET NULL,
  amount_paise   bigint NOT NULL CHECK (amount_paise >= 0),
  weight         numeric(12,4),
  percent        numeric(7,4),
  assigned_reason varchar(40),          -- e.g. owner_only_category
  snapshot       jsonb NOT NULL DEFAULT '{}'::jsonb,  -- member name, flat no at publish time
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (expense_id, member_id, apartment_id)
);
CREATE INDEX idx_splits_member ON expense_splits(member_id);
CREATE INDEX idx_splits_expense ON expense_splits(expense_id);

CREATE TABLE expense_revisions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id   uuid NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  version      integer NOT NULL,
  snapshot     jsonb NOT NULL,
  changed_by   uuid NOT NULL REFERENCES members(id),
  change_note  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (expense_id, version)
);

CREATE TABLE dues (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id     uuid NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
  member_id      uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  apartment_id   uuid REFERENCES apartments(id) ON DELETE SET NULL,
  expense_id     uuid REFERENCES expenses(id) ON DELETE CASCADE,
  split_id       uuid REFERENCES expense_splits(id) ON DELETE CASCADE,
  cycle_id       uuid REFERENCES maintenance_cycles(id) ON DELETE SET NULL,
  kind           varchar(16) NOT NULL DEFAULT 'principal', -- principal|late_fee|adjustment
  amount_paise   bigint NOT NULL,
  paid_paise     bigint NOT NULL DEFAULT 0,
  status         due_status NOT NULL DEFAULT 'pending',
  due_date       date NOT NULL,
  waived_reason  text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (paid_paise >= 0 AND paid_paise <= amount_paise)
);
CREATE INDEX idx_dues_member_status ON dues(member_id, status);
CREATE INDEX idx_dues_society_due_date ON dues(society_id, due_date);
CREATE INDEX idx_dues_outstanding ON dues(society_id, status) WHERE status IN ('pending','partial','overdue');

CREATE TABLE payments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id           uuid NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
  member_id            uuid NOT NULL REFERENCES members(id),
  amount_paise         bigint NOT NULL CHECK (amount_paise > 0),
  method               payment_method NOT NULL,
  status               payment_status NOT NULL DEFAULT 'initiated',
  paid_at              timestamptz,
  reference_no         varchar(80),
  cheque_number        varchar(24),
  cheque_bank          varchar(80),
  cheque_date          date,
  cheque_cleared       boolean,
  razorpay_order_id    varchar(64),
  razorpay_payment_id  varchar(64) UNIQUE,
  razorpay_signature   text,
  gateway_fee_paise    bigint NOT NULL DEFAULT 0,
  proof_key            text,
  recorded_by          uuid REFERENCES members(id),
  verified_by          uuid REFERENCES members(id),
  verified_at          timestamptz,
  rejection_reason     text,
  idempotency_key      varchar(64) UNIQUE,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_payments_member ON payments(member_id, created_at DESC);
CREATE INDEX idx_payments_society_status ON payments(society_id, status);

CREATE TABLE payment_allocations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id    uuid NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  due_id        uuid NOT NULL REFERENCES dues(id) ON DELETE CASCADE,
  amount_paise  bigint NOT NULL CHECK (amount_paise > 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_id, due_id)
);

CREATE TABLE receipts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id     uuid NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
  payment_id     uuid NOT NULL UNIQUE REFERENCES payments(id) ON DELETE CASCADE,
  receipt_number varchar(48) NOT NULL,
  financial_year varchar(9) NOT NULL,          -- '2026-27'
  pdf_key        text,
  issued_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (society_id, receipt_number)
);

CREATE TABLE member_balances (          -- maintained transactionally
  member_id          uuid PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  society_id         uuid NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
  total_due_paise    bigint NOT NULL DEFAULT 0,
  total_paid_paise   bigint NOT NULL DEFAULT 0,
  advance_paise      bigint NOT NULL DEFAULT 0,
  outstanding_paise  bigint NOT NULL DEFAULT 0,
  oldest_due_date    date,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_balances_society_outstanding ON member_balances(society_id, outstanding_paise DESC);

CREATE TABLE maintenance_cycles (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id     uuid NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
  period_start   date NOT NULL,
  period_end     date NOT NULL,
  label          varchar(40) NOT NULL,         -- 'Oct 2026'
  due_date       date NOT NULL,
  status         cycle_status NOT NULL DEFAULT 'draft',
  total_billed_paise bigint NOT NULL DEFAULT 0,
  published_at   timestamptz,
  published_by   uuid REFERENCES members(id),
  closed_at      timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (society_id, period_start)
);

CREATE TABLE charge_heads (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id       uuid NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
  name             varchar(80) NOT NULL,
  category_id      uuid REFERENCES expense_categories(id),
  amount_paise     bigint,                     -- fixed amount
  rate_paise       bigint,                     -- per sqft / per unit / per slot
  split_strategy   split_strategy NOT NULL DEFAULT 'equal',
  apartment_basis  apartment_basis,
  floor_bands      jsonb,                      -- [{from:0,to:0,mult:0},{from:1,to:3,mult:1}]
  applies_to       jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_owner_only    boolean NOT NULL DEFAULT false,
  is_metered       boolean NOT NULL DEFAULT false,
  is_active        boolean NOT NULL DEFAULT true,
  active_from      date,
  active_to        date,
  display_order    smallint NOT NULL DEFAULT 0,
  UNIQUE (society_id, name)
);

CREATE TABLE cycle_charges (            -- materialised preview lines
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id       uuid NOT NULL REFERENCES maintenance_cycles(id) ON DELETE CASCADE,
  apartment_id   uuid NOT NULL REFERENCES apartments(id) ON DELETE CASCADE,
  charge_head_id uuid NOT NULL REFERENCES charge_heads(id) ON DELETE CASCADE,
  amount_paise   bigint NOT NULL,
  is_overridden  boolean NOT NULL DEFAULT false,
  override_reason text,
  UNIQUE (cycle_id, apartment_id, charge_head_id)
);

CREATE TABLE meter_readings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id     uuid NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
  apartment_id   uuid NOT NULL REFERENCES apartments(id) ON DELETE CASCADE,
  charge_head_id uuid NOT NULL REFERENCES charge_heads(id) ON DELETE CASCADE,
  cycle_id       uuid REFERENCES maintenance_cycles(id) ON DELETE SET NULL,
  previous_value numeric(12,3) NOT NULL,
  current_value  numeric(12,3) NOT NULL,
  reading_date   date NOT NULL,
  photo_key      text,
  recorded_by    uuid REFERENCES members(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (current_value >= previous_value)
);

CREATE TABLE recurring_templates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id     uuid NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
  title          varchar(120) NOT NULL,
  category_id    uuid NOT NULL REFERENCES expense_categories(id),
  amount_paise   bigint NOT NULL,
  frequency      varchar(16) NOT NULL,     -- monthly|quarterly|half_yearly|yearly
  day_of_month   smallint NOT NULL DEFAULT 1,
  split_strategy split_strategy NOT NULL,
  split_config   jsonb NOT NULL DEFAULT '{}'::jsonb,
  next_run_on    date NOT NULL,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE budgets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id     uuid NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
  financial_year varchar(9) NOT NULL,
  category_id    uuid NOT NULL REFERENCES expense_categories(id),
  amount_paise   bigint NOT NULL,
  created_by     uuid REFERENCES members(id),
  UNIQUE (society_id, financial_year, category_id)
);
```

## 7.4 Community, Ops & System Tables

```sql
CREATE TABLE attachments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id    uuid NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
  entity_type   varchar(32) NOT NULL,      -- expense|complaint|notice|payment|meter
  entity_id     uuid NOT NULL,
  storage_key   text NOT NULL,
  file_name     varchar(200),
  mime_type     varchar(80),
  size_bytes    integer,
  width         integer,
  height        integer,
  checksum      varchar(64),
  uploaded_by   uuid REFERENCES members(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_attachments_entity ON attachments(entity_type, entity_id);

CREATE TABLE announcements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id    uuid NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
  type          notice_type NOT NULL DEFAULT 'general',
  title         varchar(160) NOT NULL,
  body          text NOT NULL,
  audience      jsonb NOT NULL DEFAULT '{"scope":"society"}'::jsonb,
  is_pinned     boolean NOT NULL DEFAULT false,
  requires_ack  boolean NOT NULL DEFAULT false,
  comments_enabled boolean NOT NULL DEFAULT true,
  event_starts_at timestamptz,
  event_ends_at   timestamptz,
  venue         varchar(160),
  rsvp_enabled  boolean NOT NULL DEFAULT false,
  publish_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,
  created_by    uuid NOT NULL REFERENCES members(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE INDEX idx_announcements_society_publish ON announcements(society_id, publish_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE announcement_reads (
  announcement_id uuid NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  member_id       uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  read_at         timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  rsvp            varchar(12),
  PRIMARY KEY (announcement_id, member_id)
);

CREATE TABLE complaints (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id     uuid NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
  raised_by      uuid NOT NULL REFERENCES members(id),
  apartment_id   uuid REFERENCES apartments(id) ON DELETE SET NULL,
  assigned_to    uuid REFERENCES members(id),
  category       varchar(40) NOT NULL,
  title          varchar(160) NOT NULL,
  description    text NOT NULL,
  location_note  varchar(160),
  priority       priority_level NOT NULL DEFAULT 'medium',
  status         complaint_status NOT NULL DEFAULT 'open',
  is_anonymous   boolean NOT NULL DEFAULT false,
  linked_expense_id uuid REFERENCES expenses(id) ON DELETE SET NULL,
  sla_respond_by timestamptz,
  sla_resolve_by timestamptz,
  acknowledged_at timestamptz,
  resolved_at    timestamptz,
  closed_at      timestamptz,
  resolution_note text,
  rating         smallint CHECK (rating BETWEEN 1 AND 5),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_complaints_society_status ON complaints(society_id, status);
CREATE INDEX idx_complaints_assigned ON complaints(assigned_to, status);

CREATE TABLE complaint_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  complaint_id uuid NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
  actor_id     uuid REFERENCES members(id),
  event_type   varchar(32) NOT NULL,     -- created|assigned|status_change|comment|attachment
  from_status  complaint_status,
  to_status    complaint_status,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_complaint_events_complaint ON complaint_events(complaint_id, created_at);

CREATE TABLE visitors (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id      uuid NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
  apartment_id    uuid REFERENCES apartments(id) ON DELETE SET NULL,
  visitor_type    visitor_type NOT NULL DEFAULT 'guest',
  name            varchar(120) NOT NULL,
  phone           varchar(16),
  purpose         varchar(160),
  vehicle_number  varchar(24),
  provider        varchar(60),              -- for deliveries
  tracking_ref    varchar(80),
  photo_key       text,
  gate_pin        varchar(8),
  status          visitor_status NOT NULL DEFAULT 'waiting_approval',
  expected_from   timestamptz,
  expected_to     timestamptz,
  approved_by     uuid REFERENCES members(id),
  approved_at     timestamptz,
  denied_reason   varchar(160),
  entry_at        timestamptz,
  exit_at         timestamptz,
  logged_by       uuid REFERENCES members(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_visitors_society_created ON visitors(society_id, created_at DESC);
CREATE INDEX idx_visitors_apartment_status ON visitors(apartment_id, status);

CREATE TABLE notifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id    uuid REFERENCES societies(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type          varchar(48) NOT NULL,
  title         varchar(160) NOT NULL,
  body          text,
  data          jsonb NOT NULL DEFAULT '{}'::jsonb,
  channels      notification_channel[] NOT NULL DEFAULT '{in_app}',
  is_read       boolean NOT NULL DEFAULT false,
  read_at       timestamptz,
  sent_at       timestamptz,
  delivered_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_notifications_user_unread ON notifications(user_id, is_read, created_at DESC);

CREATE TABLE notification_preferences (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  society_id  uuid NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
  category    varchar(40) NOT NULL,
  push        boolean NOT NULL DEFAULT true,
  email       boolean NOT NULL DEFAULT true,
  sms         boolean NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, society_id, category)
);

CREATE TABLE audit_logs (
  id            bigserial PRIMARY KEY,
  society_id    uuid REFERENCES societies(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_role    member_role,
  action        varchar(64) NOT NULL,      -- expense.publish, member.role_change...
  entity_type   varchar(32) NOT NULL,
  entity_id     uuid,
  before        jsonb,
  after         jsonb,
  ip_address    inet,
  user_agent    text,
  request_id    uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_society_created ON audit_logs(society_id, created_at DESC);
CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id);
-- append-only: REVOKE UPDATE, DELETE ON audit_logs FROM app_role;

CREATE TABLE subscriptions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id        uuid NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
  plan              subscription_plan NOT NULL,
  billing_period    varchar(12) NOT NULL DEFAULT 'yearly',
  unit_count        integer NOT NULL DEFAULT 0,       -- flats billed
  amount_paise      bigint NOT NULL,
  razorpay_subscription_id varchar(64),
  status            varchar(24) NOT NULL DEFAULT 'active',
  current_period_start date,
  current_period_end   date,
  cancelled_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ai_suggestions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id    uuid NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
  feature       varchar(40) NOT NULL,      -- ocr|duplicate|anomaly|forecast|nlsearch
  entity_type   varchar(32),
  entity_id     uuid,
  input_hash    varchar(64),
  output        jsonb NOT NULL,
  confidence    numeric(4,3),
  outcome       varchar(16),               -- accepted|rejected|ignored
  model         varchar(60),
  latency_ms    integer,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_suggestions_lookup ON ai_suggestions(society_id, feature, created_at DESC);

CREATE TABLE sync_cursors (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  society_id  uuid NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
  entity      varchar(32) NOT NULL,
  last_synced_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, society_id, entity)
);
```

## 7.5 Relationship Summary

```
users 1─n members n─1 societies
societies 1─n buildings 1─n wings 1─n apartments
apartments 1─n members            (occupancy)
apartments 1─n family_members
societies 1─n expense_categories 1─n expenses
expenses  1─n expense_splits 1─1 dues n─1 members
expenses  1─1 expense_gst_details
expenses  1─n expense_revisions
payments  1─n payment_allocations n─1 dues
payments  1─1 receipts
members   1─1 member_balances
societies 1─n maintenance_cycles 1─n cycle_charges n─1 charge_heads
societies 1─n complaints 1─n complaint_events
societies 1─n announcements 1─n announcement_reads
societies 1─n visitors
societies 1─n audit_logs
any entity 1─n attachments (polymorphic by entity_type/entity_id)
```

## 7.6 Row Level Security (illustrative)

```sql
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;

CREATE POLICY expenses_read ON expenses FOR SELECT
USING (society_id IN (
  SELECT society_id FROM members
  WHERE user_id = auth.uid() AND status = 'active'
));

CREATE POLICY expenses_write ON expenses FOR INSERT
WITH CHECK (society_id IN (
  SELECT society_id FROM members
  WHERE user_id = auth.uid() AND status = 'active'
    AND role IN ('admin','treasurer','committee')
));
```
Apply the analogous pattern to every tenant-scoped table. Security-role members are additionally restricted from all financial tables by an explicit `role <> 'guest'` clause.

## 7.7 Integrity Rules (enforced in the DB, not just the app)
- `SUM(expense_splits.amount_paise) = expenses.amount_paise` for published expenses — enforce with a deferred constraint trigger.
- `SUM(payment_allocations.amount_paise) <= payments.amount_paise`.
- `dues.paid_paise = SUM(payment_allocations)` for verified payments — maintained by trigger.
- Every society has ≥ 1 active admin — enforced by a trigger on `members` update/delete.
- `audit_logs` is INSERT-only for the application role.

---

# 8. API Design

**Base URL:** `https://api.societysplit.in/v1`
**Auth:** `Authorization: Bearer <access_token>`
**Tenant header:** `X-Society-Id: <uuid>` — required on all society-scoped routes; the server still verifies membership, never trusts the header alone.
**Other headers:** `X-Request-Id` (uuid, echoed in responses and audit logs), `Idempotency-Key` (required on all POSTs that create money movement), `X-Client-Version`.

## 8.1 Conventions

**Success envelope**
```json
{ "data": { }, "meta": { "requestId": "…" } }
```
**List envelope (cursor pagination)**
```json
{ "data": [ ], "meta": { "nextCursor": "eyJpZCI6…", "hasMore": true, "total": 248 } }
```
**Error envelope**
```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Split percentages must total 100%",
             "field": "splitConfig.percentages", "details": [ ], "requestId": "…" } }
```

| Code | HTTP | Meaning |
|---|---|---|
| `UNAUTHENTICATED` | 401 | Missing/expired token |
| `FORBIDDEN` | 403 | Role lacks permission |
| `NOT_FOUND` | 404 | Not found or not in your society |
| `VALIDATION_ERROR` | 422 | Field-level failure |
| `CONFLICT` | 409 | Version conflict / duplicate |
| `RATE_LIMITED` | 429 | Retry-After header set |
| `PAYMENT_FAILED` | 402 | Gateway rejection |
| `PLAN_LIMIT_EXCEEDED` | 402 | Upgrade required |
| `INTERNAL` | 500 | Unexpected |

**Standard query params on list endpoints:** `cursor`, `limit` (default 20, max 100), `sort`, `q`, `updatedSince` (ISO8601, drives delta sync), `includeDeleted`.

**Money in the API** is always an integer in paise, named `amountPaise`. Clients format for display; servers never send formatted strings.

## 8.2 Endpoint Catalogue

### Auth
| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/register` | Email signup |
| POST | `/auth/login` | Email + password |
| POST | `/auth/otp/request` | Send OTP to phone |
| POST | `/auth/otp/verify` | Verify OTP → tokens |
| POST | `/auth/oauth/google` | Exchange Google id_token |
| POST | `/auth/oauth/apple` | Exchange Apple identity token |
| POST | `/auth/refresh` | Rotate refresh token |
| POST | `/auth/logout` | Revoke current refresh token |
| POST | `/auth/password/forgot` | Send reset link |
| POST | `/auth/password/reset` | Complete reset |
| GET | `/auth/me` | Current user + memberships |
| PATCH | `/auth/me` | Update profile |
| DELETE | `/auth/me` | Request account deletion |

### Societies & Structure
| Method | Path |
|---|---|
| POST | `/societies` |
| GET | `/societies/:id` |
| PATCH | `/societies/:id` |
| DELETE | `/societies/:id` |
| GET | `/societies/:id/settings` · PUT `/societies/:id/settings` |
| POST | `/societies/:id/join-code/regenerate` |
| GET | `/societies/lookup?code=ABC123` (public preview) |
| POST | `/societies/:id/buildings` · GET · PATCH `/buildings/:bid` · DELETE |
| POST | `/buildings/:bid/wings` · DELETE `/wings/:wid` |
| POST | `/societies/:id/apartments` · `/apartments/bulk` · GET · PATCH · DELETE |
| POST | `/societies/:id/apartments/generate` (pattern generator) |

### Members
| Method | Path |
|---|---|
| GET | `/societies/:id/members` |
| POST | `/societies/:id/members` (direct add / shadow member) |
| GET/PATCH/DELETE | `/members/:mid` |
| PATCH | `/members/:mid/role` |
| GET | `/societies/:id/join-requests` · POST `/join-requests/:jid/approve` · `/reject` |
| POST | `/societies/:id/invitations` · `/invitations/bulk` |
| GET | `/societies/:id/invitations` · POST `/invitations/:iid/revoke` |
| POST | `/invitations/accept` |
| GET/POST/DELETE | `/apartments/:aid/family-members` |

### Expenses
| Method | Path |
|---|---|
| GET | `/societies/:id/expenses` |
| POST | `/societies/:id/expenses` |
| GET/PATCH/DELETE | `/expenses/:eid` |
| POST | `/expenses/:eid/publish` · `/approve` · `/void` |
| GET | `/expenses/:eid/splits` · `/revisions` · `/comments` · POST `/comments` |
| POST | `/expenses/preview-split` (no persistence — drives the live split editor) |
| GET/POST/PATCH/DELETE | `/societies/:id/categories` |
| POST | `/expenses/:eid/attachments` (presigned) · DELETE `/attachments/:aid` |
| PUT | `/expenses/:eid/gst` |
| GET/POST/PATCH/DELETE | `/societies/:id/recurring-templates` |

### Payments & Dues
| Method | Path |
|---|---|
| GET | `/societies/:id/dues?memberId=&status=` |
| GET | `/members/:mid/dues` · `/statement` · `/balance` |
| POST | `/payments/intent` |
| POST | `/payments/verify` |
| POST | `/payments/offline` |
| GET | `/societies/:id/payments` · GET `/payments/:pid` |
| POST | `/payments/:pid/verify` · `/reject` · `/refund` |
| GET | `/payments/:pid/receipt` |
| POST | `/webhooks/razorpay` (unauthenticated, signature-verified) |
| GET | `/societies/:id/outstanding` |
| POST | `/societies/:id/reminders` |

### Maintenance
| Method | Path |
|---|---|
| GET/POST | `/societies/:id/charge-heads` · PATCH/DELETE `/charge-heads/:cid` |
| GET/POST | `/societies/:id/cycles` |
| GET | `/cycles/:cid` · `/cycles/:cid/preview` |
| PATCH | `/cycles/:cid/charges/:chid` (override) |
| POST | `/cycles/:cid/generate` · `/publish` · `/close` |
| GET/POST | `/societies/:id/meter-readings` |

### Community
| Method | Path |
|---|---|
| GET/POST | `/societies/:id/announcements` · GET/PATCH/DELETE `/announcements/:nid` |
| POST | `/announcements/:nid/read` · `/acknowledge` · `/rsvp` |
| GET/POST | `/societies/:id/complaints` · GET/PATCH `/complaints/:cid` |
| POST | `/complaints/:cid/assign` · `/status` · `/comments` · `/rate` |
| GET/POST | `/societies/:id/visitors` |
| POST | `/visitors/:vid/approve` · `/deny` · `/entry` · `/exit` |
| POST | `/societies/:id/visitors/pre-approve` |

### Reports, Notifications, System
| Method | Path |
|---|---|
| GET | `/societies/:id/reports/monthly?period=2026-09` |
| GET | `/societies/:id/reports/annual?fy=2026-27` |
| GET | `/societies/:id/reports/trends` · `/budget` · `/gst` · `/collection-efficiency` |
| POST | `/societies/:id/reports/export` → `{ jobId }`; GET `/jobs/:jid` |
| GET/POST | `/societies/:id/budgets` |
| GET | `/notifications` · POST `/notifications/:nid/read` · `/read-all` |
| GET/PUT | `/notification-preferences` |
| POST | `/devices` · DELETE `/devices/:did` |
| GET | `/societies/:id/audit-logs` |
| GET | `/societies/:id/subscription` · POST `/subscription/upgrade` · `/cancel` |
| POST | `/ai/ocr` · `/ai/search` · `/ai/assistant` · `/ai/insights` |
| GET | `/sync/changes?since=&entities=` |
| POST | `/sync/batch` |
| GET | `/health` · `/config` (feature flags, min supported version) |

## 8.3 Request / Response Examples

### POST /societies
```http
POST /v1/societies
Authorization: Bearer eyJ…
Idempotency-Key: 6f1c2a4e-…
Content-Type: application/json

{
  "name": "Green Meadows CHS",
  "societyType": "apartment",
  "registrationNo": "MUM/CHS/1998/4412",
  "addressLine1": "Plot 14, Sector 21",
  "city": "Navi Mumbai",
  "state": "Maharashtra",
  "pincode": "400703",
  "settings": {
    "billingDay": 1,
    "dueDay": 10,
    "defaultSplitStrategy": "apartment",
    "defaultApartmentBasis": "per_sqft_carpet",
    "approvalThresholdPaise": 1000000
  }
}
```
```json
201 Created
{
  "data": {
    "id": "b1f0…",
    "name": "Green Meadows CHS",
    "slug": "green-meadows-chs-navi-mumbai",
    "joinCode": "GRN4MZ",
    "plan": "free",
    "membership": { "id": "m-88…", "role": "admin", "status": "active" },
    "createdAt": "2026-09-19T06:12:03Z"
  },
  "meta": { "requestId": "req_9k2…" }
}
```

### POST /societies/:id/apartments/generate
```json
{
  "buildingId": "bld-1",
  "pattern": "{wing}-{floor}{unit:02d}",
  "wings": ["A", "B"],
  "floors": { "from": 1, "to": 8 },
  "unitsPerFloor": 4,
  "defaults": { "bhk": 2, "carpetAreaSqft": 720, "parkingSlots": 1 }
}
```
```json
201 Created
{ "data": { "created": 64, "sample": ["A-101","A-102","A-103","A-104","B-101"],
            "skippedDuplicates": 0 } }
```

### POST /expenses/preview-split
Drives the live split editor; performs no writes.
```json
{
  "amountPaise": 6000000,
  "splitStrategy": "apartment",
  "apartmentBasis": "per_sqft_carpet",
  "participantSelector": { "scope": "society", "includeVacant": true, "ownerOnly": false }
}
```
```json
200 OK
{
  "data": {
    "totalPaise": 6000000,
    "participantCount": 64,
    "allocations": [
      { "memberId": "m-01", "apartmentId": "ap-01", "apartmentNumber": "A-101",
        "weight": 720, "amountPaise": 93751 },
      { "memberId": "m-02", "apartmentId": "ap-02", "apartmentNumber": "A-102",
        "weight": 720, "amountPaise": 93750 }
    ],
    "residualPaise": 0,
    "warnings": [
      { "code": "MISSING_AREA", "message": "3 apartments have no carpet area and were excluded",
        "apartmentIds": ["ap-58","ap-59","ap-60"] }
    ]
  }
}
```

### POST /societies/:id/expenses
```json
{
  "title": "Lift AMC — Q3 FY26-27",
  "amountPaise": 4500000,
  "expenseDate": "2026-09-15",
  "categoryId": "cat-lift",
  "vendorName": "Kone India Pvt Ltd",
  "paymentSource": "society_account",
  "paidByMemberId": "m-treasurer",
  "splitStrategy": "apartment",
  "apartmentBasis": "per_floor_band",
  "splitConfig": { "floorBands": [ {"from":0,"to":0,"mult":0},
                                   {"from":1,"to":3,"mult":1},
                                   {"from":4,"to":8,"mult":1.5} ] },
  "participantSelector": { "scope": "building", "buildings": ["bld-1"] },
  "gst": { "gstin": "27AABCK1234M1Z5", "invoiceNumber": "KON/26-27/1187",
           "invoiceDate": "2026-09-15", "taxableValuePaise": 3813559,
           "cgstPaise": 343220, "sgstPaise": 343221, "hsnSac": "998719",
           "placeOfSupply": "Maharashtra", "itcEligible": false },
  "notes": "Covers Oct–Dec. Includes 4 preventive visits.",
  "status": "published"
}
```
```json
201 Created
{
  "data": {
    "id": "exp-77…",
    "status": "published",
    "amountPaise": 4500000,
    "splitSummary": { "participantCount": 60, "minPaise": 0, "maxPaise": 112500 },
    "duesCreated": 52,
    "version": 1,
    "publishedAt": "2026-09-19T06:31:44Z"
  }
}
```

### PATCH /expenses/:eid
```json
{ "amountPaise": 4800000, "changeNote": "Vendor revised invoice", "expectedVersion": 1 }
```
```json
200 OK
{
  "data": {
    "id": "exp-77…", "version": 2, "amountPaise": 4800000,
    "recalculation": { "duesUpdated": 52, "deltaPerFlatPaise": 5000,
                       "blockedByPaidSplits": 0 }
  }
}
```
```json
409 Conflict
{ "error": { "code": "CONFLICT", "message": "This expense was modified by Ramesh I. 40 seconds ago.",
             "details": { "currentVersion": 3 } } }
```

### POST /payments/intent
```json
{ "dueIds": ["due-1","due-2"], "amountPaise": 425000, "method": "upi" }
```
```json
200 OK
{
  "data": {
    "paymentId": "pay-9a…",
    "razorpayOrderId": "order_PqR7…",
    "razorpayKeyId": "rzp_live_XXXX",
    "amountPaise": 425000,
    "currency": "INR",
    "prefill": { "name": "Priya Nair", "contact": "+919812345678", "email": "priya@…" },
    "notes": { "societyId": "b1f0…", "memberId": "m-02" }
  }
}
```

### POST /payments/verify
```json
{ "paymentId": "pay-9a…", "razorpayPaymentId": "pay_PqR8…",
  "razorpayOrderId": "order_PqR7…", "razorpaySignature": "9f2c…" }
```
```json
200 OK
{
  "data": {
    "paymentId": "pay-9a…", "status": "verified", "amountPaise": 425000,
    "allocations": [ { "dueId": "due-1", "amountPaise": 325000, "dueStatus": "paid" },
                     { "dueId": "due-2", "amountPaise": 100000, "dueStatus": "partial" } ],
    "receipt": { "id": "rcp-31…", "receiptNumber": "RCPT/GRNM/2026-27/0412",
                 "url": "https://cdn…/receipt.pdf?sig=…" },
    "balanceAfterPaise": 75000
  }
}
```

### POST /payments/offline
```json
{ "memberId": "m-14", "amountPaise": 500000, "method": "cheque",
  "chequeNumber": "004512", "chequeBank": "HDFC", "chequeDate": "2026-09-18",
  "paidAt": "2026-09-18T10:00:00Z", "dueIds": ["due-31"], "proofAttachmentId": "att-9" }
```
```json
201 Created
{ "data": { "paymentId": "pay-b2…", "status": "unverified",
            "requiresVerificationBy": ["treasurer","admin"] } }
```

### GET /societies/:id/outstanding
```json
200 OK
{
  "data": {
    "totalOutstandingPaise": 28450000,
    "collectionRate": 0.78,
    "ageing": { "d0_30": 9800000, "d31_60": 7200000, "d61_90": 4950000, "d90_plus": 6500000 },
    "members": [
      { "memberId": "m-44", "displayName": "R. Sharma", "apartmentNumber": "B-604",
        "outstandingPaise": 1850000, "oldestDueDate": "2026-03-10", "daysOverdue": 193,
        "lastPaymentAt": "2026-02-08T…" }
    ]
  },
  "meta": { "nextCursor": "eyJ…", "hasMore": true }
}
```

### POST /cycles/:cid/publish
```json
{ "confirmTotalPaise": 24960000, "sendNotifications": true }
```
```json
200 OK
{ "data": { "cycleId": "cyc-10", "status": "published", "expensesCreated": 8,
            "duesCreated": 64, "totalBilledPaise": 24960000,
            "notificationsQueued": 121, "billsGenerated": 64 } }
```

### POST /webhooks/razorpay
```http
X-Razorpay-Signature: 3f9a…
{ "event": "payment.captured",
  "payload": { "payment": { "entity": { "id":"pay_PqR8…", "order_id":"order_PqR7…",
               "amount": 425000, "status":"captured", "method":"upi", "fee": 0 } } } }
```
Server: verify HMAC-SHA256 over the raw body → look up by `order_id` → if already verified, return 200 (idempotent) → else mark verified, allocate, issue receipt, notify. **Always 200 on duplicate; only 4xx on bad signature.**

### POST /ai/search
```json
{ "query": "plumbing expenses above 5000 last quarter" }
```
```json
200 OK
{
  "data": {
    "interpretation": {
      "entity": "expenses",
      "filters": { "categoryNames": ["Plumbing"], "amountPaiseMin": 500000,
                   "dateFrom": "2026-04-01", "dateTo": "2026-06-30" },
      "confidence": 0.93
    },
    "results": [ { "id": "exp-21", "title": "Overhead tank pipeline repair",
                   "amountPaise": 1840000, "expenseDate": "2026-05-22" } ],
    "resultCount": 4, "totalPaise": 4120000
  }
}
```

### GET /sync/changes
```http
GET /v1/sync/changes?since=2026-09-18T10:00:00Z&entities=expenses,dues,payments,notices
```
```json
200 OK
{
  "data": {
    "serverTime": "2026-09-19T06:40:11Z",
    "changes": {
      "expenses": { "upserted": [ { } ], "deletedIds": ["exp-3"] },
      "dues":     { "upserted": [ { } ], "deletedIds": [] }
    },
    "truncated": false,
    "nextSince": "2026-09-19T06:40:11Z"
  }
}
```

### POST /sync/batch (outbox flush)
```json
{ "operations": [
  { "opId": "local-uuid-1", "entity": "expenses", "op": "create",
    "clientCreatedAt": "2026-09-19T05:02:10Z", "payload": { } },
  { "opId": "local-uuid-2", "entity": "complaints", "op": "update",
    "entityId": "cmp-9", "baseVersion": 4, "payload": { "status": "in_progress" } }
] }
```
```json
200 OK
{
  "data": { "results": [
    { "opId": "local-uuid-1", "status": "applied", "serverId": "exp-91", "version": 1 },
    { "opId": "local-uuid-2", "status": "conflict", "reason": "VERSION_MISMATCH",
      "serverState": { "status": "resolved", "version": 6 } }
  ] }
}
```

## 8.4 Rate Limits
| Scope | Limit |
|---|---|
| Global per IP | 300 req/min |
| Per authenticated user | 120 req/min |
| `/auth/otp/request` | 3/hour/number, 10/day/number, 20/day/IP |
| `/auth/login` | 5 failures/15 min/identity |
| `/ai/*` | 20/day free, 200/day paid, 5/min burst |
| Report export | 10/hour/society |
| `/sync/batch` | 60/min/user, ≤ 200 ops per request |

## 8.5 Versioning & Deprecation
URL-versioned (`/v1`). Additive changes ship without a version bump; breaking changes create `/v2` with ≥ 6 months of parallel support. Clients send `X-Client-Version`; the server may return `426 Upgrade Required` with a store link for versions below `minSupportedVersion` from `/config`.

---

# 9. State Management

## 9.1 Recommendation

| Concern | Choice |
|---|---|
| **Server state** | **TanStack Query v5** (`@tanstack/react-query`) |
| **Client/UI state** | **Zustand** (small, selector-based stores) |
| **Persistence** | **MMKV** (`react-native-mmkv`) for KV; **SQLite** (`expo-sqlite`, Drizzle ORM) for the offline record store |
| **Offline queue** | Custom **outbox table in SQLite**, drained by a sync engine |
| **Secrets** | `expo-secure-store` (Keychain / Android Keystore) |
| **Forms** | `react-hook-form` + `zod` resolver |
| **Navigation state** | Expo Router (owns its own state — do not duplicate it) |

**Explicitly do not use:** Redux Toolkit (too much ceremony for this domain, and RTK Query duplicates what TanStack does better here), MobX (implicit reactivity is hard to audit in a financial app), Recoil/Jotai as the primary store (fine for micro-state, insufficient for sync), Context as a state manager (re-render storms on a 64-row cycle grid).

## 9.2 Why

1. **The app is overwhelmingly server state.** Expenses, dues, payments, notices — these are caches of server truth, not client state. TanStack Query is purpose-built for cache lifecycle: staleness, background refetch, retries, deduping, pagination, optimistic updates with automatic rollback. Modelling this in Redux means hand-writing loading/error/stale flags for ~40 resources.
2. **Optimistic updates are a first-class requirement.** Adding an expense offline must appear instantly and roll back cleanly on failure. `onMutate`/`onError`/`onSettled` gives exactly that contract, per mutation.
3. **Zustand covers the genuinely-client slice** — `activeSocietyId`, theme, draft forms, filter selections, onboarding step, sync status — in ~50 lines total, with no providers and no re-render cascades thanks to selector subscriptions.
4. **MMKV is 10–30× faster than AsyncStorage** and synchronous, so the theme and active society resolve before first paint (no flash of wrong state on cold start on a cheap Android).
5. **SQLite is required, not optional.** Offline-first over hundreds of expenses and dues needs relational queries, indexes and transactions. A JSON blob in AsyncStorage cannot serve "all overdue dues for building B sorted by ageing" on a 3-year-old phone.
6. **Separation of duties keeps the money path auditable.** Server state is never mutated directly; every write goes through a mutation → outbox → server → invalidation cycle. There is exactly one path by which a balance can change.

## 9.3 Structure

```ts
// Query key factory — single source of truth, all society-scoped
export const qk = {
  society: (sid: string) => ['society', sid] as const,
  expenses: (sid: string, f?: ExpenseFilters) => ['society', sid, 'expenses', f ?? {}] as const,
  expense:  (sid: string, id: string) => ['society', sid, 'expense', id] as const,
  dues:     (sid: string, mid?: string) => ['society', sid, 'dues', mid ?? 'all'] as const,
  balance:  (sid: string, mid: string) => ['society', sid, 'balance', mid] as const,
  outstanding: (sid: string) => ['society', sid, 'outstanding'] as const,
};
```
Every key begins with `['society', sid]`, so switching societies invalidates cleanly and no data can leak across tenants in the cache.

**Stale times (tuned to volatility):**
| Data | staleTime | gcTime |
|---|---|---|
| Society profile, settings, members | 30 min | 24 h |
| Categories, charge heads | 1 h | 24 h |
| Expenses list | 2 min | 24 h |
| Dues / balance | 30 s | 24 h |
| Outstanding report | 5 min | 6 h |
| Notices, complaints | 1 min | 24 h |
| Notifications | 30 s | 1 h |

**Persistence:** `persistQueryClient` with an MMKV persister, `maxAge: 7 days`, and a `buster` keyed to the app version so a schema change cannot resurrect an incompatible cache.

**Zustand stores:** `useAuthStore` (tokens are in SecureStore; only the derived user lives here), `useSocietyStore` (`activeSocietyId`, `role`, permission helper), `useSyncStore` (online flag, pending count, last sync, per-item errors), `useUIStore` (theme, language, banners), `useDraftStore` (autosaved form drafts, persisted).

**Rules for the implementing agent**
- No `useEffect` fetching. Ever. All reads go through a `useQuery` hook in `src/features/*/hooks`.
- No raw `fetch` in components. Use the generated API client.
- Mutations invalidate by key prefix, not by refetching everything.
- Derive; do not store. Outstanding totals are computed from cached dues, not duplicated into a store.
- Any component reading more than 3 Zustand slices is doing too much — push logic into a hook.

---

# 10. Offline Support

## 10.1 Model

Three layers:
1. **SQLite (source of truth on device)** — mirrors the server's tenant-scoped tables via Drizzle. All UI reads hit SQLite.
2. **TanStack Query** — in-memory cache over SQLite reads + network revalidation.
3. **Outbox** — an append-only local table of pending mutations, drained in order.

```sql
-- local only
CREATE TABLE outbox (
  op_id TEXT PRIMARY KEY,            -- client uuid, also the idempotency key
  entity TEXT NOT NULL,
  op TEXT NOT NULL,                  -- create|update|delete
  entity_id TEXT,                    -- local temp id or server id
  base_version INTEGER,
  payload TEXT NOT NULL,             -- JSON
  attachments TEXT,                  -- JSON array of local file URIs
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|sending|failed|conflict
  created_at TEXT NOT NULL
);
CREATE TABLE sync_meta (entity TEXT PRIMARY KEY, last_synced_at TEXT);
```

## 10.2 What works offline

| Capability | Offline |
|---|---|
| View dashboard, dues, expenses, members, notices, complaints | ✅ full |
| Create/edit expense (incl. attachments) | ✅ queued |
| Record an offline payment | ✅ queued |
| Raise/comment on a complaint | ✅ queued |
| Pre-approve a visitor | ✅ queued |
| Mark notification read | ✅ queued |
| Online payment (Razorpay) | ❌ requires network |
| OTP / login | ❌ |
| OCR, AI features | ❌ (image queued, OCR runs on reconnect) |
| Publish a maintenance cycle | ❌ (server-computed, too consequential to queue) |
| Report export | ❌ (cached reports viewable) |

## 10.3 Sync Engine

**Pull (delta):** on app foreground, on reconnect, and every 15 min while active — `GET /sync/changes?since=<cursor>&entities=…`. Upsert into SQLite inside a transaction, advance the cursor only on full success. If `truncated: true`, loop. If the cursor is older than 30 days, fall back to a full resync for that society.

**Push (outbox drain):** triggered on reconnect, on app foreground, and immediately after any local mutation when online.
- Serial by entity, batched up to 200 ops per `/sync/batch`.
- Retry with exponential backoff + jitter: 2s, 8s, 30s, 2m, 10m, 1h; max 8 attempts, then `failed` and surfaced in the Sync Status sheet for manual retry or discard.
- Attachments upload **before** the op that references them; if an upload fails, the whole op stays pending.
- **Ordering guarantee:** ops referencing a locally-created entity (temp id `local_*`) are held until that entity's create is confirmed and the id is rewritten across the outbox.
- `opId` doubles as the `Idempotency-Key`, so a retry after a lost response can never double-post a payment.

## 10.4 Conflict Resolution

Conflicts are resolved **by entity class**, not by one global rule.

| Class | Strategy | Rationale |
|---|---|---|
| **Financial records** (expenses, dues, payments, cycles) | **Server authority + optimistic version check.** Client sends `baseVersion`; mismatch → `409` with server state → surface a Sync Conflict sheet with a field-level diff and *Keep mine / Keep theirs / Merge* | Money must never be silently overwritten by a stale device |
| **User-owned content** (my comment, my complaint description, my draft) | **Last-write-wins by client timestamp**, since only one author realistically edits | Low stakes, high annoyance if blocked |
| **Append-only streams** (comments, complaint events, audit) | **Merge — never conflict.** Order by server-assigned sequence | Naturally commutative |
| **Status transitions** (complaint status, payment verification) | **Server state machine wins.** If the local transition is invalid from the server's current state, drop it and inform the user | Prevents resurrecting a closed complaint |
| **Read/ack flags, notification reads** | **Union merge**, LWW on ties | Idempotent |
| **Deletes/voids** | **Delete wins over concurrent edit**, with the edit preserved in the conflict log | Safer default for reversals |

Any op that ends in `conflict` is retained locally, shown in the Sync Status sheet, and never discarded silently. Financial conflicts additionally write an `audit_logs` entry on resolution.

## 10.5 Caching Strategy

- **Stale-while-revalidate** everywhere: render from SQLite instantly, refetch in the background, patch in.
- **Prefetch on login** for the active society: society, settings, members, apartments, categories, current cycle, my dues, last 90 days of expenses, active notices, open complaints. Roughly 1–3 MB for a 100-flat society — acceptable on first load over Wi-Fi, and the app asks before doing a full prefetch on metered mobile data.
- **Images:** `expo-image` with disk caching; bill thumbnails cached aggressively, full-resolution fetched on demand. Cache ceiling 200 MB, LRU eviction, clearable from Settings.
- **Signed URLs** are short-lived, so cache by `storage_key` and refresh the URL, not the bytes.
- **Eviction:** expenses older than 18 months are pruned from SQLite (re-fetchable on demand); notifications older than 90 days; visitor logs older than 90 days locally.
- **Multi-society:** cache only the active society plus a lightweight summary of the others; hydrate fully on switch.
- **Cold-start budget:** the dashboard must render from SQLite without any network call. Treat a network-dependent first paint as a bug.

---

# 11. Security

## 11.1 Authentication
- Argon2id password hashing (memory 19 MiB, iterations 2, parallelism 1) — never bcrypt-with-low-cost, never SHA.
- Access token: JWT, RS256, 60 min, claims `{ sub, sid[], jti, iat, exp, ver }`. Refresh token: opaque 256-bit random, hashed at rest, 60-day sliding expiry, **rotated on every use** with reuse detection (a replayed refresh token revokes the entire family and notifies the user).
- OTP: 6 digits from a CSPRNG, hashed at rest, 5-minute TTL, single use, max 5 verification attempts.
- OAuth: verify Google/Apple tokens server-side against the provider's JWKS; validate `aud`, `iss`, `exp`, and `nonce`. Never trust a client-decoded token.
- Biometric app-lock (optional, `expo-local-authentication`) gating the app and mandatory for viewing full financial reports when enabled.

## 11.2 Authorization
- **Defence in depth, three layers:** (1) UI hides what you cannot do, (2) API middleware enforces `can(role, action, resource)` against the central permission map, (3) Postgres RLS enforces tenancy even if the API is compromised.
- Every society-scoped query is filtered by membership — **never** by a client-supplied `society_id` alone.
- Object-level checks on every read: "is this expense's society one of my active memberships?"
- Privilege escalation guards: role changes require an admin, are logged, notify the affected user, and cannot make the caller an admin.
- Security (gate) accounts are hard-denied at the database level from all financial tables.

## 11.3 JWT Handling
- Stored in `expo-secure-store` (Keychain with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, Android Keystore-backed). **Never** in AsyncStorage, MMKV or Redux.
- Short access-token lifetime + silent refresh on foreground and on 401.
- `jti` denylist in Redis for forced logout (password reset, role revocation, device removal).
- Clock-skew tolerance 60s; reject tokens with `ver` below the current minimum (lets us invalidate all tokens after a security event).

## 11.4 Encryption
- TLS 1.3 everywhere; HSTS with preload; **certificate pinning** on the mobile client for the API domain, with a backup pin and a remote kill-switch to avoid bricking clients on rotation.
- At rest: managed disk encryption (AES-256) on the database and object storage; application-level encryption (pgcrypto/KMS) for the few high-sensitivity columns — bank account numbers (store masked + encrypted), GSTIN, phone numbers in the audit trail.
- Attachments served only via time-limited signed URLs (15 min); no public buckets, ever.
- Local SQLite encrypted with SQLCipher, key held in the OS keystore.

## 11.5 API Security
- Validate every input with **zod** on the client and the equivalent schema on the server; reject unknown fields (`.strict()`).
- Parameterised queries only. No string-built SQL anywhere, including in report generators.
- Webhook signature verification (Razorpay HMAC-SHA256 over the raw body, constant-time compare). Never parse before verifying.
- Idempotency keys on all money-moving POSTs, stored 24 h with the response.
- CORS locked to known origins; no wildcard. CSP on all web views.
- Output encoding on all user-generated content; sanitise notice/complaint HTML server-side with an allowlist.
- File uploads: verify magic bytes not extensions, cap at 10 MB, strip EXIF (including GPS) from images, virus-scan asynchronously, serve from a separate domain.
- Secrets in a managed secret store; never in the repo, never in `app.json`, never in `EXPO_PUBLIC_*` unless genuinely public.
- SSRF protection on any URL the server fetches; deny private IP ranges.

## 11.6 Rate Limiting & Abuse
- Token-bucket per IP, per user and per society (limits in §8.4), backed by Redis.
- Progressive lockouts on auth endpoints; CAPTCHA (hCaptcha) after repeated failures on web.
- Anomaly alerts: bulk member export, mass deletion, a role change followed by a large expense void, > 50 failed payments in an hour.
- Bot/emulator signals on OTP requests; device attestation (Play Integrity / App Attest) before high-value actions in Phase 3.

## 11.7 Audit Logging
Every mutation on money, membership, roles and society structure writes an `audit_logs` row with actor, role, action, before/after JSON, IP, user agent and request id. The table is INSERT-only for the application role; UPDATE/DELETE are revoked. Retention 7 years (Indian societies are expected to retain financial records for years). Admins can view and export; the log itself records who viewed it.

## 11.8 Secure Storage & Device Hygiene
- Tokens and the SQLCipher key in SecureStore; nothing sensitive in MMKV.
- Screenshot blocking (`expo-screen-capture`) on payment and full-ledger screens (Android `FLAG_SECURE`).
- Auto-clear the local database on logout; wipe everything for the society on removal from it.
- Jailbreak/root detection as a soft signal (warn + log, do not block — false positives are common on Indian custom ROMs).
- No PII in logs, crash reports or analytics events. Scrub before sending to Sentry.

## 11.9 Compliance & Privacy (India)
- **DPDP Act 2023:** explicit consent at signup for processing purposes; a privacy notice in English and the user's chosen language; data-principal rights implemented (access, correction, erasure-with-financial-retention-exception, grievance officer contact in-app); breach notification process documented.
- Data residency in an India region (`ap-south-1` / equivalent).
- No storage of card numbers, CVV or UPI PINs — **ever**. Razorpay is the PCI-DSS boundary; the app is out of PCI scope by construction.
- Data retention: financial 7 years, visitor logs 12 months, notifications 90 days, auth logs 1 year.
- Third-party sub-processors listed publicly (Razorpay, MSG91, Expo, hosting, model providers).

---

# 12. Analytics

**Stack:** PostHog (product analytics + feature flags + session replay, self-hostable in India) + Sentry (crash/performance) + a small internal metrics table for society-level business KPIs.

## 12.1 Principles
- Event names: `object_verb_snake_case` (`expense_created`, `payment_completed`).
- Every event carries `society_id` (hashed), `role`, `plan`, `platform`, `app_version`, `is_offline`, `society_size_bucket`.
- **No PII in properties.** No names, phones, emails, flat numbers or amounts at individual granularity — amounts are bucketed (`<1k`, `1k-5k`, `5k-25k`, `25k+`).
- Consent-gated analytics with an opt-out in Settings; opt-out disables product analytics, never crash reporting of anonymised stack traces.

## 12.2 Event Taxonomy

**Acquisition & activation**
`app_installed`, `onboarding_started`, `onboarding_completed`, `signup_started {method}`, `signup_completed {method}`, `login_succeeded {method}`, `login_failed {reason}`, `society_created {size_bucket}`, `society_join_requested {via}`, `society_join_approved`, `invite_sent {channel, count}`, `invite_accepted {channel}`, `first_expense_created` ⭐, `first_payment_received` ⭐

**Core engagement**
`expense_created {category, split_strategy, has_attachment, source}`, `expense_edited`, `expense_voided`, `split_previewed {strategy}`, `split_strategy_changed {from, to}`, `bill_scanned`, `ocr_accepted {fields_accepted, confidence_bucket}`, `ocr_rejected`, `cycle_generated`, `cycle_published {flat_count}`, `reminder_sent {channel, recipient_count}`, `payment_initiated {method}`, `payment_completed {method, latency_ms}`, `payment_failed {reason}`, `offline_payment_recorded`, `payment_verified`, `receipt_downloaded`, `report_viewed {type}`, `report_exported {type, format}`, `complaint_raised {category, priority}`, `complaint_resolved {hours_to_resolve}`, `notice_posted {type}`, `visitor_approved {latency_seconds}`, `ai_feature_used {feature}`, `ai_suggestion_accepted {feature}`, `nl_search_performed {result_count}`

**Retention & health**
`session_started`, `session_ended {duration}`, `dashboard_viewed`, `notification_received`, `notification_opened {type}`, `sync_completed {ops, duration_ms}`, `sync_conflict {entity, resolution}`, `offline_mode_entered {duration}`, `app_error {code, screen}`, `crash`

**Monetization**
`paywall_viewed {feature, plan}`, `plan_comparison_viewed`, `upgrade_started {plan}`, `upgrade_completed {plan, amount_bucket}`, `upgrade_abandoned {step}`, `subscription_renewed`, `subscription_cancelled {reason}`, `referral_shared`, `referral_converted`

## 12.3 Core Metrics

| Metric | Definition |
|---|---|
| **DAU** | Distinct users with ≥ 1 session per day |
| **MAU** | Distinct users with ≥ 1 session per 30 days |
| **DAU/MAU stickiness** | Target ≥ 0.25 for treasurers, ≥ 0.12 overall (this is a low-frequency product by nature — a resident checking monthly is a *healthy* resident) |
| **Society MAU** | Societies with ≥ 1 active user — the metric that actually matters commercially |
| **Activation rate** | % of created societies reaching ≥ 5 members **and** ≥ 1 published expense within 7 days |
| **Time to first expense** | Median minutes from society creation |
| **Retention** | D1/D7/D30 for users; **M1/M3/M6/M12 for societies** (the real retention curve — target M6 ≥ 70%, M12 ≥ 60%) |
| **Collection rate** | Value collected ÷ value billed, per society per cycle — our proof of value |
| **Payment success rate** | Completed ÷ initiated online payments (target ≥ 92%) |
| **Feature adoption** | % of active societies using: cycles, online payments, complaints, notices, AI |
| **Revenue** | MRR, ARR, ARPS (per society), LTV, CAC, payback months |
| **Conversion** | Free → paid society conversion (target 8–12% by month 12) |
| **Churn** | Society-level monthly logo churn (target < 2.5%) and net revenue retention (target > 100% via flat growth) |
| **NPS** | In-app survey to treasurers after their 3rd published cycle |

## 12.4 Dashboards
1. **Growth** — new societies, members, activation funnel, invite channel performance.
2. **Engagement** — DAU/MAU, feature adoption, cycles published per week, sessions by role.
3. **Money** — GMV processed, collection rates, payment success, gateway failures by method.
4. **Revenue** — MRR by plan, conversion funnel, churn cohorts.
5. **Reliability** — crash-free %, p50/p95 API latency, sync failure rate, push delivery rate.
6. **AI** — suggestion acceptance rate by feature, OCR field accuracy, cost per society.

---

# 13. Subscription Model

Priced for Indian societies, where the decision is made by a volunteer committee comparing against ₹0 (a spreadsheet). The free tier must be genuinely useful; paid tiers must be obviously cheap relative to the money being managed.

## 13.1 Plans

### Free — ₹0
*For roommates and small societies.*
- Up to **25 apartments/units**, unlimited members within them
- Unlimited expenses, all 5 split strategies
- Manual/offline payment tracking, dues and balances
- Notice board, complaints (up to 20 open), basic visitor log
- Monthly report (in-app view only, no export)
- 12 months of history retained
- 500 MB attachment storage
- Push notifications
- Community support
- Small in-app house/partner promo slot

### Premium — ₹499/month or **₹4,999/year** (society, up to 50 units)
*For a small society that wants to stop chasing.*
Everything in Free, plus:
- Up to 50 units
- **Online payments** via Razorpay with auto-reconciliation
- Automated maintenance cycles + recurring charges
- Automated reminders (push + email; 200 SMS/year included)
- PDF/CSV export of all reports; branded bills and receipts
- Bill OCR (300 scans/month), duplicate detection, anomaly alerts
- Full history retention, 5 GB storage
- Ad-free
- Email support (48 h)

### Society Pro — ₹1,999/month or **₹19,999/year** (up to 200 units) · **₹99/unit/year** above 200
*The default for a real mid-size society.*
Everything in Premium, plus:
- Up to 200 units, multi-building and multi-wing
- Full role hierarchy, expense approval workflows
- Budget planning and variance analysis, annual AGM report pack
- All AI features: forecasting, insights, natural-language search, AI assistant
- WhatsApp bills and reminders (1,000 messages/year included)
- Unlimited SMS reminders for financial events (fair-use 5,000/year)
- Visitor management with gate accounts and delivery tracking
- Data export (full database dump), API access (read)
- Priority support (24 h), onboarding call, data migration from spreadsheets
- Guest auditor access links

### Enterprise — from **₹1,49,000/year**, custom
*Large complexes, townships, builder portfolios, facility-management companies.*
Everything in Society Pro, plus:
- Unlimited units; multi-society portfolio dashboard
- Custom roles and approval chains
- SSO/SAML, audit exports, data residency guarantees
- Accounting-system integration (Tally/Zoho Books export), full API access
- White-label branding
- Dedicated account manager, SLA (99.9%), training for committees
- Annual invoicing with GST, PO support

## 13.2 Pricing Table

| | Free | Premium | Society Pro | Enterprise |
|---|---|---|---|---|
| Units | 25 | 50 | 200 (+₹99/unit) | Unlimited |
| Annual price | ₹0 | ₹4,999 | ₹19,999 | from ₹1,49,000 |
| **Per flat/month** | ₹0 | **~₹8.3** | **~₹8.3** | negotiated |
| Online payments | — | ✅ | ✅ | ✅ |
| Auto maintenance cycles | — | ✅ | ✅ | ✅ |
| Report export | — | ✅ | ✅ | ✅ |
| AI: OCR, duplicates, anomalies | — | ✅ | ✅ | ✅ |
| AI: forecast, insights, assistant | — | — | ✅ | ✅ |
| WhatsApp bills | — | — | ✅ | ✅ |
| Visitor management | basic | basic | full | full |
| Approval workflows | — | — | ✅ | ✅ |
| Support | community | email 48h | priority 24h | dedicated + SLA |

**Anchoring:** a 96-flat society collecting ₹3,000/flat/month manages ₹34.5 lakh a year. Society Pro costs ₹19,999 — **0.06% of the money it governs**, or ₹17 per flat per month. Say exactly this on the paywall.

## 13.3 Commercial Rules
- **Annual is the default**, presented first, with the monthly price shown struck through (~17% saving). Indian societies budget annually and pay annually.
- 14-day free trial of Society Pro, no card required, triggered at the moment of highest intent (first cycle publish).
- Society-level billing, never per-user — residents must never see a paywall.
- Downgrade is non-destructive: data is retained read-only; over-limit features are disabled, nothing is deleted.
- Pro-rated upgrades mid-term; unit-count overages billed at renewal, not mid-cycle.
- Registered non-profit societies and NGOs: 25% discount on request.
- Referral: both societies get 2 months free (see §14).
- 30-day money-back guarantee on the first annual purchase. Publish it — it dissolves committee hesitation.

---

# 14. Monetization

## 14.1 Revenue Streams (ranked by expected contribution at scale)

**1. Subscriptions — 70–80% of revenue.** The core engine. Yearly plans reduce churn and fund CAC. Focus expansion revenue on unit growth and tier upgrades rather than per-seat pricing.

**2. Payment gateway commission — 10–20%.** Register as a Razorpay partner/platform and earn a share of the MDR on payments processed through the app. UPI MDR on P2M is effectively zero in India, so the realistic margin comes from card and netbanking volume, plus a small **convenience fee** option (society-configurable, ₹5–10 per online transaction, disclosed to the payer, defaulting off). At ₹100 crore of annual GMV with ~25% on cards/netbanking at a ~25 bps share, that is ~₹62 lakh/year. **Never** silently skim from a society's collection — every rupee of fee is itemised on the receipt. Trust is the product.

**3. Premium features / add-ons — 5–10%.** À-la-carte for societies that will not upgrade a whole tier: extra SMS/WhatsApp credit packs (₹499 per 1,000), additional storage (₹199/10 GB/year), AI credit top-ups, an annual AGM report design pack, spreadsheet migration service (₹2,999 one-time).

**4. Advertisements — < 5%, free tier only.** Tightly constrained: no third-party ad SDKs (they leak data and degrade performance on cheap phones), no behavioural targeting, no ads on any financial screen. Instead, curated **local service listings** relevant to societies — plumbers, electricians, pest control, housekeeping agencies, insurance, solar and water-tanker vendors — shown in a single slot on the More tab and in the complaint flow ("need a plumber? verified vendors near you"). Charged as a flat monthly listing fee per city, or a lead fee. This is the only ad format that is actually useful to the user, and it is removed entirely on every paid plan.

**5. Referral rewards — growth, not revenue.** A treasurer who refers a society that converts to paid gets 2 months added to their own plan; the referred society gets 2 months free. Individual residents who bring their society onboard get a ₹250 voucher after the society's first paid cycle. Attribution via a per-society referral code; rewards credited only after payment clears, to stop gaming. Target: ≥ 25% of new paid societies from referrals by month 18 — societies talk to each other constantly through federation bodies and WhatsApp groups, and this is the cheapest channel available.

**6. Future / Phase 4 options (validate before building):** vendor marketplace take-rate on verified service bookings; insurance and loan distribution partnerships (regulated — requires licensing, treat carefully); anonymised benchmarking reports sold to facility-management firms (only with opt-in and k-anonymity).

## 14.2 Conversion Design
- **Value-first paywalls.** Block on the moment of proven value, never on basic transparency. Publishing a cycle, exporting a report, and turning on online payments are the three natural gates.
- Show the cost anchoring line (§13.2) on every paywall.
- A "request upgrade" flow so a Treasurer who cannot pay can push the decision to the Admin with a pre-filled justification — the buyer and the user are often different people.
- Annual renewal reminder at T−30 with a value summary ("last year we processed ₹41L and saved 118 reminder hours").
- Dunning: 3 retries over 14 days, then a 30-day read-only grace period before restriction. Never delete data over a failed payment.

## 14.3 Unit Economics (planning assumptions)
| Input | Assumption |
|---|---|
| CAC (organic/referral-led) | ₹1,200–2,500 per society |
| ARPS | ₹12,000/year blended |
| Gross margin | ~80% (infra + SMS + AI ≈ ₹180–250/society/month at scale) |
| Payback | < 4 months |
| Society LTV (M12 retention 60%, 3.5-yr life) | ₹35,000–45,000 |
| LTV:CAC | > 15:1 target, > 5:1 floor |

**Cost watch-items:** SMS is the single biggest variable cost — push and WhatsApp aggressively over SMS. AI inference is second — cache OCR by image hash, use small models for classification, and cap free-tier AI entirely.

---

# 15. Future Roadmap

## Phase 1 — MVP (Months 0–3)
**Goal:** a treasurer can run one society's finances end to end and never open the spreadsheet again.

Auth (phone OTP, email, Google, Apple) · society creation with buildings/wings/flats · invites and join codes · member management with roles · expenses with attachments · all 5 split strategies · dues and balances · offline payment recording · Razorpay online payments · basic maintenance cycles · notice board · my-dues and payment history · receipts · monthly report (in-app) · push notifications · offline-first read + queued writes · MD3 UI with dark mode · English only.

**Exit criteria:** 25 pilot societies; ≥ 70% of them publish 2 consecutive cycles; collection rate ≥ 80%; crash-free ≥ 99.3%.

## Phase 2 — Retention & Depth (Months 4–7)
Full recurring maintenance engine with charge heads and meter readings · late fees · arrears carry-forward · complaints with SLA and timeline · automated reminders across channels · report export (PDF/CSV) and annual report · budget setup · **Bill OCR, duplicate detection, anomaly alerts** · WhatsApp bills and reminders · 8 Indian languages · visitor management with gate accounts · expense approval workflow · Premium and Society Pro plans live · referral programme · audit log UI.

**Exit criteria:** 300 active societies; society M3 retention ≥ 75%; 8% free→paid conversion; ≥ 40% of payments online.

## Phase 3 — Intelligence & Community (Months 8–14)
AI assistant, natural-language search, financial insights, maintenance forecasting · vendor management with ratings and payment history · facility/amenity booking (clubhouse, hall, courts) · polls and AGM voting with quorum tracking · document vault (bylaws, agreements, audited statements) · staff/daily-help attendance and payroll assist · multi-society portfolio view · web admin console (read + key write actions) · Tally/Zoho export · enterprise SSO · accounting-grade fund tracking (maintenance/sinking/corpus).

**Exit criteria:** 1,500 societies; ₹50 crore annual GMV processed; NRR > 105%; AI feature adoption ≥ 45% of Pro societies.

## Phase 4 — Platform (Months 15–24+)
Public API and webhooks for third parties · verified vendor marketplace with in-app booking and escrow-free payments · cross-society benchmarking (opt-in, anonymised) · IoT integrations (smart water/electricity meters, gate hardware) · white-label for builders and facility-management companies · society federation/apex-body dashboards · financial products distribution (regulated, partner-led) · expansion to comparable markets (UAE, SEA) where the housing-society structure resembles India's.

---

# 16. Technical Stack

## 16.1 Frontend (fixed)
| Layer | Choice |
|---|---|
| Framework | **Expo SDK (latest stable)**, React Native, **TypeScript strict** |
| Router | **Expo Router v4+** (file-based, typed routes, deep linking) |
| UI | **react-native-paper v5** (MD3) + custom theme; `expo-image`, `@shopify/flash-list` |
| Animation | `react-native-reanimated` v3, `react-native-gesture-handler` |
| Server state | `@tanstack/react-query` v5 |
| Client state | `zustand` |
| Local DB | `expo-sqlite` + **Drizzle ORM** (+ SQLCipher) |
| KV | `react-native-mmkv` |
| Secure storage | `expo-secure-store` |
| Forms/validation | `react-hook-form` + `zod` |
| Charts | `victory-native` (Skia) or `react-native-gifted-charts` |
| i18n | `i18next` + `react-i18next` + `expo-localization` |
| Payments | `react-native-razorpay` |
| Notifications | `expo-notifications` |
| Media | `expo-camera`, `expo-image-picker`, `expo-image-manipulator`, `expo-document-picker`, `expo-file-system` |
| Build/deploy | **EAS Build + EAS Update** (OTA), EAS Submit |
| Monitoring | `sentry-expo`, PostHog RN SDK |
| Testing | Jest + React Native Testing Library, **Maestro** for E2E |

Use the Expo **managed workflow with config plugins** (`expo-dev-client` where a native module needs it). Do not eject unless a hard blocker appears — EAS Update's OTA capability is a major operational advantage for a small team.

## 16.2 Backend — Recommendation

**Primary recommendation: Supabase (managed Postgres) + a dedicated NestJS service for financial logic.**

Rationale:
- **Supabase gives Postgres, Auth, Storage, Realtime and RLS on day one**, with an India region available. For a 2–4 engineer team shipping an MVP in 3 months, this removes months of undifferentiated work (auth flows, file storage, row-level tenancy, realtime subscriptions).
- **But do not put the money logic in the database layer alone.** Split calculation, cycle publishing, payment allocation, receipt numbering and webhook handling belong in a **NestJS (TypeScript) service** — same language as the app, strong module/DI structure, first-class testing, and an OpenAPI generator that produces the typed client the app consumes. The financial core deserves explicit, unit-tested, version-controlled application code rather than a sprawl of SQL functions.
- Everything else (simple CRUD reads, auth, storage, realtime) can go direct to Supabase with RLS, which keeps the custom surface small.

Architecture:
```
Expo app
  ├── Supabase client ──► Auth, Storage, Realtime, simple RLS-protected reads
  └── API client ──────► NestJS (Fly.io / Railway / AWS ap-south-1)
                            ├── split engine, cycle engine, allocation, receipts
                            ├── Razorpay integration + webhooks
                            ├── notification orchestration (Expo Push, MSG91, Resend)
                            ├── report generation (worker)
                            ├── AI orchestration (OCR, insights, NL search)
                            └── BullMQ + Redis for jobs and scheduling
```

**Alternatives considered:**
| Option | Verdict |
|---|---|
| Firebase | ❌ Firestore's document model is a poor fit for a relational ledger with aggregate integrity; no SQL for reports; costly at read-heavy scale |
| Supabase only (Edge Functions for everything) | 🟡 Viable for a pure MVP, but Deno edge functions are awkward for long-running report/PDF jobs and complex transactional logic |
| NestJS + self-managed Postgres from day one | 🟡 Most control, but 4–6 extra weeks on auth/storage/RLS that Supabase gives free |
| Django/Rails | 🟡 Excellent admin tooling, but a second language splits a small team's context |
| Serverless (Lambda) | ❌ Cold starts hurt a latency-sensitive mobile app; connection pooling with Postgres adds friction |

**Migration path:** because all money logic already lives in NestJS and Supabase is standard Postgres, moving off Supabase later is a database migration plus an auth swap — not a rewrite. Keep Supabase-specific calls behind a thin adapter to preserve that option.

## 16.3 Database
**PostgreSQL 15+** (via Supabase, then RDS/Aurora ap-south-1 at scale). Non-negotiable because: money needs ACID transactions and constraints; reports need real SQL (window functions, CTEs, `generate_series` for period gaps); RLS gives database-enforced multi-tenancy; `jsonb` handles split configs and audit snapshots without a second datastore; extensions (`pg_trgm` for duplicate/vendor matching, `pgcrypto`, `pg_stat_statements`, optionally `pgvector` for AI retrieval) cover the AI roadmap.

Supporting stores: **Redis** (cache, rate limits, BullMQ), **object storage** for files. Add a read replica for reports before adding any analytics warehouse.

## 16.4 Authentication
**Supabase Auth** — native phone OTP, email/password, Google and Apple OAuth, JWT issuance that integrates directly with RLS, MFA support, and no per-MAU pricing cliff. Pair it with **MSG91** as the SMS provider for DLT-compliant Indian OTP delivery.

Alternatives: Clerk (best DX, excellent UI components, but priced per MAU which is punishing at Indian ARPU and its India SMS story is weaker); Auth0 (enterprise-grade, expensive, overkill); Firebase Auth (good phone auth, but pulls you into the Firebase ecosystem you are otherwise not using); roll-your-own (never — this is the single worst place to spend novelty).

## 16.5 Storage
**Supabase Storage** for the MVP (S3-compatible, integrates with the same RLS policies, signed URLs built in). At scale or if storage costs dominate, migrate to **Cloudflare R2** — S3-compatible with **zero egress fees**, which matters because bill images and receipts are read far more often than written. Keep AWS S3 (ap-south-1) as the enterprise/data-residency option. Access exclusively via short-lived signed URLs; front with a CDN for thumbnails.

## 16.6 Notifications
**Expo Push Notifications** as the unified layer over FCM and APNs — one API for both platforms, free, handles token management and receipt checking, and works seamlessly with EAS. Configure FCM v1 and APNs keys directly so there is a migration path to raw FCM if Expo's service ever becomes a constraint.
- **Email:** Resend (great DX, React Email templates) or AWS SES at volume.
- **SMS:** MSG91 (DLT registration, Indian delivery rates) with Twilio failover.
- **WhatsApp:** Meta Cloud API via an approved BSP (AiSensy/Gupshup/Interakt) — Phase 2, and likely the highest-ROI channel in this market.
- **In-app:** the `notifications` table is always the source of truth; push is a delivery mechanism, not a store.

## 16.7 Payments — Razorpay
- **Razorpay Route / Partner model** so collections settle directly into each society's own bank account rather than pooling through us — this is both a trust requirement and a regulatory simplification.
- Support UPI (intent + collect + autopay mandates), cards, netbanking, wallets. Order UPI first in the checkout.
- **UPI AutoPay mandates** (Phase 2) for recurring maintenance — the single biggest lever on collection rate.
- Webhooks are authoritative (`payment.captured`, `payment.failed`, `refund.processed`, `subscription.*`); verify signatures; handle replays idempotently.
- Razorpay Payment Links as a fallback for residents who will not install the app — a treasurer can still bill them.
- Settlement reconciliation job matching Razorpay settlement reports to `payments` daily.
- Test mode wired into a dedicated staging environment with seeded failure scenarios.

## 16.8 Infrastructure & DevOps
| Concern | Choice |
|---|---|
| Hosting | Fly.io or Railway (MVP) → AWS ECS/EKS ap-south-1 (scale) |
| CI/CD | GitHub Actions → lint, typecheck, test, EAS Build; auto-deploy API on main |
| Environments | local → dev → staging → production, fully isolated data |
| Secrets | Doppler / AWS Secrets Manager |
| Observability | Sentry (errors), PostHog (product), OpenTelemetry + Grafana (traces/metrics), Better Stack (uptime + log aggregation) |
| Jobs/Scheduling | BullMQ + Redis (cycle generation, reminders, late fees, reports, reconciliation) |
| Feature flags | PostHog flags, with a kill-switch per AI feature |
| Backups | PITR + nightly snapshots, 30-day retention, **quarterly restore drills** (an untested backup is not a backup) |

---

# 17. Folder Structure

Feature-first (vertical slices), not type-first. A developer changing expenses should touch one directory.

```
society-expense-splitter/
├── apps/
│   ├── mobile/                          # Expo app
│   │   ├── app/                         # Expo Router routes ONLY (thin)
│   │   │   ├── _layout.tsx
│   │   │   ├── index.tsx                # splash / route resolver
│   │   │   ├── (auth)/
│   │   │   │   ├── _layout.tsx
│   │   │   │   ├── welcome.tsx
│   │   │   │   ├── login.tsx
│   │   │   │   ├── phone.tsx
│   │   │   │   ├── otp.tsx
│   │   │   │   └── forgot-password.tsx
│   │   │   ├── (setup)/
│   │   │   │   ├── profile-setup.tsx
│   │   │   │   ├── society-choice.tsx
│   │   │   │   ├── create/[step].tsx
│   │   │   │   └── join/index.tsx
│   │   │   ├── (app)/
│   │   │   │   ├── _layout.tsx          # tabs
│   │   │   │   ├── home/
│   │   │   │   ├── expenses/
│   │   │   │   │   ├── index.tsx
│   │   │   │   │   ├── [id].tsx
│   │   │   │   │   ├── new.tsx
│   │   │   │   │   └── scan.tsx
│   │   │   │   ├── payments/
│   │   │   │   ├── community/
│   │   │   │   └── more/
│   │   │   └── (modals)/
│   │   ├── src/
│   │   │   ├── features/                # THE core organising unit
│   │   │   │   ├── auth/
│   │   │   │   │   ├── api/             # endpoint fns
│   │   │   │   │   ├── hooks/           # useLogin, useOtp
│   │   │   │   │   ├── components/
│   │   │   │   │   ├── schemas/         # zod
│   │   │   │   │   ├── types.ts
│   │   │   │   │   └── __tests__/
│   │   │   │   ├── society/
│   │   │   │   ├── members/
│   │   │   │   ├── expenses/
│   │   │   │   │   ├── api/
│   │   │   │   │   ├── hooks/
│   │   │   │   │   ├── components/ExpenseCard.tsx, SplitEditor.tsx …
│   │   │   │   │   ├── lib/splitEngine.ts        # pure, unit-tested
│   │   │   │   │   └── __tests__/splitEngine.test.ts
│   │   │   │   ├── payments/
│   │   │   │   ├── maintenance/
│   │   │   │   ├── complaints/
│   │   │   │   ├── notices/
│   │   │   │   ├── visitors/
│   │   │   │   ├── reports/
│   │   │   │   ├── notifications/
│   │   │   │   ├── ai/
│   │   │   │   └── subscription/
│   │   │   ├── components/              # shared, feature-agnostic
│   │   │   │   ├── ui/                  # Button, Card, Sheet, Money, EmptyState
│   │   │   │   ├── forms/               # FormField, AmountInput, DatePicker
│   │   │   │   ├── feedback/            # Skeleton, ErrorState, SyncChip
│   │   │   │   └── layout/              # Screen, Header, TabBar
│   │   │   ├── lib/
│   │   │   │   ├── api/                 # client, interceptors, generated types
│   │   │   │   ├── db/                  # drizzle schema, migrations, queries
│   │   │   │   ├── sync/                # outbox, pull, conflict resolution
│   │   │   │   ├── storage/             # mmkv, secure-store wrappers
│   │   │   │   ├── permissions.ts       # can() — mirrors the role matrix
│   │   │   │   ├── money.ts             # paise arithmetic + formatting
│   │   │   │   ├── date.ts              # IST, financial year helpers
│   │   │   │   ├── analytics.ts
│   │   │   │   └── logger.ts
│   │   │   ├── stores/                  # zustand
│   │   │   ├── theme/                   # MD3 tokens, light/dark, typography
│   │   │   ├── i18n/                    # en, hi, mr, ta, te, kn, bn, gu
│   │   │   ├── constants/
│   │   │   └── types/
│   │   ├── assets/
│   │   ├── app.config.ts
│   │   ├── eas.json
│   │   └── tsconfig.json
│   └── api/                             # NestJS
│       ├── src/
│       │   ├── modules/
│       │   │   ├── auth/ society/ members/ expenses/ splits/
│       │   │   ├── payments/ maintenance/ complaints/ notices/
│       │   │   ├── visitors/ reports/ notifications/ ai/ subscription/
│       │   │   └── sync/
│       │   ├── common/                  # guards, interceptors, filters, decorators
│       │   ├── database/                # entities, migrations, seeds
│       │   ├── jobs/                    # BullMQ processors
│       │   ├── integrations/            # razorpay, msg91, resend, expo-push, llm
│       │   └── main.ts
│       └── test/
├── packages/
│   ├── shared-types/                    # generated from OpenAPI — single source of truth
│   ├── split-engine/                    # ⚠ shared pure logic, used by app AND api
│   ├── validation/                      # zod schemas shared across both
│   └── config/                          # eslint, tsconfig, prettier presets
├── docs/
│   ├── PRD.md  ARCHITECTURE.md  API.md  RUNBOOK.md  DECISIONS/
├── scripts/
├── .github/workflows/
├── turbo.json
└── package.json
```

**Key structural decisions**
- **`packages/split-engine` is shared** between client and server so a preview on-device and the authoritative calculation on the server can never disagree. This is the most important line in this section.
- `app/` contains routes only — each route file is a thin wrapper that imports a screen component from `src/features/*`. Route files should rarely exceed 30 lines.
- No barrel `index.ts` files that re-export everything (they wreck tree-shaking and create import cycles).
- Path aliases: `@/features/*`, `@/lib/*`, `@/components/*`, `@shared/*`.

---

# 18. Coding Standards

## 18.1 TypeScript
- `strict: true`, plus `noUncheckedIndexedAccess`, `noImplicitOverride`, `exactOptionalPropertyTypes`.
- **`any` is banned** (lint error). Use `unknown` + a zod parse at every boundary.
- Types for data shapes, interfaces for extensible contracts. Discriminated unions over optional-field soup.
- Every API boundary is zod-validated; infer TS types from the schema, never hand-write both.
- Branded types for identifiers and money: `type Paise = number & { __brand: 'Paise' }`, `type SocietyId = string & { __brand: 'SocietyId' }` — this makes "passed rupees where paise were expected" a compile error.

## 18.2 Naming
| Thing | Convention | Example |
|---|---|---|
| Components / classes | PascalCase | `ExpenseCard`, `SplitEngine` |
| Files (components) | PascalCase | `ExpenseCard.tsx` |
| Files (other) | camelCase | `splitEngine.ts`, `useExpenses.ts` |
| Route files | kebab-case | `payment-history.tsx` |
| Hooks | `use` prefix | `useExpenseList` |
| Booleans | `is/has/can/should` | `isOverdue`, `canPublish` |
| Handlers | `handle` (impl) / `on` (prop) | `handleSubmit`, `onSubmit` |
| Async fns | verb-first | `fetchExpenses`, `createPayment` |
| Constants | SCREAMING_SNAKE | `MAX_ATTACHMENT_BYTES` |
| Enums/unions | PascalCase type, snake values | `ExpenseStatus`, `'pending_approval'` |
| DB tables/columns | snake_case, plural tables | `expense_splits.amount_paise` |
| API JSON | camelCase | `amountPaise` |
| Money fields | always `*Paise` / `*_paise` | no exceptions |
| Test files | `*.test.ts(x)` beside source | `splitEngine.test.ts` |
| Branches | `type/ticket-slug` | `feat/SES-142-split-editor` |

## 18.3 Code Conventions
- Function components + hooks only. No class components.
- **One component per file**; a component over ~200 lines must be decomposed.
- Business logic lives in hooks or `lib/`, never in JSX. A component that computes a balance inline is a bug.
- Props: destructure with defaults; no `props.x` spelunking; no prop drilling beyond 2 levels (use a hook or a store).
- Early returns over nesting; guard clauses first.
- **Never** compare or arithmetic on floats for money — `packages/split-engine` handles all currency maths in integer paise.
- All user-facing strings go through `t()`. A literal string in JSX is a lint error.
- Every list uses `FlashList` with a stable `keyExtractor` and an `estimatedItemSize`.
- Every async UI path handles four states explicitly: loading, empty, error, success.
- Error boundaries per tab plus a root boundary.
- No `console.log` in committed code — use `logger` with levels, stripped in production builds.
- Comments explain **why**, not what. A comment restating the code is deleted at review.

## 18.4 Testing Strategy

| Layer | Tool | Target |
|---|---|---|
| **Unit** | Jest | ≥ 80% overall; **100% on `split-engine`, money utils, permission map, allocation logic** — these are non-negotiable |
| **Component** | React Native Testing Library | All shared UI + every form; test behaviour, not implementation |
| **Integration (API)** | Jest + Supertest + Testcontainers Postgres | Every endpoint: happy path, auth failure, permission failure, validation failure |
| **E2E** | Maestro | 8 critical flows: signup→society creation; join→approval; add expense→split→publish; pay online→receipt; offline expense→sync; cycle publish; complaint lifecycle; visitor approval |
| **Contract** | OpenAPI schema diff in CI | Breaking changes fail the build |
| **Visual regression** | Storybook + Chromatic (optional) | Shared UI only |
| **Load** | k6 | Cycle publish for 2,000 flats < 30s; 500 concurrent payments |
| **Accessibility** | jest-axe (web views) + manual TalkBack/VoiceOver | Top 6 screens each release |
| **Security** | Snyk/Dependabot, `npm audit` gate, quarterly pentest before Enterprise GA | No high/critical in prod |

**Non-negotiable test rules:**
- Every bug fix ships with a regression test reproducing it.
- The split engine has property-based tests (fast-check): for any amount and any participant set, **allocations always sum exactly to the total** and the result is deterministic.
- Payment allocation has tests for partial payments, overpayment→advance, void→credit, and duplicate webhook delivery.
- No mocking of the thing under test. Mock the network boundary (MSW), not your own modules.

## 18.5 Git Workflow
- **Trunk-based with short-lived branches.** `main` is always releasable; feature branches live < 3 days; feature flags for anything longer.
- Branches: `feat/`, `fix/`, `chore/`, `refactor/`, `docs/`, `test/` + ticket id.
- **Conventional Commits**, enforced by commitlint: `feat(expenses): add per-sqft split basis`. Drives automated changelogs and semver.
- PRs: max ~400 lines changed, template with description/screenshots/test notes, at least 1 approval, all CI green. Self-merge only for docs.
- Pre-commit (husky + lint-staged): eslint --fix, prettier, tsc --noEmit on staged files.
- CI on every PR: typecheck → lint → unit → integration → build. E2E on `main` nightly.
- Releases: semantic-release. **OTA (EAS Update)** for JS-only fixes; a store build for native changes. Staged rollout 10% → 50% → 100% with Sentry crash-rate gates.
- Database migrations are forward-only, reviewed separately, and must be backward-compatible with the previous app version (expand → migrate → contract).
- Protected `main`: no force-push, required reviews, signed commits for release tags.

---

# 19. Risks

## 19.1 Technical Risks

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| **Split/rounding bugs cause wrong bills** | Critical — destroys trust irrecoverably | Medium | Integer paise only; shared split engine; 100% coverage + property-based tests; preview-before-publish; full revision history |
| **Offline sync corrupts financial data** | Critical | Medium | Server is authoritative for money; version checks; idempotency keys; conflicts surfaced, never auto-merged silently; nightly balance reconciliation job with drift alerts |
| **Duplicate payments from webhook replay or retry** | High | Medium-High | `razorpay_payment_id` UNIQUE; idempotency keys stored 24h; webhook handlers strictly idempotent; reconciliation against settlement reports |
| **Balance drift between `member_balances` and source rows** | High | Medium | Transactional maintenance + nightly recompute-and-compare with alerting; a one-click rebuild tool |
| **Expo/React Native version churn breaking builds** | Medium | High | Pin SDK; upgrade one SDK behind latest on a scheduled cadence; keep a dependency budget; avoid unmaintained native modules |
| **Performance on low-end Android (cycle grid of 2,000 flats)** | Medium | Medium | FlashList virtualisation; server-side pagination; move cycle preview computation server-side; test on a real ₹8,000 device every sprint |
| **OTP delivery failures / DLT template rejection** | High (blocks all logins) | Medium | Multi-provider failover (MSG91 + Twilio); WhatsApp and email fallback; long-lived refresh tokens so re-auth is rare; register templates early |
| **Supabase lock-in or pricing change** | Medium | Low-Medium | Standard Postgres; money logic already in NestJS; Supabase-specific calls behind an adapter; documented exit plan |
| **AI hallucination in financial context** | High | Medium | AI never writes to the ledger; suggestions require explicit acceptance; constrained query DSL rather than generated SQL; every output cites its source rows; per-feature kill-switches |
| **Attachment storage cost explosion** | Medium | Medium | Client-side compression; per-plan quotas; R2 zero-egress; lifecycle rules to cold storage after 24 months |

## 19.2 Business Risks

| Risk | Impact | Mitigation |
|---|---|---|
| **Committee decision cycles are slow; free tier never converts** | High | Bottom-up adoption by the treasurer (the person in pain); trial triggered at peak value; "request upgrade" flow that packages the pitch for the Admin; annual pricing aligned to society budget meetings |
| **Incumbents (MyGate/NoBrokerHood) bundle finance for free** | High | Win where they are weak — small societies, self-serve, split flexibility, transparency-first UX; keep the free tier generous enough to be the obvious default; move faster on AI |
| **Low willingness to pay at Indian ARPU** | High | Society-level (not per-user) pricing; anchor against ₹ managed, not against other apps; keep gross margin high by controlling SMS and AI cost |
| **Churn when the committee rotates** | High | Make handover a *feature* (role transfer, continuity of history) and market it; onboard at least 2 committee members per society; annual plans straddle rotations |
| **Trust failure after a single public money error** | Critical | Transparency by default; visible revision history; voids instead of deletes; a published incident-response commitment; fast, honest support |
| **Single-champion dependency (one treasurer drives everything)** | Medium | Push multi-admin adoption; nudge to add a second treasurer; resident-side engagement via payments and notices |
| **Regulatory shift on UPI MDR or payment aggregation** | Medium | Never depend on gateway commission for viability (< 20% of revenue); use Razorpay Route so we are not a payment aggregator |
| **Seasonal usage (societies engage monthly)** | Medium | Accept it — measure society-MAU, not user-DAU; build monthly habit loops around the billing cycle |

## 19.3 Scalability Risks

| Risk | Mitigation |
|---|---|
| Cycle publish for a 2,000-flat society times out | Async job with progress, batched inserts, `COPY` for bulk, idempotent resume |
| Report queries scan years of data | Materialised monthly aggregates refreshed on cycle close; read replica for reporting; partition `expenses`/`dues`/`audit_logs` by month at volume |
| Push fan-out to 100k users on an emergency notice | Queue + batch (Expo accepts 100 per request), rate-limited workers, receipt polling |
| N+1 queries in list screens | DataLoader/joins; enforce a query-count budget in integration tests |
| Storage/egress growth | CDN, thumbnails, R2, per-plan quotas |
| Multi-tenant noisy neighbour | Per-society rate limits; job queue fairness by society; connection pooling (PgBouncer) |
| Sync storms after a long outage | Jittered backoff, server-side batch caps, `truncated` pagination on delta pull |

## 19.4 Security Risks

| Risk | Mitigation |
|---|---|
| **Cross-tenant data leakage** (worst case) | RLS at the database + membership checks in the API + society-prefixed cache keys; automated tests that assert tenant isolation on *every* endpoint |
| Account takeover via SIM swap | Re-verification for sensitive actions after a phone change; 24h cool-down on financial ops after a number change; notify all channels |
| Privilege escalation to Treasurer | Role changes admin-only, logged, notified to all admins, never self-assignable |
| Malicious/compromised treasurer | Immutable audit log; expense approval thresholds; residents see everything by default; balance reconciliation alerts |
| Webhook forgery | Signature verification before parsing; constant-time compare; IP allowlist where feasible |
| Stolen device with an unlocked app | Optional biometric lock; short access tokens; remote session revocation; encrypted local DB |
| PII exposure via attachments (bills contain names/phones) | Signed short-lived URLs, no public buckets, EXIF stripping, access logged |
| Dependency supply-chain attack | Lockfiles, Dependabot, `npm audit` CI gate, no `postinstall` scripts from unvetted packages, SBOM |
| Insider access to production data | Least-privilege IAM, no direct prod DB access without break-glass approval, all access logged |

---

# 20. Success Metrics

## 20.1 North Star
**Value of money transparently managed per month** — the total billed and visible to residents across active societies. It rises only when societies both adopt *and* keep using the product for real finances, and it is the number a treasurer, a resident and an investor all care about.

## 20.2 KPI Tree

**Growth**
| KPI | M3 | M6 | M12 | M24 |
|---|---|---|---|---|
| Active societies | 25 | 150 | 1,200 | 6,000 |
| Registered users | 1,500 | 9,000 | 80,000 | 450,000 |
| Units under management | 2,000 | 12,000 | 100,000 | 550,000 |
| Paying societies | 0 | 12 | 120 | 800 |
| Organic/referral share of new societies | — | 20% | 35% | 50% |

**Activation**
| KPI | Target |
|---|---|
| Society creation → first published expense | ≥ 75% within 7 days |
| Median time to first expense | < 20 min |
| Societies reaching 10+ active members in 14 days | ≥ 60% |
| Invite acceptance rate | ≥ 55% (WhatsApp channel ≥ 65%) |

**Retention (the metric that decides the company)**
| KPI | Target |
|---|---|
| Society M1 | ≥ 85% |
| Society M3 | ≥ 75% |
| Society M6 | ≥ 70% |
| Society M12 | ≥ 60% |
| Treasurer W4 retention | ≥ 70% |
| Resident M3 retention | ≥ 45% |
| Consecutive cycles published (median) | ≥ 6 by M12 |

**Engagement**
| KPI | Target |
|---|---|
| Societies publishing a cycle monthly | ≥ 70% of active |
| Online payment share of collections | ≥ 50% by M12 |
| Collection rate (billed → collected within 30 days) | ≥ 85%, and **+10pp vs the society's pre-app baseline** |
| Complaints resolved within SLA | ≥ 80% |
| AI suggestion acceptance (OCR) | ≥ 70% |

**Revenue**
| KPI | M6 | M12 | M24 |
|---|---|---|---|
| MRR | ₹1.2 L | ₹12 L | ₹80 L |
| ARR | ₹14 L | ₹1.4 Cr | ₹9.6 Cr |
| Free→paid conversion | 8% | 10% | 13% |
| ARPS (annual) | ₹11,000 | ₹12,000 | ₹13,500 |
| GMV processed (annual run-rate) | ₹8 Cr | ₹120 Cr | ₹900 Cr |
| Gross margin | 70% | 78% | 82% |
| LTV:CAC | 5:1 | 10:1 | 15:1 |
| Net revenue retention | — | 100% | 110% |

**Quality**
| KPI | Target |
|---|---|
| Crash-free sessions | > 99.5% |
| p95 API latency | < 400 ms |
| Cold start (mid Android) | < 3 s |
| Payment success rate | > 92% |
| Sync failure rate | < 0.5% of ops |
| Push delivery rate | > 95% |
| **Financial discrepancy reports** | **0 per quarter** — a single confirmed wrong balance is a Sev-1 |
| Support tickets per 100 societies/month | < 8 |
| Treasurer NPS | > 50 |

## 20.3 Review Cadence
Weekly: activation funnel, crashes, payment success, support themes. Monthly: retention cohorts, conversion, collection rates, unit economics. Quarterly: North Star, roadmap re-prioritisation against the MVP checklist, pricing review.

---

# 21. MVP Checklist

MoSCoW prioritisation for **Phase 1**. "Won't Have" means *not in MVP* — several are scheduled for later phases.

## Must Have (ship-blocking)
- [ ] Phone OTP login + email/password + Google + Apple sign-in
- [ ] Profile setup, session persistence, silent refresh, logout
- [ ] Create society (basics, structure, financial defaults)
- [ ] Buildings, wings (optional), floors, apartments with a pattern generator
- [ ] Join society by code / link / QR + admin approval queue
- [ ] Invite members (WhatsApp, SMS, email, link) incl. targeted-to-flat invites
- [ ] Member list, roles (admin, treasurer, committee, resident, tenant), occupancy
- [ ] Add / edit / void expense with category, date, notes, attachments
- [ ] All 5 split strategies incl. per-sqft and floor-band apartment bases
- [ ] Deterministic paise-exact split engine with residual distribution
- [ ] Automatic due generation and per-member balances
- [ ] My Dues screen with itemised breakdown
- [ ] Razorpay online payment (UPI/card/netbanking) + webhook verification + receipts
- [ ] Record offline payment (cash/cheque/NEFT/UPI) + treasurer verification queue
- [ ] Partial payments and allocation (oldest-first) with a visible breakdown
- [ ] Payment history + PDF receipt download/share
- [ ] Basic maintenance cycle: define charge heads, generate, preview, publish
- [ ] Outstanding payments view with ageing + bulk reminder
- [ ] Notice board (general, emergency) with push
- [ ] Push notifications for bills, reminders, payments, notices
- [ ] Monthly report (in-app view)
- [ ] Offline-first reads + queued writes for expenses/payments/complaints
- [ ] MD3 theme, dark mode, empty/loading/error states
- [ ] Role-based access enforced in UI **and** API **and** RLS
- [ ] Audit log written for all financial and role mutations
- [ ] Sentry + PostHog instrumentation
- [ ] Privacy policy, T&C, DPDP consent, account deletion flow
- [ ] EAS build pipeline + staged rollout

## Should Have (high value, ship if the timeline allows)
- [ ] Complaint management with assignment and status timeline
- [ ] Expense comments thread
- [ ] Expense revision history visible to residents
- [ ] Bill OCR prefill
- [ ] Duplicate expense detection
- [ ] Report export (PDF/CSV)
- [ ] Annual report
- [ ] Late fees and arrears carry-forward
- [ ] Recurring expense templates
- [ ] Family members
- [ ] Email notifications (bills, receipts)
- [ ] Society switcher for multi-society users
- [ ] Biometric app lock
- [ ] CSV bulk member import
- [ ] Notification preferences per category

## Could Have (nice, low cost, defer without pain)
- [ ] Visitor management (entry log + approval)
- [ ] Delivery tracking
- [ ] Events with RSVP
- [ ] Budget setup and variance view
- [ ] Anomaly detection alerts
- [ ] Hindi + Marathi localisation
- [ ] Meter readings for water/electricity
- [ ] Expense search with filters and full-text
- [ ] Guest auditor read-only links
- [ ] Expense approval workflow above threshold
- [ ] Referral programme

## Won't Have (explicitly out of MVP)
- [ ] AI assistant, natural-language search, maintenance forecasting → Phase 3
- [ ] WhatsApp bills and reminders → Phase 2
- [ ] UPI AutoPay mandates → Phase 2
- [ ] Facility/amenity booking → Phase 3
- [ ] Polls and AGM voting → Phase 3
- [ ] Vendor management and marketplace → Phase 3/4
- [ ] Web admin console → Phase 3
- [ ] Accounting exports (Tally/Zoho) → Phase 3
- [ ] Document vault → Phase 3
- [ ] Staff attendance and payroll → Phase 3
- [ ] Multi-currency, international markets → Phase 4
- [ ] SSO/SAML, white-label → Phase 4
- [ ] Gate hardware / IoT meter integrations → Phase 4

---

# 22. Implementation Roadmap

52 sequential tasks for an AI coding agent. Each task is independently completable, has an explicit definition of done, and leaves the repository in a working state. **Do not start a task until the previous one's DoD is met.** Tasks marked 🔒 are the financial core — they require 100% test coverage before proceeding.

## Milestone A — Foundations (Tasks 1–8)

**Task 1 — Monorepo scaffold.**
Initialise a Turborepo with `apps/mobile` (Expo, TypeScript strict), `apps/api` (NestJS), and `packages/{shared-types,split-engine,validation,config}`. Configure shared ESLint/Prettier/tsconfig presets, path aliases, husky + lint-staged + commitlint.
*DoD:* `pnpm lint`, `pnpm typecheck`, `pnpm test` all pass from root; both apps boot.

**Task 2 — CI pipeline.**
GitHub Actions: on PR run typecheck → lint → unit → build for both apps; cache pnpm and Turbo. Add Dependabot and an `npm audit` gate.
*DoD:* a PR shows all checks green in under 6 minutes.

**Task 3 — Database schema + migrations.**
Implement every table, enum, index and constraint from §7 as ordered migrations (Drizzle or TypeORM). Include the RLS policies and the integrity triggers from §7.6–7.7.
*DoD:* migrations run up and down cleanly on a fresh Postgres; a seed script creates one society with 2 buildings, 64 apartments and 40 members.

**Task 4 — 🔒 Split engine package.**
Implement `packages/split-engine` per §3.5: all 5 strategies, all 6 apartment bases, floor bands, integer-paise arithmetic, deterministic residual distribution, participant resolution, owner-only routing.
*DoD:* 100% line and branch coverage; property-based tests (fast-check) proving allocations always sum exactly to the input for 10,000 random cases; zero floating-point operations in the package.

**Task 5 — Shared validation package.**
Zod schemas for every API request/response in §8, plus branded types (`Paise`, `SocietyId`, `MemberId`) and money formatting helpers (₹ with lakh grouping).
*DoD:* schemas imported by both apps; `formatMoney(450025n)` → `"₹4,500.25"`; type-level test that rupees cannot be passed as paise.

**Task 6 — API skeleton + conventions.**
NestJS app with global validation pipe, response/error interceptors matching §8.1 envelopes, request-id middleware, structured logging, health endpoint, OpenAPI generation, and a script that emits `packages/shared-types` from the spec.
*DoD:* `/v1/health` returns the standard envelope; generated types compile in the mobile app.

**Task 7 — Auth module (server).**
Argon2id hashing, JWT issue/refresh with rotation and reuse detection, OTP request/verify with hashing and TTL, Google and Apple token verification, password reset, rate limits per §8.4, `jti` denylist in Redis.
*DoD:* integration tests cover every auth endpoint including lockout, replayed refresh token, and expired OTP.

**Task 8 — Permissions + tenancy guard.**
Implement the §2.1 matrix as a single `PERMISSIONS` map in `packages/validation`; a NestJS guard enforcing `can(role, action)` plus society membership from `X-Society-Id`; mirror in RLS.
*DoD:* a parameterised test asserts, for every endpoint × every role, that access matches the matrix; a tenant-isolation test proves society A cannot read society B on any endpoint.

## Milestone B — Mobile Shell (Tasks 9–15)

**Task 9 — Expo app shell + routing.**
Expo Router with the `(auth)` / `(setup)` / `(app)` / `(modals)` groups from §5.1, splash route resolver, deep-link configuration, and typed routes.
*DoD:* navigating to every top-level route renders a placeholder; `societyexpense://expenses/123` opens the right screen.

**Task 10 — Design system.**
MD3 theme from the `#2E7D5B` seed with generated light/dark schemes, Inter + Noto Sans Devanagari via `expo-font`, type scale, spacing tokens, and the shared `ui/` primitives: `Screen`, `Button`, `Card`, `Money`, `Chip`, `EmptyState`, `Skeleton`, `ErrorState`, `BottomSheet`, `ConfirmSheet`.
*DoD:* a theme-preview screen renders every primitive in both themes; `Money` uses tabular figures; contrast checked at AA in both schemes.

**Task 11 — API client + query layer.**
Typed fetch client with auth injection, refresh-on-401 with request replay, `X-Society-Id` injection, `Idempotency-Key` generation on money POSTs; TanStack Query provider with the §9.3 key factory, stale times, and MMKV persistence with a version buster.
*DoD:* a demo query renders from cache on cold start with the network disabled.

**Task 12 — Stores + secure storage.**
Zustand stores (`auth`, `society`, `sync`, `ui`, `draft`), MMKV wrapper, SecureStore wrapper for tokens, theme applied pre-paint.
*DoD:* app restart preserves theme, language and `activeSocietyId` with no flash of wrong state.

**Task 13 — Local database.**
Drizzle SQLite schema mirroring the server's tenant-scoped tables, SQLCipher with the key in SecureStore, migration runner, typed query helpers.
*DoD:* seed 1,000 expenses locally and query "overdue dues for building B by ageing" in < 50 ms on a mid-range device.

**Task 14 — Auth screens.**
Welcome, phone entry, OTP (6-box with autofill and resend timer), email login/signup, forgot/reset password, profile setup. `react-hook-form` + zod, full error states.
*DoD:* end-to-end login against the real API on both platforms; Android SMS auto-read works; Maestro flow passes.

**Task 15 — i18n + accessibility baseline.**
`i18next` wired with an `en` catalogue, a lint rule banning literal JSX strings, accessibility labels/roles on all shared primitives, font-scale-safe layouts.
*DoD:* no hardcoded strings; the app is usable at `fontScale: 2`; TalkBack pass on the auth flow.

## Milestone C — Society & Members (Tasks 16–22)

**Task 16 — Society module (server).** CRUD, settings, join code generation/regeneration, public lookup, slug generation, seeded categories and charge heads on creation. *DoD:* integration tests for creation, settings update, and lookup-by-code.

**Task 17 — Structure module (server).** Buildings, wings, apartments, bulk create, and the pattern generator (`{wing}-{floor}{unit:02d}`) with duplicate skipping. *DoD:* generating 2 wings × 8 floors × 4 units creates exactly 64 correctly-named apartments.

**Task 18 — Create-society wizard (mobile).** 4 steps with a resumable local draft, the apartment generator with an editable preview grid, and the invite step with QR, WhatsApp share and copy-link. *DoD:* Maestro flow creates a 64-flat society in under 3 minutes.

**Task 19 — Join flow (mobile + server).** Join by code/QR/search, society preview, flat selection, occupancy declaration, pending state, admin approval queue with approve/reject. *DoD:* two-device test: A creates, B joins, A approves, B lands on the dashboard.

**Task 20 — Members module.** List with search and filters, member detail, direct add (shadow members), role change with confirmation and audit, soft removal with the unsettled-dues guard, family members. *DoD:* role matrix enforced; a removal attempt with open dues is blocked with the correct error.

**Task 21 — Invitations.** Single and bulk (CSV with dry-run preview), targeted-to-flat invites, token hashing, expiry, revocation, accept flow, funnel tracking. *DoD:* a CSV of 50 rows with 3 malformed entries reports exactly those 3 and imports 47.

**Task 22 — Society switcher + multi-society.** Bottom sheet switcher, cache keying by society, last-used persistence. *DoD:* switching societies swaps all data with no cross-contamination; verified by a cache-key assertion test.

## Milestone D — Expenses (Tasks 23–29)

**Task 23 — Expense module (server).** CRUD, draft/publish/approve/void lifecycle, revisions with full snapshots, optimistic version checks, full-text search, filters, cursor pagination. *DoD:* publishing creates splits and dues in a single transaction; voiding reverses dues and creates advance credits.

**Task 24 — 🔒 Split + dues integration.** Wire `split-engine` into publish; implement participant resolution, snapshotting, owner-only routing, and transactional `member_balances` maintenance. *DoD:* integration test — publish a ₹60,000 per-sqft expense across 64 flats; `SUM(splits) == 6000000` paise exactly and every balance updates correctly.

**Task 25 — `POST /expenses/preview-split`.** Stateless preview endpoint returning allocations, residual and warnings (missing area, excluded flats). *DoD:* response matches the §8.3 example shape; p95 < 150 ms for 500 participants.

**Task 26 — Expense list + detail (mobile).** FlashList with month grouping, filters, search; detail screen with split table, attachments, comments and revision history. *DoD:* smooth 60fps scroll over 1,000 expenses; renders fully from cache offline.

**Task 27 — Expense form + split configurator.** Single-screen form with sticky amount, 3-second autosave drafts, category picker, participant selector, and a live split editor per strategy with the running "remaining ₹" indicator. *DoD:* all 5 strategies configurable; custom split cannot be saved until remaining is ₹0.

**Task 28 — Attachments.** Camera capture with crop, gallery/document pick, client compression, presigned upload, thumbnail grid, full-screen viewer, offline queueing. *DoD:* a 4 MB photo uploads as < 400 KB; an offline-captured attachment uploads correctly on reconnect.

**Task 29 — Categories + GST.** Category management screen, GST details form with GSTIN checksum validation and the intra/inter-state regime rule, tax-total reconciliation warning. *DoD:* an invalid GSTIN is rejected client-side; CGST+SGST and IGST cannot coexist.

## Milestone E — Payments (Tasks 30–36)

**Task 30 — 🔒 Dues + balances API.** Dues listing, member statement, balance endpoint, ageing buckets, outstanding report with pagination. *DoD:* ageing buckets verified against a fixture spanning 200 days; statement reconciles to zero.

**Task 31 — 🔒 Razorpay integration (server).** Order creation, signature verification, webhook handler (captured/failed/refunded) with idempotency, allocation oldest-first, gateway fee capture, refunds. *DoD:* replaying the same webhook 5 times produces exactly one payment; a bad signature returns 400 and writes nothing.

**Task 32 — 🔒 Receipts.** Gapless per-FY numbering from a Postgres sequence inside the payment transaction, PDF generation with the society's branding, storage upload, share. *DoD:* 100 concurrent payments produce 100 unique gapless receipt numbers (load-tested).

**Task 33 — Payment screens (mobile).** My Dues with line selection, Pay Now, Razorpay checkout handoff, success/failure screens with retry preserving the selection, payment history, receipt viewer. *DoD:* full test-mode payment on both platforms; failure path recovers without losing state.

**Task 34 — Offline payment + verification.** Resident claim flow with proof upload, treasurer recording, verification queue with approve/reject and reasons, cheque clearing. *DoD:* an unverified payment does not reduce outstanding until verified.

**Task 35 — Outstanding + reminders.** Defaulter list with ageing filters, bulk reminder composer with audience and channel selection and message preview, per-channel rate limiting. *DoD:* sending to 120 members queues 120 notifications respecting quiet hours.

**Task 36 — 🔒 Balance reconciliation job.** Nightly job recomputing balances from source rows, comparing to `member_balances`, alerting on any drift, plus a one-click rebuild tool. *DoD:* deliberately corrupting a balance triggers an alert and the rebuild restores it.

## Milestone F — Maintenance Cycles (Tasks 37–41)

**Task 37 — Charge heads.** CRUD with amount/rate, split strategy, floor bands, applicability, owner-only and metered flags, active date ranges. *DoD:* a lift charge head with ground-floor exemption computes zero for floor 0.

**Task 38 — Cycle generation (server).** Scheduled draft creation, materialisation of `cycle_charges` for every billable apartment × active head, arrears carry-forward computation. *DoD:* generating a cycle for 200 flats × 8 heads completes in < 10 s and produces 1,600 lines.

**Task 39 — Cycle preview + publish.** Preview grid endpoint, per-cell override with reason, publish creating expenses + dues + bills + notifications atomically with progress reporting. *DoD:* publish is idempotent; a mid-run failure leaves no partial dues.

**Task 40 — Cycle screens (mobile).** Cycles list, preview grid (virtualised `DataTable`), override editor, publish confirmation showing totals and recipient count, meter readings entry. *DoD:* the grid scrolls smoothly at 200 flats × 8 heads on a mid-range device.

**Task 41 — Late fees + recurring templates.** Daily late-fee job creating separate `late_fee` dues after grace, waiver flow, recurring expense templates with a next-run scheduler. *DoD:* late fees appear as separate waivable lines and never compound silently.

## Milestone G — Community & Reports (Tasks 42–46)

**Task 42 — Notice board.** Announcements CRUD with audience targeting, pinning, scheduling, emergency channel with acknowledgement tracking, events with RSVP, comments. *DoD:* an emergency notice bypasses quiet hours and shows an ack count.

**Task 43 — Complaints.** Full status machine, auto-assignment by category, timeline events, comments, photos, SLA computation, ratings, optional expense linking. *DoD:* every invalid status transition is rejected server-side; the timeline is append-only.

**Task 44 — Visitors.** Entry logging, pre-approval with gate PIN, approval push with 90-second escalation, delivery tracking, exit logging, auto-close job, security (guest) account restricted from all financial data. *DoD:* a security account receives 403 on every financial endpoint; approval from a locked phone works via deep link.

**Task 45 — Reports (server).** Monthly, annual, trends, outstanding, budget, member statement, GST and collection-efficiency endpoints; async PDF/CSV export via a job queue. *DoD:* a 3-year annual report generates in < 20 s; exported CSV totals match in-app figures exactly.

**Task 46 — Reports (mobile) + budgets.** Reports hub, chart + table viewer with dark-mode chart palette, export and share, budget setup and variance view. *DoD:* every report renders correctly in both themes and shares as a PDF.

## Milestone H — Offline, Notifications, AI, Launch (Tasks 47–52)

**Task 47 — Sync engine.** Outbox table, delta pull (`/sync/changes`), batch push (`/sync/batch`), backoff with jitter, temp-id rewriting, attachment-before-op ordering, per-class conflict resolution per §10.4, Sync Status sheet with manual retry. *DoD:* airplane-mode test — create 3 expenses, 1 complaint and 1 offline payment, reconnect, all sync in order; a forced version conflict surfaces the conflict sheet and never loses data.

**Task 48 — Notifications end to end.** Expo push registration and token lifecycle, notification orchestrator implementing the §3.12 event matrix, quiet hours, batching, preferences screen, notification centre, deep-link routing, email via Resend, SMS via MSG91. *DoD:* every event type delivers on the correct channels and deep-links to the right screen; invalid tokens are pruned.

**Task 49 — AI Tier 1.** Bill OCR (on-device first pass + server vision model) with a side-by-side review screen, duplicate detection on save, anomaly alerts on the treasurer dashboard, `ai_suggestions` logging with accept/reject outcomes, per-society opt-out, per-plan rate limits. *DoD:* OCR achieves ≥ 90% field accuracy on a 30-invoice printed test set; no AI output can mutate the ledger without an explicit tap.

**Task 50 — Subscriptions + paywalls.** Plan entitlement checks server-side, unit-count enforcement, Razorpay subscription flow, trial triggered on first cycle publish, paywall screens with the cost-anchoring line, non-destructive downgrade, dunning. *DoD:* a free society at 26 units is blocked with `PLAN_LIMIT_EXCEEDED` and a working upgrade path; downgrading deletes nothing.

**Task 51 — Observability, security hardening, performance pass.** Sentry with PII scrubbing, PostHog events from §12.2, OpenTelemetry traces, certificate pinning with a backup pin, screenshot blocking on financial screens, EXIF stripping, biometric lock, k6 load tests, bundle-size and cold-start optimisation against the §6.7 budget. *DoD:* all performance budgets met on a real low-end Android device; no high/critical vulnerabilities; tenant-isolation suite green.

**Task 52 — Launch readiness.** Maestro suite covering all 8 critical flows, store assets and listings, privacy policy and DPDP consent flow, account deletion, force-update and maintenance-mode screens, EAS staged rollout with crash-rate gates, runbook (incident response, balance-rebuild, webhook replay, restore drill), pilot onboarding guide for treasurers.
*DoD:* a full release candidate passes all E2E flows on both platforms, is submitted to both stores, and the runbook has been rehearsed once end to end.

---

## Execution Notes for the Coding Agent

1. **Never break the money invariants.** `SUM(splits) == expense.amount` and `SUM(allocations) <= payment.amount` hold at every commit. If a change makes these hard to guarantee, the change is wrong.
2. **Paise, always.** If you find yourself writing `* 100` or `/ 100` outside `packages/split-engine` or the money formatter, stop and reconsider.
3. **Server is authoritative for all financial state.** The client previews; the server decides.
4. **Never hard-delete financial records.** Void, reverse, credit — but never delete.
5. **Every mutation on money, roles or structure writes an audit log.** No exceptions.
6. **Test the tenant boundary on every new endpoint** before writing the feature test.
7. **Build offline-first from the start.** Retrofitting sync after the fact is a rewrite.
8. **When in doubt about a product decision,** default to whichever option makes the ledger more transparent to residents. That is the product.

---

*End of PRD.*
