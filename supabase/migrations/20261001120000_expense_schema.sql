-- 20261001120000_expense_schema.sql
--
-- The expense domain: schema, default categories and the money-conservation
-- invariant — Roadmap T060, SAD §8.1 (conventions), §8.3 (financial ER),
-- §8.5 (table catalogue), §8.6 (database-enforced money invariants), §8.7 (RLS),
-- PRD §7.1 (enums), §7.3 (financial DDL) and §3.5.3 ("Categories").
--
-- WHAT LANDS HERE
--   * two enums: `expense_status`, `due_status` (PRD §7.1, verbatim and in order);
--   * six tables: `expense_categories`, `expenses`, `expense_splits`,
--     `expense_revisions`, `expense_gst_details`, `dues`;
--   * the four indexes SAD §8.5 names for `expenses`, the GIN full-text index on
--     title + description + vendor, and the PRD's split/dues indexes;
--   * cross-society-proof composite foreign keys for every tenant-bearing
--     reference (the `20260924140000_structure_apartments.sql` /
--     `20260925120000_members_directory.sql` idiom);
--   * `chk_split_total()` — a DEFERRABLE INITIALLY DEFERRED constraint trigger
--     that makes "a published expense's splits sum exactly to its amount" true at
--     COMMIT, plus the companion trigger and the parent-row lock the SAD's own
--     sketch is missing (see §8.6 below);
--   * RLS, column grants and the three predicates the policies read;
--   * nineteen default categories, seeded by `seed_society()` in the same
--     transaction that creates the society (PRD §3.2, Roadmap T036's acceptance).
--
-- WHY THIS IS ONE MIGRATION AND NOT TWO: the invariant and the tables it constrains
-- cannot be split — a migration that created `expenses`/`expense_splits` without
-- `chk_split_total()` would leave a window (however short) in which a published
-- expense could hold splits that do not sum to it, and every later writer would be
-- a second opportunity to create one. SQL is transactional, so the tables and the
-- trigger that guards them land together or not at all. "0009_expenses.sql" in the
-- Roadmap is a conceptual label: the runner's filenames are 14-digit timestamps
-- (`FILENAME_PATTERN` in `apps/api/src/infrastructure/database/migrations/runner.ts`),
-- and this is the nineteenth file applied, not the ninth.
--
-- DELIBERATE DIFFERENCES FROM THE PRD's DDL, each named where it happens and
-- collected here so a reviewer can check them in one place:
--
--   1. `expenses.cycle_id`, `expenses.recurring_template_id` and `dues.cycle_id`
--      are NOT created. `maintenance_cycles` and `recurring_templates` do not
--      exist — the charge-head/cycle module owns them (T088/T089) — and a column
--      pointing at a table that does not exist is a dangling reference rather than
--      a constraint. This is the decision `20260920130000_society_core.sql` records
--      for `members.apartment_id` (which T043 later added) and
--      `20260924130000_structure_buildings.sql` records for `wings`: a column
--      nobody can populate and a key nobody can exercise is worse than a named
--      gap. They arrive as pure addition with the cycles module.
--   2. `society_id` is added to `expense_revisions` and `expense_gst_details`
--      (SAD §8.1: "Every tenant table carries it"). Both are children of
--      `expenses`, so the tenant is derivable — but derivable means every RLS
--      policy on them needs a join, and the composite foreign key that stops a
--      cross-society child row needs a column to exist. `expense_revisions` keeps
--      the PRD's columns otherwise.
--   3. `updated_at` (with the shared `touch_updated_at()` trigger) and `version`
--      are applied per SAD §8.1 rather than per the PRD's DDL, which omits them on
--      `expense_categories` and `dues`. `expense_gst_details` is the exception: it
--      is a 1:1 value object on one expense row and carries neither.
--   4. Soft-delete columns (`deleted_at`/`deleted_by`) exist on
--      `expense_categories` only. SAD §8.1 puts `expense_categories` in the
--      soft-delete tier and `expenses`/`dues` in the "never deleted — voided
--      instead" tier, so the latter carry `voided_at`/`void_reason`/`status` and
--      no delete columns at all. `expense_splits`, `expense_revisions` and
--      `expense_gst_details` are child rows whose life is their parent's.
--   5. Category-name uniqueness is a **partial** unique index on live rows
--      (`WHERE deleted_at IS NULL`), not the PRD's plain `UNIQUE (society_id, name)`.
--      SAD §8.1's soft-delete policy is explicit that "partial indexes include the
--      predicate" — a soft-deleted `Miscellaneous` must not reserve the name
--      forever — and it is the same choice `buildings` and `apartments` already made.
--   6. Split-participant uniqueness is `UNIQUE NULLS NOT DISTINCT`, and a split
--      must name at least one participant. The PRD's `UNIQUE (expense_id,
--      member_id, apartment_id)` does not hold when either column is NULL
--      (Postgres treats NULLs as distinct), so the two rows it is meant to forbid —
--      the same flat billed twice for one expense — would both be accepted. It also
--      cannot be a plain table constraint once the composite tenant key is added.
--   7. `payment_source`, `currency`, `split_config`, `participant_selector` and
--      the lifecycle stamps keep the PRD's types and defaults; the *grants* on them
--      are narrower than the SAD's §8.7 sketch implies (a policy decides rows, a
--      grant decides columns). See "Privileges" below.
--   8. `dues` is readable but not client-writable. `paid_paise` is a derived value —
--      SAD §8.6 invariant 3 says it "must equal the sum of verified allocations" —
--      so a grant that let a client move it would let a client mark their own bill
--      paid. The insert/update policies arrive with the paths that may write dues
--      (T066 publish, T067/T068 payments), because a policy without a grant is half
--      a decision and the dangerous half is the grant.
--
-- §8.6 — THE INVARIANT, AND WHY THE SAD'S SKETCH IS NOT COPIED VERBATIM
--
-- The sketch in SAD §8.6 is correct in shape and wrong in three reachable ways.
-- All three are fixed here, and each has a test in
-- `apps/api/test/integration/expense-schema.integration-spec.ts`:
--
--   (a) `NEW.expense_id` on DELETE. A trigger fired by DELETE has no NEW row: NEW
--       is NULL, `NEW.expense_id` is NULL, the lookup finds no expense and the
--       function returns. Deleting one split of a published expense — through the
--       path T066's recalculation will use — would therefore be *silently
--       unenforced*. Fixed by resolving the expense as
--       `COALESCE(NEW.expense_id, OLD.expense_id)`.
--   (b) Only `expense_splits` was watched. `UPDATE expenses SET amount_paise = …`
--       changes the expected side of the equation without touching a split row, so
--       a mismatched published expense could be created by one statement on the
--       parent. Fixed by a companion constraint trigger on `expenses`, deferred the
--       same way, firing on INSERT and on UPDATE **OF the two columns the invariant
--       reads** (`amount_paise`, `status`) so an unrelated edit — a title fix — does
--       not re-open a check that cannot have changed.
--   (c) Neither trigger serialised anything. Under READ COMMITTED a deferred check
--       reads a snapshot taken when it runs, so two transactions each rewriting
--       *different* splits, each ending in a locally-balanced state, both pass and
--       commit an unbalanced result — classic write skew, no error anywhere. Fixed
--       by taking the parent expense row's lock (`SELECT … FOR UPDATE`) inside the
--       shared check, *before* it reads the splits. Because the validators are then
--       serialised and each one holds the lock until it commits, the transaction
--       that validates last sees its own writes plus every earlier committed write —
--       i.e. the final state — and refuses it if it is unbalanced. This is the
--       narrow version of the tool `20260928120000_membership_write_concurrency.sql`
--       introduced for per-society population invariants: one row per expense, not
--       one key per society, so two unrelated expenses never contend. T066's publish
--       path should take the same lock *before* writing splits (it is the documented
--       serialization point for publishing); the trigger lock is what protects every
--       writer that does not.
--
-- The refusal keeps the SAD's message shape and the project's error convention: a
-- bare `P0001` is what every other trigger here raises (`SOCIETY_ADMIN_REQUIRED`,
-- `BUILDING_HAS_APARTMENTS`, …) and the API's `SQLSTATE.raised` branch matches the
-- name in the message (`apps/api/src/common/database/postgres-errors.ts`). So the
-- stable, machine-detectable identity is **`P0001` + the `SPLIT_MISMATCH:` prefix**,
-- and that — never the interpolated sentence — is what the tests assert.
--
-- Down (run by hand — the runner is forward-only; same convention as the other
-- eighteen files, and ADR-0008 is why there is no second, automated path):
--   DROP TRIGGER IF EXISTS trg_expense_split_total_write ON public.expenses;
--   DROP TRIGGER IF EXISTS trg_split_total_write ON public.expense_splits;
--   DROP FUNCTION IF EXISTS public.chk_expense_split_total();
--   DROP FUNCTION IF EXISTS public.chk_split_total();
--   DROP FUNCTION IF EXISTS public.assert_split_total(uuid);
--   DROP TABLE IF EXISTS public.dues;
--   DROP TABLE IF EXISTS public.expense_gst_details;
--   DROP TABLE IF EXISTS public.expense_revisions;
--   DROP TABLE IF EXISTS public.expense_splits;
--   DROP TABLE IF EXISTS public.expenses;
--   DROP TABLE IF EXISTS public.expense_categories;
--   ALTER TABLE public.members DROP CONSTRAINT IF EXISTS uq_members_id_society;
--   REVOKE ALL ON FUNCTION public.default_expense_categories() FROM PUBLIC, anon, authenticated;
--   DROP FUNCTION IF EXISTS public.default_expense_categories();
--   REVOKE ALL ON FUNCTION public.can_view_expenses(uuid) FROM PUBLIC, anon, authenticated;
--   REVOKE ALL ON FUNCTION public.can_draft_expenses(uuid) FROM PUBLIC, anon, authenticated;
--   REVOKE ALL ON FUNCTION public.can_publish_expenses(uuid) FROM PUBLIC, anon, authenticated;
--   DROP FUNCTION IF EXISTS public.can_view_expenses(uuid);
--   DROP FUNCTION IF EXISTS public.can_draft_expenses(uuid);
--   DROP FUNCTION IF EXISTS public.can_publish_expenses(uuid);
--   DROP TYPE IF EXISTS public.due_status;
--   DROP TYPE IF EXISTS public.expense_status;
--   -- and restore the previous body of public.seed_society() from
--   -- 20260920130000_society_core.sql (it is replaced, not merely extended, below).
-- Tested by running exactly these statements against a disposable database
-- (`pnpm db:reset` then the block, then `pnpm db:reset` again) — see the T060
-- verification log.

-- ─────────────────────────────────────────────────────────────────────────────
-- Enums (PRD §7.1)
-- ─────────────────────────────────────────────────────────────────────────────

-- The guarded `DO` block is the idiom `…_society_core.sql` established: the type is
-- shared vocabulary, so re-running against a database that already has it must be a
-- no-op rather than an error. (`IF NOT EXISTS` is not valid syntax for `CREATE TYPE`.)
--
-- The value order is the PRD's, and it is load-bearing for more than reads: an enum
-- is ordered, so `ORDER BY status` and every `BETWEEN` on these columns are decided
-- by the order written here — `draft` < `pending_approval` < `published` < `void`.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'expense_status') THEN
    CREATE TYPE public.expense_status AS ENUM
      ('draft', 'pending_approval', 'published', 'void');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'due_status') THEN
    CREATE TYPE public.due_status AS ENUM
      ('pending', 'partial', 'paid', 'overdue', 'waived', 'written_off');
  END IF;
END
$$;

COMMENT ON TYPE public.expense_status IS
  'Expense lifecycle (PRD §3.5.3): draft → pending_approval (above the society''s threshold) → published → void. Only `published` is required to balance.';
COMMENT ON TYPE public.due_status IS
  'Dues lifecycle (PRD §3.6): pending → partial → paid, plus overdue, waived and written_off.';

-- ─────────────────────────────────────────────────────────────────────────────
-- The tenancy anchor for `members`
-- ─────────────────────────────────────────────────────────────────────────────

-- Every expense-domain row names a member (`created_by`, `paid_by_member_id`,
-- `expense_splits.member_id`, `dues.member_id`, …), and the denormalised
-- `society_id` arrives from the caller's header. Without a composite key an Admin
-- could charge an expense to another society's member and every other constraint
-- would still hold — the failure `20260925120000_members_directory.sql` documents at
-- length for `members.apartment_id`. A composite reference needs something unique to
-- point at, so `(id, society_id)` becomes unique here, exactly as
-- `buildings (id, society_id)` did for apartments and wings. `id` is already the
-- primary key; this constraint's only job is to be a foreign-key target.
-- Added conditionally rather than as the usual `DROP … IF EXISTS` + `ADD` pair, and the
-- difference is not cosmetic: once `expenses`, `expense_splits`, `expense_revisions` and
-- `dues` reference this constraint, dropping it is refused ("cannot drop constraint …
-- because other objects depend on it"), so the drop-and-add form would make the file
-- impossible to run a second time. This form is a no-op when the constraint is there,
-- which is what makes the whole file re-runnable — the property
-- `20260920130000_society_core.sql` states for its own enums, and the one the
-- reversibility test asserts by applying this file twice in a row.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'uq_members_id_society'
       AND conrelid = 'public.members'::regclass
  ) THEN
    ALTER TABLE public.members
      ADD CONSTRAINT uq_members_id_society UNIQUE (id, society_id);
  END IF;
END
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- expense_categories (PRD §7.3, §3.5.3)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.expense_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id uuid NOT NULL REFERENCES public.societies (id) ON DELETE CASCADE,
  name varchar(80) NOT NULL,
  icon varchar(40),
  -- `varchar(9)` is the PRD's width: `#RRGGBB` or `#RRGGBBAA`.
  color varchar(9),
  -- What a new expense in this category starts as, and the basis that goes with it
  -- when the strategy is `apartment`. Both are the split engine's vocabulary, which
  -- is why they are enum columns rather than free text.
  default_split_strategy public.split_strategy NOT NULL DEFAULT 'equal',
  default_apartment_basis public.apartment_basis,
  -- PRD §2.2: excluded from tenant splits and routed to the flat's owner. The
  -- seeded `true` values are Sinking Fund and Corpus Fund — the categories the PRD
  -- names in that sentence (§3.5.4 repeats it: "Sinking Fund (owner-only, per-sqft),
  -- Corpus/Repair Fund (owner-only)"). No other seeded category is owner-only; a
  -- society can change this per category at any time (T062).
  is_owner_only boolean NOT NULL DEFAULT false,
  -- PRD §3.5.3: excluded from operating-expense trend charts. Seeded `true` for the
  -- same two funds: they create capital rather than consume a period's budget, which
  -- is the distinction the flag draws.
  is_capital boolean NOT NULL DEFAULT false,
  gst_applicable boolean NOT NULL DEFAULT false,
  -- Deactivation is the documented alternative to deletion (T062), so this is a
  -- first-class state rather than a soft delete.
  is_active boolean NOT NULL DEFAULT true,
  display_order smallint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.members (id),
  updated_by uuid REFERENCES public.members (id),
  deleted_at timestamptz,
  deleted_by uuid REFERENCES public.members (id),
  version integer NOT NULL DEFAULT 1,

  -- The foreign-key target for `expenses.category_id`, so a category can never be
  -- borrowed across societies.
  CONSTRAINT uq_expense_categories_id_society UNIQUE (id, society_id),
  CONSTRAINT chk_expense_categories_display_order CHECK (display_order >= 0)
);

