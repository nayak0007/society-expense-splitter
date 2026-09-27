/**
 * Injection token for `StructureMembershipReader` (`@ses/domain`).
 *
 * ## Why the token lives in `common/` and the implementation does not
 *
 * The interface is a domain port consumed by the building module (T042), and it
 * is satisfied by the **societies** module's Postgres repository — that is where a
 * `members` row becomes a `SocietyMembership`, and a second translation of that
 * row would be a third copy of the role/status/occupancy navigation tables.
 *
 * That arrangement makes the token cross-module wiring: the provider is declared
 * in `SocietiesModule` and injected in `StructureModule`. If the token lived in
 * the societies module, the building module would be importing another feature's
 * *internals* to ask for it. In `common/` it is shared vocabulary instead — which
 * is also why `common-is-foundation-only` in `.dependency-cruiser.js` still holds:
 * this file depends on nothing.
 *
 * A string rather than a `Symbol`, matching `SOCIETY_AUTHORIZATION_READER`, so a
 * stack trace naming an unresolved dependency is readable.
 */
export const MEMBERSHIP_READER = "MEMBERSHIP_READER";
