/**
 * The Invitations module's application layer (T047).
 *
 * Six operations, and the two that are not gated by a capability are the two worth noting:
 * `previewInvitation` and `acceptInvitation` are reached by somebody who is not a member yet, so the
 * **token** is the authority and the database's `invitation_accept()` is what validates it under a row
 * lock. Every other operation loads the caller's own membership first and asks for `member.invite`.
 */
export * from "./use-cases";
