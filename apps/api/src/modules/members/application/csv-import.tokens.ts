/**
 * Injection token for the bulk import's flat-reference reader (T048).
 *
 * The same token pattern `member.tokens.ts` records in full: the reader is an interface
 * in the application layer, satisfied by the structure module's `ApartmentRepository`
 * adapter, and bound here so `MembersModule` can import `StructureModule`'s *exported
 * token* without reaching into its internals. A separate token rather than reusing
 * `APARTMENT_REPOSITORY` directly keeps the members module's contract narrow — the
 * import asks one question ("which live flats exist?"), and binding the whole
 * apartment port would invite the member module to grow a second opinion about flats.
 */
export const IMPORT_FLAT_READER = Symbol("IMPORT_FLAT_READER");

/**
 * The invitation list the import's collision check reads, bound from the invitations
 * module's exported repository token. Optional at the edge: the use case answers
 * "no invitation check" when it is absent, so the wiring is explicit in one place.
 */
export const IMPORT_INVITATION_LIST = Symbol("IMPORT_INVITATION_LIST");
