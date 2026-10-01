/**
 * `@ses/domain` — pure domain layer shared by the mobile app and the API.
 *
 * Zero runtime dependencies and no framework imports: this package must compile
 * unchanged for Hermes and for Node (Roadmap: "packages/domain may not import
 * @nestjs/*, drizzle-orm, react, or any provider SDK").
 *
 * Layout:
 *  - `shared/`  — primitives every module reuses: `Result`, `Clock`, `Paise`,
 *                 branded ids, the `DomainError` base;
 *  - `society/` — the Society module: entity, value objects, rules and the
 *                 repository port;
 *  - `structure/` — the Building module: entity, value objects, capability rules
 *                 and the repository port (wings and apartments land with
 *                 T043/T044).
 *  - `member/`  — the Members module: the membership entity (shadow members
 *                 included), value objects, capability and consent rules, the
 *                 repository port, and the role→action matrix the whole system
 *                 authorises against.
 *  - `invitation/` — the Invitations module (T047): the invitation aggregate, its
 *                 lifecycle rules and its repository/token ports. It reads the
 *                 member module's matrix for who may invite whom rather than
 *                 restating it.
 *  - `expense/`  — the Expenses module (T061, T062): the Expense aggregate, its
 *                 lifecycle state machine and the split-total invariant, the
 *                 `ExpenseSplit` value object and the two domain events; plus the
 *                 `ExpenseCategory` entity with its value objects, capability rules
 *                 and repository port. It owns no persistence and no split
 *                 calculation; `@ses/split-engine` depends on this package, never the
 *                 reverse.
 *
 * Use cases are deliberately NOT here. They are the application layer
 * (`@ses/application`), which depends on this package and never the other way
 * round; keeping them here would make "domain" mean two layers (SAD §3.1).
 */

export * from "./shared/clock";
export * from "./shared/errors";
export * from "./shared/ids";
export * from "./shared/money";
export * from "./shared/money.vo";
export * from "./shared/result";
export * from "./shared/split-vocabulary";

export * from "./society/society";
export * from "./society/join-code";
export * from "./society/errors";
export * from "./society/rules";
export * from "./society/ports";
export * from "./society/value-objects";
export * from "./structure/apartment";
export * from "./structure/apartment-patterns";
export * from "./structure/apartment-value-objects";
export * from "./structure/building";
export * from "./structure/errors";
export * from "./structure/rules";
export * from "./structure/ports";
export * from "./structure/value-objects";
export * from "./invitation/errors";
export * from "./invitation/invitation";
export * from "./invitation/ports";
export * from "./expense/category-value-objects";
export * from "./expense/errors";
export * from "./expense/events";
export * from "./expense/expense-category";
export * from "./expense/expense-split.vo";
export * from "./expense/expense.entity";
export * from "./expense/ports";
export * from "./expense/rules";
export * from "./member/csv-import";
export * from "./member/errors";
export * from "./member/join-requests";
export * from "./member/member";
export * from "./member/member-rules";
export * from "./member/member-value-objects";
export * from "./member/permission-evaluator";
export * from "./member/ports";
export * from "./member/resource-authorization";
export * from "./member/role-rules";
