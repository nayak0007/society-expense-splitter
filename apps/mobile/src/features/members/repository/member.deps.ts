import type { MemberDeps } from '@ses/application';

import { getMemberRepository } from './member.repository';

/**
 * The dependency every member use case needs, resolved at call time.
 *
 * One port, because the member module owns the table it reads — the caller's own membership,
 * the target row and the duplicate-phone lookup are all reads of `members`. Compare
 * `structure.deps.ts`, whose third dependency exists because a building's removal rule asks
 * about another module's table.
 *
 * Resolved per call, never captured at import: the repository reads the session per request,
 * and a snapshot taken at import would be a session from before the user signed in.
 */
export function memberDeps(): MemberDeps {
  return { members: getMemberRepository() };
}
