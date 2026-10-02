import { Module } from "@nestjs/common";

import { DatabaseModule } from "../../infrastructure/database/database.module";
import { SOCIETY_REPOSITORY } from "../societies/application/society.tokens";
import { SocietiesModule } from "../societies/societies.module";
import { ExpenseCategoryOperations } from "./application/expense-category.operations";
import {
  EXPENSE_CATEGORY_REPOSITORY,
  EXPENSE_REFERENCE_READER,
} from "./application/expense-category.tokens";
import { ParticipantResolverService } from "./application/participant-resolver.service";
import {
  EXPENSE_PARTICIPANT_READER,
  EXPENSE_SOCIETY_READER,
} from "./application/participant.tokens";
import { ExpenseCategoryRepositoryPostgres } from "./infrastructure/category.repository";
import { ExpenseParticipantRepositoryPostgres } from "./infrastructure/participant.repository";
import { ExpenseCategoriesController } from "./presentation/categories.controller";

/**
 * The expenses feature module — Roadmap T062 (categories) and T063 (participant
 * resolution), with expense CRUD, publishing, previews and attachments still to come.
 *
 * ## The dependency direction is the module's whole content
 *
 * ```
 * controller ──▶ ExpenseCategoryOperations ──▶ ExpenseCategoryRepository  (port, @ses/domain)
 *                          │                  ExpenseReferenceReader      (port, @ses/domain)
 *                          │                              ▲
 *                          │                  ExpenseCategoryRepositoryPostgres
 *                          │                              │
 *                          │                              └─ reads `expenses` too,
 *                          │                                 until T065/T066's adapter lands
 *                          │
 *                          └──▶ MEMBERSHIP_READER ──▶ SocietyRepositoryPostgres
 *                                   (common/)              (SocietiesModule)
 *
 * (T063, no route yet)
 * ParticipantResolverService ──▶ ExpenseParticipantReader  (port, @ses/domain)
 *          │                              ▲
 *          │                  ExpenseParticipantRepositoryPostgres
 *          │                              └─ reads `apartments`, `members`, `wings`,
 *          │                                 `buildings` — a projection, never a write
 *          ├──▶ ExpenseCategoryRepository ─▶ the category's `is_owner_only`
 *          ├──▶ ExpenseSocietyReader ──────▶ SocietyRepositoryPostgres
 *          │        (port, @ses/domain)         (SocietiesModule, for `bill_vacant_flats`)
 *          └──▶ MEMBERSHIP_READER ────────▶ SocietyRepositoryPostgres
 * ```
 *
 * ## Why the resolver is a provider with no controller
 *
 * T063's row names this module and the service file, and **no route**: resolution is an
 * internal capability whose two real callers are T064's preview endpoint and T066's
 * publish path, neither of which exists yet. A controller here would be a route nobody
 * asked for, behind a permission nobody chose — so the module exposes the service and
 * the e2e suite proves the graph resolves, which is the property that matters until a
 * route needs it.
 *
 * The arrows point one way, and this file is where that is enforced rather than
 * described: the interface token is what the application layer binds to, so the adapter
 * can be swapped (the e2e suite swaps it for an in-memory fake) without any file above
 * `infrastructure/` knowing. Importing `ExpenseCategoryRepositoryPostgres` from the
 * application layer would compile perfectly and would quietly make the domain depend on
 * Drizzle — SAD §3.1's one rule, broken invisibly.
 *
 * ## Why two tokens, one instance
 *
 * `EXPENSE_CATEGORY_REPOSITORY` and `EXPENSE_REFERENCE_READER` are both provided by
 * `ExpenseCategoryRepositoryPostgres` through `useExisting`, which means they resolve to
 * the *same object* — one adapter, so a second copy of the reads cannot exist. They stay
 * two tokens because they are two ports with two owners-to-be: the reference reader is the
 * narrow read T065's expense repository will satisfy, and re-binding it then must not
 * mean changing anything in the application layer. See `expense-category.tokens.ts`.
 *
 * ## Why `SocietiesModule` is imported
 *
 * For exactly one provider: `MEMBERSHIP_READER`, the caller's role in the society — which
 * the capability evaluation needs and which is *not* an expenses concern. The
 * implementation stays in the society module because that is where a `members` row
 * becomes a `SocietyMembership`; a second translation here would be a third copy of the
 * role/status/occupancy navigation tables, and a drifted copy of that map is silent (a
 * role read as `admin` in one and `guest` in the other).
 *
 * This is the sanctioned direction for a cross-module dependency (SAD §1.2): the token is
 * shared vocabulary in `common/authorization/`, and `SocietiesModule` exports its
 * provider. Nothing reaches into the society module's internals — and this module needed
 * no change to that module to be wired, which is the property the earlier design bought.
 *
 * `MEMBERSHIP_READER` is not re-exported. The structure module exports its repositories
 * because the member module's CSV import consumes them; nothing consumes the category
 * repository, and exporting it "in case" would invite a second module to reach for a
 * category read instead of declaring the port it actually needs.
 *
 * ## Why `DatabaseModule` is imported explicitly
 *
 * Rather than reached for globally, following the reasoning that module records for
 * itself: the reader of this file should be able to see that this module writes to
 * Postgres.
 */
@Module({
  imports: [DatabaseModule, SocietiesModule],
  controllers: [ExpenseCategoriesController],
  providers: [
    ExpenseCategoryOperations,
    ExpenseCategoryRepositoryPostgres,
    {
      provide: EXPENSE_CATEGORY_REPOSITORY,
      useExisting: ExpenseCategoryRepositoryPostgres,
    },
    {
      provide: EXPENSE_REFERENCE_READER,
      useExisting: ExpenseCategoryRepositoryPostgres,
    },
    // T063's resolver, and the three reads it composes. One instance per token, so a
    // test that swaps the participant reader cannot leave a second, real one in the
    // graph — the same reason the two category tokens exist.
    ParticipantResolverService,
    ExpenseParticipantRepositoryPostgres,
    {
      provide: EXPENSE_PARTICIPANT_READER,
      useExisting: ExpenseParticipantRepositoryPostgres,
    },
    {
      provide: EXPENSE_SOCIETY_READER,
      // The society module's own repository, borrowed through its exported token:
      // `ExpenseSocietyReader` is a structural subset of `SocietyRepository`
      // (`findById`), so this module reads `bill_vacant_flats` without owning SQL over
      // a table that is not its own.
      useExisting: SOCIETY_REPOSITORY,
    },
  ],
})
export class ExpensesModule {}