COMMENT ON TABLE public.expense_categories IS
  'Per-society expense categories (PRD §3.5.3). Nineteen are seeded on society creation; all are editable. Soft-deleted, deactivated instead of deleted when an expense references them.';

-- Name uniqueness among *live* rows only (SAD §8.1's soft-delete convention). A
-- deleted `Miscellaneous` must not reserve the name forever, and a partial index is
-- what makes "unique per society" mean "unique among the categories this society can
-- actually use".
CREATE UNIQUE INDEX IF NOT EXISTS uq_expense_categories_society_name
  ON public.expense_categories (society_id, name)
  WHERE deleted_at IS NULL;

-- `touch_updated_at()` is created by the auth migration and is the shared
-- convention (SAD §8.1). It bumps `version` too, which this table has.
DROP TRIGGER IF EXISTS set_expense_categories_updated_at ON public.expense_categories;
CREATE TRIGGER set_expense_categories_updated_at
  BEFORE UPDATE ON public.expense_categories
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- expenses (PRD §7.3, SAD §8.3/§8.5)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id uuid NOT NULL REFERENCES public.societies (id) ON DELETE CASCADE,
  -- `RESTRICT`-like default (NO ACTION): a category with expenses cannot be dropped
  -- out from under them. Categories are soft-deleted and deactivated, so the
  -- deletion this refuses is not a path the product has.
  category_id uuid NOT NULL,
  title varchar(120) NOT NULL,
  description text,
  -- Money is integer paise everywhere (ADR-0005, SAD §18.1). `> 0`, not `>= 0`: a
  -- zero-value expense is not a bill, and SAD §8.5 pins exactly this predicate.
  amount_paise bigint NOT NULL,
  -- Single-market product: the column exists so a future multi-currency expense is a
  -- data change rather than a schema change (PRD §7.3). Not client-writable.
  currency char(3) NOT NULL DEFAULT 'INR',
  expense_date date NOT NULL,
  vendor_name varchar(120),
  -- Where the money came from: `society_account`, or a member's pocket (with
  -- `paid_by_member_id` naming them). Free text rather than an enum because the PRD
  -- lists it as a form choice, not as a vocabulary the database has to police.
  payment_source varchar(24) NOT NULL DEFAULT 'society_account',
  -- The member who fronted the money, when `payment_source` says a member did.
  paid_by_member_id uuid,
  split_strategy public.split_strategy NOT NULL,
  -- NULL unless `split_strategy = 'apartment'`; `planSplit` refuses an apartment
  -- strategy without one, so the column's nullability mirrors the engine's contract.
  apartment_basis public.apartment_basis,
  split_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  participant_selector jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- `draft` by default: an expense is constructed with no splits and becomes
  -- billable only when published. The invariant below reads this column.
  status public.expense_status NOT NULL DEFAULT 'draft',
  is_recurring boolean NOT NULL DEFAULT false,
  due_date date,
  created_by uuid NOT NULL,
  approved_by uuid,
  approved_at timestamptz,
  published_at timestamptz,
  voided_at timestamptz,
  voided_by uuid,
  void_reason text,
  -- Optimistic locking (SAD §7.10 `VERSION_MISMATCH`), bumped by the trigger below.
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_expenses_amount_positive CHECK (amount_paise > 0),
  -- The foreign-key target for every child row (`expense_splits`,
  -- `expense_revisions`, `expense_gst_details`, `dues`), so a child can never be
  -- pointed at a parent in another society. `id` is already the primary key; this
  -- constraint's only job is to be referenced, exactly as
  -- `buildings (id, society_id)` and `apartments (id, society_id)` are.
  CONSTRAINT uq_expenses_id_society UNIQUE (id, society_id),
  -- A published expense cannot be missing the timestamp that says when it became
  -- billable, and a voided one cannot be missing its reason. These are the two cells
  -- of the lifecycle the PRD makes mandatory (PRD §3.5.3: voiding requires a reason
  -- of at least 10 characters — the length rule is the domain's, because it is a
  -- *field* error a client must show, not a crash).
  CONSTRAINT chk_expenses_published_at CHECK (status <> 'published' OR published_at IS NOT NULL),
  CONSTRAINT chk_expenses_void_reason CHECK (status <> 'void' OR void_reason IS NOT NULL),

  -- Composite tenant keys: the category and every member this row names must belong
  -- to the same society as the expense.
  CONSTRAINT fk_expenses_category FOREIGN KEY (category_id, society_id)
    REFERENCES public.expense_categories (id, society_id),
  CONSTRAINT fk_expenses_created_by FOREIGN KEY (created_by, society_id)
    REFERENCES public.members (id, society_id),
  CONSTRAINT fk_expenses_paid_by FOREIGN KEY (paid_by_member_id, society_id)
    REFERENCES public.members (id, society_id),
  CONSTRAINT fk_expenses_approved_by FOREIGN KEY (approved_by, society_id)
    REFERENCES public.members (id, society_id),
  CONSTRAINT fk_expenses_voided_by FOREIGN KEY (voided_by, society_id)
    REFERENCES public.members (id, society_id)
);

