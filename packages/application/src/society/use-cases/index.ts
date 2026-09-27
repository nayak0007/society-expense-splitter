/**
 * Society use cases — one file per operation.
 *
 * Every one is a function of `(deps, actor, command)` returning a
 * `Result<Value, SocietyError>`. Nothing here imports a framework, touches the
 * network, reads the clock directly or constructs a repository: the port and the
 * clock arrive as arguments (`SocietyDeps`), which is what makes each of these
 * testable with a fake repository and a frozen clock, and reusable by both the
 * API and the mobile client.
 *
 * The five operations this layer is defined by are `createSociety`,
 * `updateSociety`, `deleteSociety`, `joinSociety` and `leaveSociety`. The others
 * are here because a screen needs them and they hold no rules of their own —
 * `listMemberships` and `listSocietyMemberships` included: they exist so the API
 * can expose the two reads the port already defined, rather than leaving a client
 * to reach past the port for them.
 */
export * from "./support";
export * from "./list-memberships";
export * from "./list-society-memberships";
export * from "./create-society";
export * from "./update-society";
export * from "./delete-society";
export * from "./regenerate-join-code";
export * from "./join-society";
export * from "./list-join-options";
export * from "./leave-society";
export * from "./get-society-profile";
export * from "./list-society-summaries";
export * from "./lookup-join-code";
