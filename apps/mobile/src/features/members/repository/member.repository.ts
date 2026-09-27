import type { MemberRepository } from '@ses/domain';

import { ApiMemberRepository } from './member.repository.api';

/**
 * Members feature composition root — the one place that decides which implementation the
 * app uses.
 *
 * **The API is the only implementation, and there is deliberately no mock**, for the reason
 * `building.repository.ts` records: the member rules live in `@ses/application` and are
 * exercised by the API's own e2e suite, so a local fake would be a second implementation of
 * rules that already have one owner. The seam exists anyway — that importing this module
 * must not construct anything, and that a test or a preview can swap in a five-line stub
 * without module mocking:
 *
 *     setMemberRepository(fake);
 *
 * Resolved lazily rather than captured, so a repository is built after the session exists
 * rather than at import time.
 */
let memberRepository: MemberRepository | null = null;

export function getMemberRepository(): MemberRepository {
  memberRepository ??= new ApiMemberRepository();
  return memberRepository;
}

/** Test/tooling seam — inject a fake or a stub. */
export function setMemberRepository(repository: MemberRepository | null): void {
  memberRepository = repository;
}