COMMENT ON TABLE public.expenses IS
  'Society expenses (PRD §3.5). Never hard-deleted: voided. A published row''s splits must sum exactly to amount_paise, enforced at COMMIT by chk_split_total().';

-- SAD §8.5's index plan, verbatim. Note what is *not* here: `created_by`,
-- `paid_by_member_id`, `approved_by` and `voided_by` are foreign keys without an
-- index, which SAD §8.1's general rule ("every FK column is indexed") would ask for.
-- §8.5 is the table-level plan and no query path filters by actor, so indexing four
-- columns that are written on every insert would buy nothing and cost write
-- amplification on the hottest financial table. The cascade those indexes would
-- speed up is unreachable: a society is soft-deleted and an expense is voided.
CREATE INDEX IF NOT EXISTS idx_expenses_society_date
  ON public.expenses (society_id, expense_date DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_society_status
  ON public.expenses (society_id, status);
CREATE INDEX IF NOT EXISTS idx_expenses_category
  ON public.expenses (category_id);

-- Full-text search (PRD §7.3, SAD §8.5: "GIN tsvector(title, description, vendor)").
--
-- The expression is the PRD's, character for character, and it has to be: an
-- expression index is only used when the query's expression matches, so a search
-- that re-spells this (adds a separator, drops a `coalesce`) silently seq-scans.
-- `coalesce` is not decoration — `title || ' ' || NULL` is NULL, and a NULL tsvector
-- matches nothing, so without it an expense with no description would be unsearchable
-- by its own title.
--
-- `to_tsvector('english', …)` with a literal configuration is immutable, which is what
-- makes it indexable at all. Changing `'english'` means rewriting this index and every
-- query that uses it, together.
CREATE INDEX IF NOT EXISTS idx_expenses_search
  ON public.expenses USING gin (
    to_tsvector(
      'english',
      title || ' ' || coalesce(description, '') || ' ' || coalesce(vendor_name, '')
    )
  );

DROP TRIGGER IF EXISTS set_expenses_updated_at ON public.expenses;
CREATE TRIGGER set_expenses_updated_at
  BEFORE UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- expense_splits (PRD §7.3, SAD §8.3/§8.5)
-- ─────────────────────────────────────────────────────────────────────────────

-- One row per participant per expense: what that flat (and, when resolved, that
-- member) owes. Written by the publish/recalculation path (T066) from the split
-- engine's `allocations`, and the table `chk_split_total()` reads.
CREATE TABLE IF NOT EXISTS public.expense_splits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id uuid NOT NULL REFERENCES public.societies (id) ON DELETE CASCADE,
  expense_id uuid NOT NULL,
  -- Both nullable, because a participant is a *flat* first and a member second:
  -- PRD §3.6's owner-only routing can leave a due attached to a flat with no owner
  -- membership ("no owner membership exists → the due attaches to the apartment and
  -- shows as unassigned"). `on delete set null (member_id)` is a column-specific SET
  -- NULL (PostgreSQL 15+, which Supabase and the project's CI container both are) —
  -- a plain SET NULL would try to null `society_id`, which is NOT NULL by design.
  member_id uuid,
  apartment_id uuid,
  -- `>= 0`, not `> 0`: a floor-band exemption is a real, deliberate ₹0 allocation
  -- (SPLIT_ENGINE.md §5 — "a zero multiplier is an exemption, not an exclusion"),
  -- so the constraint must not refuse it. SAD §8.5 pins this predicate.
  amount_paise bigint NOT NULL,
  -- The engine's exact weight for the basis that produced the row, in the column's
  -- own scale (areas in hundredths, band multipliers in thousandths — SPLIT_ENGINE.md
  -- §7). `numeric(12, 4)` is the documented first place a weight could overflow: a
  -- 100,000 sqft flat weighs 10,000,000 hundredths, which fits, but a banded basis on
  -- an even larger notional area would not. Recorded here because the column is
  -- T060's, and the engine's own `per_sqft` weights are the producer.
  weight numeric(12, 4),
  percent numeric(7, 4),
  -- Why this participant was charged: `owner_only_category` is the PRD's example
  -- (§3.5.4), and T063 writes the value.
  assigned_reason varchar(40),
  -- The participant's name and flat number *as they were when the expense was
  -- published*, so a later rename does not rewrite history (PRD §7.3).
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_expense_splits_amount_non_negative CHECK (amount_paise >= 0),
  -- A split with neither a member nor a flat is a debt owed by nobody: it cannot be
  -- billed, chased, or explained on a statement. A flat-only row is the documented
  -- "unassigned" case (PRD §3.5.4), and a member-only row is legitimate for a
  -- charge against a person rather than a flat.
  CONSTRAINT chk_expense_splits_participant
    CHECK (member_id IS NOT NULL OR apartment_id IS NOT NULL),
  -- "One row per participant per expense". NULLS NOT DISTINCT is the whole point:
  -- the PRD's plain UNIQUE treats (expense, NULL, flat) as distinct from itself, so
  -- the duplicate it is written to prevent would be accepted.
  CONSTRAINT uq_expense_splits_participant
    UNIQUE NULLS NOT DISTINCT (expense_id, member_id, apartment_id),
  -- The target for `dues.split_id`, and the anchor that keeps a split in its
  -- expense's society.
  CONSTRAINT uq_expense_splits_id_society UNIQUE (id, society_id),

  CONSTRAINT fk_expense_splits_expense FOREIGN KEY (expense_id, society_id)
    REFERENCES public.expenses (id, society_id) ON DELETE CASCADE,
  CONSTRAINT fk_expense_splits_member FOREIGN KEY (member_id, society_id)
    REFERENCES public.members (id, society_id) ON DELETE SET NULL (member_id),
  CONSTRAINT fk_expense_splits_apartment FOREIGN KEY (apartment_id, society_id)
    REFERENCES public.apartments (id, society_id) ON DELETE SET NULL (apartment_id)
);

COMMENT ON TABLE public.expense_splits IS
  'What each participating flat/member owes for one expense (PRD §3.5.3). The rows chk_split_total() sums: for a published expense they must total amount_paise exactly.';

CREATE INDEX IF NOT EXISTS idx_splits_expense ON public.expense_splits (expense_id);
CREATE INDEX IF NOT EXISTS idx_splits_member ON public.expense_splits (member_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- expense_revisions (PRD §3.5.3 "Edit Expense"; SAD §8.1 append-only tier)
-- ─────────────────────────────────────────────────────────────────────────────

-- A full snapshot per edit, because the PRD makes the history visible: "Residents
-- see an 'edited' chip with a tap-through history. **This transparency is a core
-- trust feature — do not make it optional.**" That sentence is why the row is a
-- snapshot rather than a diff, and why the table is append-only at the grant level:
-- a revision that can be edited or deleted is not a revision.
CREATE TABLE IF NOT EXISTS public.expense_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id uuid NOT NULL REFERENCES public.societies (id) ON DELETE CASCADE,
  expense_id uuid NOT NULL,
  -- The expense's `version` at the time of the edit. Unique per expense, so a
  -- history can never contain two different states claiming the same version.
  version integer NOT NULL,
  snapshot jsonb NOT NULL,
  changed_by uuid NOT NULL,
  change_note text,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_expense_revisions_version CHECK (version >= 1),
  CONSTRAINT uq_expense_revisions_expense_version UNIQUE (expense_id, version),
  CONSTRAINT fk_expense_revisions_expense FOREIGN KEY (expense_id, society_id)
    REFERENCES public.expenses (id, society_id) ON DELETE CASCADE,
  CONSTRAINT fk_expense_revisions_changed_by FOREIGN KEY (changed_by, society_id)
    REFERENCES public.members (id, society_id)
);

COMMENT ON TABLE public.expense_revisions IS
  'Append-only full snapshots of an expense, one per edit (PRD §3.5.3). UPDATE and DELETE are not granted to any client role.';

-- ─────────────────────────────────────────────────────────────────────────────
-- expense_gst_details (PRD §7.3, §3.5.3 "GST Details")
-- ─────────────────────────────────────────────────────────────────────────────

-- 1:1 with an expense, and keyed by it: the expense is the identity, so there is no
-- separate id and no created_at/updated_at/version (nothing about a GST detail has a
-- life of its own). `society_id` is present for the reason in the header — RLS and
-- the composite key.
CREATE TABLE IF NOT EXISTS public.expense_gst_details (
  expense_id uuid PRIMARY KEY,
  society_id uuid NOT NULL REFERENCES public.societies (id) ON DELETE CASCADE,
  gstin varchar(15),
  invoice_number varchar(64),
  invoice_date date,
  taxable_value_paise bigint NOT NULL DEFAULT 0,
  cgst_paise bigint NOT NULL DEFAULT 0,
  sgst_paise bigint NOT NULL DEFAULT 0,
  igst_paise bigint NOT NULL DEFAULT 0,
  cess_paise bigint NOT NULL DEFAULT 0,
  hsn_sac varchar(16),
  place_of_supply varchar(40),
  is_reverse_charge boolean NOT NULL DEFAULT false,
  itc_eligible boolean NOT NULL DEFAULT false,

  -- A tax invoice is either an inter-state one (IGST) or an intra-state one
  -- (CGST + SGST); both at once is a data-entry error that would double-count the tax
  -- in every report. The PRD writes this check itself.
  CONSTRAINT gst_single_regime
    CHECK (NOT (igst_paise > 0 AND (cgst_paise > 0 OR sgst_paise > 0))),
  -- Every component is paise and none of them can be negative: a credit note is a
  -- different document, not a negative CGST.
  CONSTRAINT chk_expense_gst_details_non_negative
    CHECK (
      taxable_value_paise >= 0 AND cgst_paise >= 0 AND sgst_paise >= 0
      AND igst_paise >= 0 AND cess_paise >= 0
    ),
  CONSTRAINT fk_expense_gst_details_expense FOREIGN KEY (expense_id, society_id)
    REFERENCES public.expenses (id, society_id) ON DELETE CASCADE
);

COMMENT ON TABLE public.expense_gst_details IS
  'Optional 1:1 GST detail for an expense (PRD §3.5.3): vendor GSTIN, invoice, the five tax components and the ITC flags.';

-- ─────────────────────────────────────────────────────────────────────────────
-- dues (PRD §7.3, SAD §8.3/§8.5)
-- ─────────────────────────────────────────────────────────────────────────────

-- What a member actually owes, created when an expense is published. Separated from
-- `expense_splits` because a split is the *bill* and a due is the *receivable*: a
-- due can also be a late fee or an adjustment (PRD §3.6), and its status moves on its
-- own as payments land.
CREATE TABLE IF NOT EXISTS public.dues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id uuid NOT NULL REFERENCES public.societies (id) ON DELETE CASCADE,
  member_id uuid NOT NULL,
  apartment_id uuid,
  expense_id uuid,
  split_id uuid,
  -- `principal|late_fee|adjustment` (PRD §7.3). An enum in the PRD's own comment, so
  -- a CHECK here rather than a third enum type: the vocabulary is three values that
  -- will not grow independently of this table, and a CHECK keeps it in one file.
  kind varchar(16) NOT NULL DEFAULT 'principal',
  -- No `> 0` check here, but note what the constraint below then implies: `paid_paise
  -- BETWEEN 0 AND amount_paise` (SAD §8.5) is unsatisfiable for a negative
  -- `amount_paise`, so a credit cannot be stored as a negative due — which the PRD's
  -- void flow would like to do ("payments already made against it convert to an advance
  -- credit on the member's account") and which its `adjustment` kind implies. T060
  -- implements the documented constraint verbatim rather than inventing an exception,
  -- and the tension is recorded for the payments task (T067/T068) to settle.
  amount_paise bigint NOT NULL,
  paid_paise bigint NOT NULL DEFAULT 0,
  status public.due_status NOT NULL DEFAULT 'pending',
  due_date date NOT NULL,
  waived_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- SAD §8.5: "CHECK (paid_paise BETWEEN 0 AND amount_paise)". Both ends matter: the
  -- upper one stops a due being overpaid *as a row state* (allocations are reconciled
  -- against it in SAD §8.6 invariant 3), the lower one stops a negative payment.
  CONSTRAINT chk_dues_paid_within_amount
    CHECK (paid_paise >= 0 AND paid_paise <= amount_paise),
  CONSTRAINT chk_dues_kind
    CHECK (kind IN ('principal', 'late_fee', 'adjustment')),

  -- A due belongs to one society's member; `set null (apartment_id)` is the
  -- column-specific form again, so a flat's removal cannot null the tenant.
  CONSTRAINT fk_dues_member FOREIGN KEY (member_id, society_id)
    REFERENCES public.members (id, society_id) ON DELETE CASCADE,
  CONSTRAINT fk_dues_apartment FOREIGN KEY (apartment_id, society_id)
    REFERENCES public.apartments (id, society_id) ON DELETE SET NULL (apartment_id),
  CONSTRAINT fk_dues_expense FOREIGN KEY (expense_id, society_id)
    REFERENCES public.expenses (id, society_id) ON DELETE CASCADE,
  CONSTRAINT fk_dues_split FOREIGN KEY (split_id, society_id)
    REFERENCES public.expense_splits (id, society_id) ON DELETE CASCADE
);

COMMENT ON TABLE public.dues IS
  'Per-member receivables (PRD §3.6): principal from a published split, plus late fees and adjustments. paid_paise is derived from verified allocations (SAD §8.6 invariant 3) and is not client-writable.';

CREATE INDEX IF NOT EXISTS idx_dues_member_status ON public.dues (member_id, status);
CREATE INDEX IF NOT EXISTS idx_dues_society_due_date ON public.dues (society_id, due_date);
-- The hot list: what is still owed. Partial, so paying members do not carry rows in
-- the index the treasurer's screen reads (PRD §3.6, SAD §8.5).
CREATE INDEX IF NOT EXISTS idx_dues_outstanding
  ON public.dues (society_id, status)
  WHERE status IN ('pending', 'partial', 'overdue');

DROP TRIGGER IF EXISTS set_dues_updated_at ON public.dues;
CREATE TRIGGER set_dues_updated_at
  BEFORE UPDATE ON public.dues
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- The money invariant — SAD §8.6, corrected (see the header)
-- ─────────────────────────────────────────────────────────────────────────────

-- One implementation, called by both triggers, so the two directions of the
-- equation cannot drift apart.
--
-- SECURITY DEFINER, and that is load-bearing rather than decorative: the function
-- reads `expenses` and `expense_splits`, both of which carry FORCE ROW LEVEL
-- SECURITY, and it locks the expense row. Run as the caller it would see only what
-- the caller can see (a `guest`, a service transaction with no identity, and a
-- trigger fired by a cascade would each read nothing and return) — and `SELECT … FOR
-- UPDATE` additionally needs UPDATE privilege on the columns it selects, which the
-- runtime role has only for the columns it may write. As the owner it sees the truth.
-- `SET search_path = ''` with fully-qualified names is the documented hardening.
--
-- The lock is taken *before* the status test, not after: a transaction that is
-- publishing an expense and one that is editing a split must be ordered against each
-- other even though the second one's obligation depends on the first one's outcome.
CREATE OR REPLACE FUNCTION public.assert_split_total(p_expense_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  expected bigint;
  st public.expense_status;
  total bigint;
BEGIN
  -- The parent-row lock. Held to COMMIT, so the validators of one expense are
  -- serialised and each one sees every write that committed before it — which is what
  -- closes the write-skew hole rather than merely narrowing it.
  SELECT e.amount_paise, e.status
    INTO expected, st
    FROM public.expenses e
   WHERE e.id = p_expense_id
     FOR UPDATE;

  -- No row means this expense is gone in this transaction (a hard delete, or the
  -- cascade from its society). There is nothing left to conserve either way.
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Only a published expense is a bill. A draft is *allowed* to be incomplete — that
  -- is what drafting is — and a voided one has deliberately stopped being a debt. The
  -- early return is why T065 can build a draft and write its splits over several
  -- statements without a constraint fighting it, and why voiding an expense does not
  -- require rewriting its splits.
  IF st <> 'published' THEN
    RETURN;
  END IF;

  SELECT COALESCE(SUM(s.amount_paise), 0)
    INTO total
    FROM public.expense_splits s
   WHERE s.expense_id = p_expense_id;

  -- Exact equality. No epsilon, no tolerance, no floating point: these are integer
  -- paise, and a one-paisa rounding error is exactly the defect this exists to refuse
  -- (a published expense with no splits at all lands here too, as `0 <> amount`).
  IF total <> expected THEN
    RAISE EXCEPTION 'SPLIT_MISMATCH: expense % splits total % expected %',
      p_expense_id, total, expected
      USING ERRCODE = 'P0001',
            HINT = 'A published expense must have splits summing exactly to its amount.';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.assert_split_total(uuid) IS
  'Refuses a COMMIT in which a published expense''s splits do not sum exactly to its amount. Locks the expense row, so concurrent split writers are serialised (SAD §8.6).';

-- The split side: INSERT, UPDATE and DELETE.
--
-- `COALESCE(NEW.expense_id, OLD.expense_id)` is the correction described in the
-- header: a trigger fired by DELETE has no NEW row at all, so the SAD's
-- `NEW.expense_id` makes deletion silently unenforced.
CREATE OR REPLACE FUNCTION public.chk_split_total()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.assert_split_total(COALESCE(NEW.expense_id, OLD.expense_id));
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.chk_split_total() IS
  'Deferred constraint trigger on expense_splits: a split write may leave the total short for the moment, but not past COMMIT.';

-- DEFERRABLE INITIALLY DEFERRED is the whole point. A published expense is built by
-- inserting N splits — the first one alone is *always* short — so a per-row check
-- would refuse every legitimate write. Deferred, the check runs once per changed row
-- at COMMIT and judges only the final state, exactly like
-- `chk_admin_present_after_member_write` above it in this history.
DROP TRIGGER IF EXISTS trg_split_total_write ON public.expense_splits;
CREATE CONSTRAINT TRIGGER trg_split_total_write
  AFTER INSERT OR UPDATE OR DELETE ON public.expense_splits
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.chk_split_total();

-- The parent side, which the SAD's sketch is missing entirely: without it,
-- `UPDATE expenses SET amount_paise = …` invalidates the total with no split row
-- touched and nothing fires.
--
-- `UPDATE OF amount_paise, status` narrows the trigger to the two columns the
-- invariant reads. A title edit or a description edit cannot change the equation, so
-- it must not re-open a check (and must not lock the row against a concurrent split
-- writer for no reason).
CREATE OR REPLACE FUNCTION public.chk_expense_split_total()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.assert_split_total(NEW.id);
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.chk_expense_split_total() IS
  'Deferred constraint trigger on expenses: changing a published expense''s amount or status must leave its splits summing exactly to the new amount (the other half of SAD §8.6).';

DROP TRIGGER IF EXISTS trg_expense_split_total_write ON public.expenses;
CREATE CONSTRAINT TRIGGER trg_expense_split_total_write
  AFTER INSERT OR UPDATE OF amount_paise, status ON public.expenses
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.chk_expense_split_total();

-- Privileges on the three functions.
--
-- `ALTER DEFAULT PRIVILEGES` (bootstrap) grants EXECUTE on new functions to
-- `authenticated`, so this REVOKE is not ceremony: `assert_split_total()` is
-- SECURITY DEFINER and reads an expense's amount irrespective of RLS, so leaving it
-- callable would be a cross-society oracle — pass any uuid, learn whether it is
-- published and what it is worth from the mismatch message. The trigger functions
-- cannot be called directly at all (Postgres refuses a trigger function outside a
-- trigger), and are revoked anyway so the surface has no exception to remember.
REVOKE ALL ON FUNCTION public.assert_split_total(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chk_split_total() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chk_expense_split_total() FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS predicates — one per permission matrix cell (SAD §8.7, PRD §2.1)
-- ─────────────────────────────────────────────────────────────────────────────

-- Three functions rather than one, because they answer three different questions and
-- the policies read them by name. All three are SECURITY DEFINER for the reason
-- `is_society_member()` documents: a policy on a table that read `members` would
-- recurse, and one definition means the six policies below cannot drift.
--
-- The populations are `packages/domain/src/member/permission-evaluator.ts`'s cells,
-- verbatim: `expense.view` is every role except Guest (the PRD gives a security
-- guard "No financial visibility whatsoever"), `expense.create` is Admin, Treasurer
-- and Committee (the last narrowed to drafts by the write policy, not here), and
-- `expense.publish`/`expense.void` are Admin and Treasurer — which is exactly the
-- population `is_society_member_manager()` already answers, so the third function
-- delegates to it rather than restating it, the way `is_society_join_reviewer()`
-- delegates to the same one.

CREATE OR REPLACE FUNCTION public.can_view_expenses(p_society_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.members m
     WHERE m.society_id = p_society_id
       AND m.user_id = (SELECT auth.uid())
       AND m.status = 'active'
       AND m.role IN ('admin', 'treasurer', 'committee', 'resident', 'tenant')
  );
$$;

COMMENT ON FUNCTION public.can_view_expenses(uuid) IS
  'Active holder of expense.view in this society — every role except Guest (PRD §2.1). The RLS copy of one matrix cell.';

CREATE OR REPLACE FUNCTION public.can_draft_expenses(p_society_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.members m
     WHERE m.society_id = p_society_id
       AND m.user_id = (SELECT auth.uid())
       AND m.status = 'active'
       AND m.role IN ('admin', 'treasurer', 'committee')
  );
$$;

COMMENT ON FUNCTION public.can_draft_expenses(uuid) IS
  'Active holder of expense.create in this society (Admin, Treasurer, Committee — PRD §2.1). Committee''s draft-only narrowing lives in the expenses write policy, which can see the row''s status.';

CREATE OR REPLACE FUNCTION public.can_publish_expenses(p_society_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.is_society_member_manager(p_society_id);
$$;

COMMENT ON FUNCTION public.can_publish_expenses(uuid) IS
  'Active holder of expense.publish / expense.void — and of category writes — in this society: Admin or Treasurer (PRD §2.1). Delegates to is_society_member_manager() so the population has one definition.';

REVOKE ALL ON FUNCTION public.can_view_expenses(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_draft_expenses(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_publish_expenses(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_view_expenses(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_draft_expenses(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_publish_expenses(uuid) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS (SAD §8.7: "applied to every tenant table without exception")
-- ─────────────────────────────────────────────────────────────────────────────

-- FORCE, not just ENABLE: without it the table owner bypasses its own policies, which
-- is the commonest way an RLS setup fails open.
ALTER TABLE public.expense_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expense_categories FORCE ROW LEVEL SECURITY;
ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expenses FORCE ROW LEVEL SECURITY;
ALTER TABLE public.expense_splits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expense_splits FORCE ROW LEVEL SECURITY;
ALTER TABLE public.expense_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expense_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.expense_gst_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expense_gst_details FORCE ROW LEVEL SECURITY;
ALTER TABLE public.dues ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dues FORCE ROW LEVEL SECURITY;

-- ── expense_categories ───────────────────────────────────────────────────────
--
-- Read: every non-Guest member (a category name is not a secret; it is a picker
-- label). Write: Admin and Treasurer (T062's acceptance) — narrower than the SAD's
-- §8.7 sketch, which lists Committee for *expense* writes; a category is society
-- vocabulary, not a portfolio draft.

DROP POLICY IF EXISTS expense_categories_select_member ON public.expense_categories;
CREATE POLICY expense_categories_select_member
  ON public.expense_categories
  FOR SELECT
  TO authenticated
  USING (public.can_view_expenses(society_id));

DROP POLICY IF EXISTS expense_categories_insert_manager ON public.expense_categories;
CREATE POLICY expense_categories_insert_manager
  ON public.expense_categories
  FOR INSERT
  TO authenticated
  WITH CHECK (public.can_publish_expenses(society_id));

DROP POLICY IF EXISTS expense_categories_update_manager ON public.expense_categories;
CREATE POLICY expense_categories_update_manager
  ON public.expense_categories
  FOR UPDATE
  TO authenticated
  USING (public.can_publish_expenses(society_id))
  WITH CHECK (public.can_publish_expenses(society_id));

-- No DELETE policy: DELETE is not granted (the soft-delete tier, SAD §8.1). The
-- soft-delete path (`expense_categories.deleted_at`) is T062's, and it belongs in a
-- definer function the way `apartment_soft_delete()` does — a policy cannot vary by
-- column, so "may edit a category's name" and "may delete it" have to be two
-- decisions, and the second one is the one with a reference check in it.

-- ── expenses ─────────────────────────────────────────────────────────────────
--
-- Read: every non-Guest member. PRD §2.2 makes this a product principle, not a
-- convenience: a Resident's workflow is "Inspect any expense and its attached bill
-- (full transparency is a product principle)".
--
-- Write: Admin and Treasurer may write any state; Committee may write a draft and
-- only a draft (`expense.create`'s 🟡 cell — "scoped: draft only"). The Committee
-- branch reads `status` from the row: on INSERT that is the row being written, on
-- UPDATE it is the row as it stands, which is what stops a Committee Member from
-- publishing an expense rather than any separate rule.

DROP POLICY IF EXISTS expenses_select_member ON public.expenses;
CREATE POLICY expenses_select_member
  ON public.expenses
  FOR SELECT
  TO authenticated
  USING (public.can_view_expenses(society_id));

DROP POLICY IF EXISTS expenses_insert_author ON public.expenses;
CREATE POLICY expenses_insert_author
  ON public.expenses
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.can_publish_expenses(society_id)
    OR (public.can_draft_expenses(society_id) AND status = 'draft')
  );

DROP POLICY IF EXISTS expenses_update_author ON public.expenses;
CREATE POLICY expenses_update_author
  ON public.expenses
  FOR UPDATE
  TO authenticated
  USING (
    public.can_publish_expenses(society_id)
    OR (public.can_draft_expenses(society_id) AND status = 'draft')
  )
  WITH CHECK (
    public.can_publish_expenses(society_id)
    OR (public.can_draft_expenses(society_id) AND status = 'draft')
  );

-- No DELETE policy: DELETE is not granted. SAD §8.1 puts expenses in the "never
-- deleted — voided instead" tier and revokes DELETE at the grant level. The PRD's
-- one exception ("Drafts can be hard-deleted by their creator", §3.5.3) is recorded
-- in the T060 report rather than granted here: it needs a rule this policy cannot
-- express (creator-only, draft-only, and only while no split exists), which is a
-- definer function's job — the same shape as `apartment_soft_delete()`.

-- ── expense_splits ───────────────────────────────────────────────────────────
--
-- Read: same as the expense. Write: Admin/Treasurer always; Committee only while the
-- *parent expense is a draft*. The parent's status is read through a subquery rather
-- than trusted from the caller, and the row's own `society_id` decides the tenancy —
-- the composite FK then makes the subquery's answer the only possible one.
--
-- DELETE *is* granted here, unlike on `expenses`: SAD §8.1's revocation list
-- ("expenses, dues, payments, receipts, maintenance_cycles") deliberately excludes
-- splits, because recalculation replaces a published expense's split set — and that
-- delete is precisely what `chk_split_total()`'s DELETE arm exists to police.

DROP POLICY IF EXISTS expense_splits_select_member ON public.expense_splits;
CREATE POLICY expense_splits_select_member
  ON public.expense_splits
  FOR SELECT
  TO authenticated
  USING (public.can_view_expenses(society_id));

DROP POLICY IF EXISTS expense_splits_insert_author ON public.expense_splits;
CREATE POLICY expense_splits_insert_author
  ON public.expense_splits
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.can_publish_expenses(society_id)
    OR (
      public.can_draft_expenses(society_id)
      AND EXISTS (
        SELECT 1 FROM public.expenses e
         WHERE e.id = expense_id AND e.status = 'draft'
      )
    )
  );

DROP POLICY IF EXISTS expense_splits_update_author ON public.expense_splits;
CREATE POLICY expense_splits_update_author
  ON public.expense_splits
  FOR UPDATE
  TO authenticated
  USING (
    public.can_publish_expenses(society_id)
    OR (
      public.can_draft_expenses(society_id)
      AND EXISTS (
        SELECT 1 FROM public.expenses e
         WHERE e.id = expense_id AND e.status = 'draft'
      )
    )
  )
  WITH CHECK (
    public.can_publish_expenses(society_id)
    OR (
      public.can_draft_expenses(society_id)
      AND EXISTS (
        SELECT 1 FROM public.expenses e
         WHERE e.id = expense_id AND e.status = 'draft'
      )
    )
  );

DROP POLICY IF EXISTS expense_splits_delete_author ON public.expense_splits;
CREATE POLICY expense_splits_delete_author
  ON public.expense_splits
  FOR DELETE
  TO authenticated
  USING (
    public.can_publish_expenses(society_id)
    OR (
      public.can_draft_expenses(society_id)
      AND EXISTS (
        SELECT 1 FROM public.expenses e
         WHERE e.id = expense_id AND e.status = 'draft'
      )
    )
  );

-- ── expense_revisions ────────────────────────────────────────────────────────
--
-- Read: every non-Guest member (the "edited" chip and its tap-through history are
-- the transparency feature). INSERT: whoever may draft the expense — a revision is
-- written by the same edit that changes the row. No UPDATE or DELETE policy and no
-- grant: append-only, SAD §8.1.

DROP POLICY IF EXISTS expense_revisions_select_member ON public.expense_revisions;
CREATE POLICY expense_revisions_select_member
  ON public.expense_revisions
  FOR SELECT
  TO authenticated
  USING (public.can_view_expenses(society_id));

DROP POLICY IF EXISTS expense_revisions_insert_author ON public.expense_revisions;
CREATE POLICY expense_revisions_insert_author
  ON public.expense_revisions
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.can_publish_expenses(society_id)
    OR (
      public.can_draft_expenses(society_id)
      AND EXISTS (
        SELECT 1 FROM public.expenses e
         WHERE e.id = expense_id AND e.status = 'draft'
      )
    )
  );

-- ── expense_gst_details ──────────────────────────────────────────────────────

DROP POLICY IF EXISTS expense_gst_details_select_member ON public.expense_gst_details;
CREATE POLICY expense_gst_details_select_member
  ON public.expense_gst_details
  FOR SELECT
  TO authenticated
  USING (public.can_view_expenses(society_id));

DROP POLICY IF EXISTS expense_gst_details_insert_author ON public.expense_gst_details;
CREATE POLICY expense_gst_details_insert_author
  ON public.expense_gst_details
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.can_publish_expenses(society_id)
    OR (
      public.can_draft_expenses(society_id)
      AND EXISTS (
        SELECT 1 FROM public.expenses e
         WHERE e.id = expense_id AND e.status = 'draft'
      )
    )
  );

DROP POLICY IF EXISTS expense_gst_details_update_author ON public.expense_gst_details;
CREATE POLICY expense_gst_details_update_author
  ON public.expense_gst_details
  FOR UPDATE
  TO authenticated
  USING (
    public.can_publish_expenses(society_id)
    OR (
      public.can_draft_expenses(society_id)
      AND EXISTS (
        SELECT 1 FROM public.expenses e
         WHERE e.id = expense_id AND e.status = 'draft'
      )
    )
  )
  WITH CHECK (
    public.can_publish_expenses(society_id)
    OR (
      public.can_draft_expenses(society_id)
      AND EXISTS (
        SELECT 1 FROM public.expenses e
         WHERE e.id = expense_id AND e.status = 'draft'
      )
    )
  );

-- ── dues ─────────────────────────────────────────────────────────────────────
--
-- Read is *not* "any member", and the PRD is the reason: a Resident "sees other
-- residents' **aggregate** payment status … but not individual defaulter names,
-- unless the Admin enables `defaulter_list_public` (off by default — a deliberate
-- dignity/privacy default)". So a due row is visible to its own member and to the
-- society's Admin/Treasurer (who must chase it), and to nobody else. The aggregate
-- view the PRD promises is a definer function's job (the reports module), not a
-- wider policy — a policy cannot round.
--
-- No INSERT/UPDATE/DELETE policy or grant: see deviation 8 in the header.

DROP POLICY IF EXISTS dues_select_own_or_manager ON public.dues;
CREATE POLICY dues_select_own_or_manager
  ON public.dues
  FOR SELECT
  TO authenticated
  USING (
    public.can_publish_expenses(society_id)
    OR member_id IN (
      SELECT m.id FROM public.members m WHERE m.user_id = (SELECT auth.uid())
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- Privileges — the other half of every policy above
-- ─────────────────────────────────────────────────────────────────────────────

-- `ALTER DEFAULT PRIVILEGES` (bootstrap) grants `authenticated` SELECT/INSERT/
-- UPDATE/DELETE on every new table in `public`, so these REVOKEs are what turn the
-- policies into the only path. RLS filters rows; grants decide which *columns* a
-- client may write.

REVOKE ALL ON public.expense_categories FROM anon;
REVOKE ALL ON public.expense_categories FROM authenticated;
REVOKE ALL ON public.expenses FROM anon;
REVOKE ALL ON public.expenses FROM authenticated;
REVOKE ALL ON public.expense_splits FROM anon;
REVOKE ALL ON public.expense_splits FROM authenticated;
REVOKE ALL ON public.expense_revisions FROM anon;
REVOKE ALL ON public.expense_revisions FROM authenticated;
REVOKE ALL ON public.expense_gst_details FROM anon;
REVOKE ALL ON public.expense_gst_details FROM authenticated;
REVOKE ALL ON public.dues FROM anon;
REVOKE ALL ON public.dues FROM authenticated;

GRANT SELECT ON public.expense_categories TO authenticated;
GRANT INSERT (
  society_id, name, icon, color, default_split_strategy, default_apartment_basis,
  is_owner_only, is_capital, gst_applicable, is_active, display_order
) ON public.expense_categories TO authenticated;
GRANT UPDATE (
  name, icon, color, default_split_strategy, default_apartment_basis, is_owner_only,
  is_capital, gst_applicable, is_active, display_order
) ON public.expense_categories TO authenticated;
-- Not insertable or updatable: `society_id` (the tenant comes from the caller's
-- society, not from the payload), `created_by`/`updated_by` and `deleted_at`/
-- `deleted_by` (an actor and a deletion are not fields a client sends), `version` and
-- the timestamps (the trigger's).

GRANT SELECT ON public.expenses TO authenticated;
GRANT INSERT (
  society_id, category_id, title, description, amount_paise, expense_date,
  vendor_name, payment_source, paid_by_member_id, split_strategy, apartment_basis,
  split_config, participant_selector, status, is_recurring, due_date, created_by
) ON public.expenses TO authenticated;
GRANT UPDATE (
  category_id, title, description, amount_paise, expense_date, vendor_name,
  payment_source, paid_by_member_id, split_strategy, apartment_basis, split_config,
  participant_selector, status, is_recurring, due_date, void_reason
) ON public.expenses TO authenticated;
-- Not writable: `currency` (single-market, a server default), `society_id`, the
-- lifecycle stamps (`approved_at`, `approved_by`, `published_at`, `voided_at`,
-- `voided_by`) and `version`. The stamps are *facts about a transition* — a client
-- that can write `published_at` can backdate a bill — and T066's publish/void path is
-- the transition that owns them (the same shape as `society_update()`, which is where
-- `societies` keeps its derived columns). `void_reason` *is* granted because it is
-- the operator's words, which the PRD requires (min 10 chars, checked in the domain
-- where the field error can be shown); the stamp beside it is not.

GRANT SELECT ON public.expense_splits TO authenticated;
GRANT INSERT (
  society_id, expense_id, member_id, apartment_id, amount_paise, weight, percent,
  assigned_reason, snapshot
) ON public.expense_splits TO authenticated;
GRANT UPDATE (
  member_id, apartment_id, amount_paise, weight, percent, assigned_reason, snapshot
) ON public.expense_splits TO authenticated;
GRANT DELETE ON public.expense_splits TO authenticated;
-- `expense_id` is not updatable: moving a split to another expense is a different
-- debt, not an edit, and it would let a client walk a row out from under the
-- invariant's sum (the trigger would catch the result — but the row would be
-- attributable to the wrong bill in the window before COMMIT).

GRANT SELECT ON public.expense_revisions TO authenticated;
GRANT INSERT (
  society_id, expense_id, version, snapshot, changed_by, change_note
) ON public.expense_revisions TO authenticated;
-- No UPDATE, no DELETE: append-only (SAD §8.1). `created_at` is the trigger's.

GRANT SELECT ON public.expense_gst_details TO authenticated;
GRANT INSERT (
  expense_id, society_id, gstin, invoice_number, invoice_date, taxable_value_paise,
  cgst_paise, sgst_paise, igst_paise, cess_paise, hsn_sac, place_of_supply,
  is_reverse_charge, itc_eligible
) ON public.expense_gst_details TO authenticated;
GRANT UPDATE (
  gstin, invoice_number, invoice_date, taxable_value_paise, cgst_paise, sgst_paise,
  igst_paise, cess_paise, hsn_sac, place_of_supply, is_reverse_charge, itc_eligible
) ON public.expense_gst_details TO authenticated;
-- No DELETE: the row's life is its expense's, which is `on delete cascade`.

GRANT SELECT ON public.dues TO authenticated;
-- Nothing else, deliberately: `paid_paise` is derived (SAD §8.6 invariant 3) and
-- `amount_paise` is a charge. The policies that let a payment path write these arrive
-- with that path.

-- ─────────────────────────────────────────────────────────────────────────────
-- The nineteen default categories (PRD §3.5.3, Roadmap T060 acceptance)
-- ─────────────────────────────────────────────────────────────────────────────

-- `seed_society()` runs AFTER INSERT on `societies`, in the creating transaction, and
-- already seeds `society_settings` and the creator's Admin membership (PRD §3.2:
-- "Creation seeds society_settings … the creator becomes Society Admin"). The
-- category set belongs there rather than in a use case for the two reasons the merge
-- is one function: the same transaction, and no writer to forget.
--
-- WHY IT IS A DEFINER FUNCTION AND NOT AN APPLICATION CALL: `SocietyOperations.create`
-- goes through `public.society_create(jsonb)`, which is SECURITY DEFINER precisely so
-- the client needs no INSERT grant on `society_settings` or `members` — and a client
-- that could insert categories directly could also decline to. Seeding from the
-- trigger means "a society has its nineteen categories" is true for every writer that
-- can ever create a society, including a repair script or a future import.
--
-- WHAT THE FLAGS ARE, AND WHY THESE VALUES (the acceptance criterion):
--   * the list is PRD §3.5.3's, in its order, and `display_order` is that order
--     (1..19) — the picker shows a society's categories in the order the product
--     document lists them;
--   * `is_owner_only` is true for **Sinking Fund** and **Corpus Fund** only. PRD §2.2:
--     "Charge categories flagged `owner_only` (sinking fund, capital expenditure,
--     corpus) are **excluded** from tenant splits and routed to the owner's dues", and
--     §3.5.4 names them again ("Sinking Fund (owner-only, per-sqft), Corpus/Repair
--     Fund (owner-only)"). "Capital expenditure" in that sentence is the class the two
--     funds exist to pay for, not a twentieth category — inventing one would create a
--     category the product never asked for;
--   * `is_capital` is true for the same two: §3.5.3 defines the flag as "excluded from
--     operating-expense trend charts", and a fund that accumulates for future works is
--     exactly what a trend chart must not read as this month's spending. A
--     professional repaint or a lift replacement *is* capital in accounting terms, but
--     the PRD's own sentence pairs the flag with the same two funds and no category
--     named `Painting`/`Lift` carries a documented flag, so the seed does not guess;
--   * `icon`, `color`, `default_split_strategy`, `default_apartment_basis` and
--     `gst_applicable` keep the schema's defaults. The PRD says each category carries
--     them but never says *which* value any of the nineteen has, and a guessed icon or
--     a guessed per-sqft strategy would be a product decision made in a migration.
--     T062 makes all of them editable, so a society choosing them is one review away
--     rather than a schema change.
--
-- The `ON CONFLICT DO NOTHING` is a guard rather than the mechanism: this trigger
-- fires once per society, so a duplicate is impossible in the normal path — it makes
-- the function safe to re-run (a backfill, a repaired trigger) without a second copy
-- of the set. Note the *live-name* partial index is the conflict target, which is why
-- the clause carries no target list: with a partial unique index, naming the columns
-- would require the index predicate to be inferred, and "do nothing on any conflict"
-- is the intent here anyway.
-- The default set, as a function rather than a `VALUES` list written twice.
--
-- It is read by two things that must agree — the trigger that seeds a new society and
-- the backfill at the bottom of this file that seeds the ones that already exist — and a
-- nineteen-row list with two boolean flags per row is exactly the kind of literal that
-- drifts when it is copied. One definition, one place to change, and a test can read the
-- same source the database uses.
--
-- Not `SECURITY DEFINER`: it touches no table, so there is nothing for a definer to make
-- safe, and a function that reads nothing has nothing to leak.
CREATE OR REPLACE FUNCTION public.default_expense_categories()
RETURNS TABLE (
  name varchar,
  display_order smallint,
  is_owner_only boolean,
  is_capital boolean
)
LANGUAGE sql
IMMUTABLE
AS $$
  VALUES
    ('Maintenance',           1::smallint, false, false),
    ('Water',                 2::smallint, false, false),
    ('Electricity',           3::smallint, false, false),
    ('Housekeeping',          4::smallint, false, false),
    ('Security',              5::smallint, false, false),
    ('Lift',                  6::smallint, false, false),
    ('Gardening',             7::smallint, false, false),
    ('Plumbing',              8::smallint, false, false),
    ('Electrical Repairs',    9::smallint, false, false),
    ('Painting',             10::smallint, false, false),
    ('Pest Control',         11::smallint, false, false),
    ('Generator/Diesel',     12::smallint, false, false),
    ('Festival & Events',    13::smallint, false, false),
    ('Legal & Professional', 14::smallint, false, false),
    ('Insurance',            15::smallint, false, false),
    ('Bank Charges',         16::smallint, false, false),
    ('Sinking Fund',         17::smallint, true,  true),
    ('Corpus Fund',          18::smallint, true,  true),
    ('Miscellaneous',        19::smallint, false, false);
$$;

COMMENT ON FUNCTION public.default_expense_categories() IS
  'The nineteen seeded expense categories with their flags (PRD §3.5.3), in display order. Read by seed_society() and by the backfill for pre-existing societies.';

REVOKE ALL ON FUNCTION public.default_expense_categories() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.seed_society()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  creator_name text;
  creator_email text;
  creator_phone text;
  creator_member uuid;
BEGIN
  -- DB defaults (PRD §3.2 step 3); the client's chosen values are applied
  -- immediately after, inside the same transaction, by society_create().
  INSERT INTO public.society_settings (society_id)
  VALUES (NEW.id)
  ON CONFLICT (society_id) DO NOTHING;

  SELECT
    COALESCE(NULLIF(btrim(p.full_name), ''), NULLIF(split_part(COALESCE(p.email, ''), '@', 1), '')),
    p.email,
    p.phone
    INTO creator_name, creator_email, creator_phone
    FROM public.profiles p
   WHERE p.id = NEW.created_by;

  -- `is_primary` is false — the value `20260925140000_fix_seed_society_primary.sql`
  -- corrected, and the reason that migration exists. The original body in
  -- `20260920130000_society_core.sql` said `true`, and every `society_create()` paid for
  -- it the moment `chk_members_primary_requires_apartment` landed. A
  -- `CREATE OR REPLACE FUNCTION` must be copied from the function's *latest* body;
  -- taking it from the migration that introduced the function is the mistake this note
  -- exists to prevent.
  INSERT INTO public.members (
    society_id, user_id, display_name, phone, email, role, status, occupancy, is_primary, joined_at
  )
  VALUES (
    NEW.id,
    NEW.created_by,
    left(COALESCE(creator_name, 'Admin'), 120),
    creator_phone,
    creator_email,
    'admin',
    'active',
    'owner_occupied',
    false,
    now()
  )
  ON CONFLICT (society_id, user_id) DO NOTHING;

  -- The creator's membership id, so the seeded categories carry a real author rather
  -- than a NULL one. Read back rather than assumed: the INSERT above is
  -- `DO NOTHING`-guarded, so the row may predate this call.
  SELECT m.id INTO creator_member
    FROM public.members m
   WHERE m.society_id = NEW.id
     AND m.user_id = NEW.created_by;

  INSERT INTO public.expense_categories (
    society_id, name, display_order, is_owner_only, is_capital, created_by
  )
  SELECT NEW.id, d.name, d.display_order, d.is_owner_only, d.is_capital, creator_member
    FROM public.default_expense_categories() d
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.seed_society() IS
  'Seeds society_settings, the creator''s active Admin membership and the nineteen default expense categories, in the creating transaction (PRD §3.2, §3.5.3). The creator holds no flat, so is_primary is false (chk_members_primary_requires_apartment).';

-- ─────────────────────────────────────────────────────────────────────────────
-- The expand step: societies that already exist (SAD §8.8)
-- ─────────────────────────────────────────────────────────────────────────────

-- The trigger above covers every society created from now on. It does not cover the
-- ones created before this migration — and for those, the expense feature is not merely
-- inconvenient but impossible: `expenses.category_id` is NOT NULL, so a society with no
-- categories cannot record an expense at all. SAD §8.8's expand→migrate→contract rule is
-- explicit that a new column or table is followed by a backfill in the same change, and
-- this is that backfill.
--
-- It is idempotent: the `NOT EXISTS` skips the names a society already has (and the
-- `ON CONFLICT DO NOTHING` beside it is the race-safe belt to that brace). Re-running the
-- migration cannot produce a second copy of the set. What it *can* do is re-add a name a
-- society deleted or renamed away, which is the intended direction — it fills gaps in a
-- set the society never had, and it does not touch a row that exists.
INSERT INTO public.expense_categories (
  society_id, name, display_order, is_owner_only, is_capital
)
SELECT s.id, d.name, d.display_order, d.is_owner_only, d.is_capital
  FROM public.societies s
  CROSS JOIN public.default_expense_categories() d
 WHERE NOT EXISTS (
   SELECT 1
     FROM public.expense_categories c
    WHERE c.society_id = s.id
      AND c.name = d.name
      AND c.deleted_at IS NULL
 )
ON CONFLICT DO NOTHING;
