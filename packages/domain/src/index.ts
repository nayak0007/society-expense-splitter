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
 *  - `payment/`  — the Payments module: T067's `dues-calculator` (the PRD §3.5
 *                 outstanding formula and the balance projection the publishing
 *                 transaction expresses in SQL). Payments, allocation and
 *                 statements arrive with T079+.
 *  - `attachment/` — the Attachments module (T071): the value rules that decide
 *                 what a bill may be (per-type caps, the MIME→extension map, the
 *                 SAD §10.3 key layout, the SHA-256 shape), the magic-number
 *                 sniffer that judges stored bytes rather than filenames, and the
 *                 two ports — the S3-compatible `StorageProvider` and the
 *                 `AttachmentRepository`.
 *  - `expense/`  — the Expenses module (T061–T063): the Expense aggregate, its
 *                 lifecycle state machine and the split-total invariant, the
 *                 `ExpenseSplit` value object and the two domain events; the
 *                 `ExpenseCategory` entity with its value objects, capability rules
 *                 and repository port; and (T063) the participant selector with the
 *                 pure resolution core — which flats a selector bills, who each
 *                 charge is addressed to, and owner-only routing. It owns no
 *                 persistence and no split calculation; `@ses/split-engine` depends
 *                 on this package, never the reverse.
 *
 * Use cases are deliberately NOT here. They are the application layer
 * (`@ses/application`), which depends on this package and never the other way
 * round; keeping them here would make "domain" mean two layers (SAD §3.1).
 */

export * from "./shared/clock";
export * from "./shared/errors";
export * from "./shared/gstin.vo";
export * from "./shared/ids";
export * from "./shared/idempotency";
export * from "./shared/money";
export * from "./shared/money.vo";
export * from "./shared/payment-sources";
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
export * from "./attachment/attachment";
export * from "./attachment/errors";
export * from "./attachment/magic-bytes";
export * from "./attachment/ports";
export * from "./attachment/serving-gate";
export * from "./invitation/errors";
export * from "./invitation/invitation";
export * from "./invitation/ports";
export * from "./expense/category-value-objects";
export * from "./expense/comment";
export * from "./expense/errors";
export * from "./expense/gst-details";
export * from "./expense/events";
export * from "./expense/expense-category";
export * from "./expense/expense-split.vo";
export * from "./expense/expense.entity";
export * from "./expense/participant-resolution";
export * from "./expense/participant-selector";
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
export * from "./payment/dues-calculator";
