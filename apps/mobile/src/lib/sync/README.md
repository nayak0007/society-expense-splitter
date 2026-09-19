# src/lib/sync

Outbox → API push, API → replica pull, conflict handling (SAD §4.2, §12):

- `outbox.ts` — mutation queue with idempotency keys
- `puller.ts` / `pusher.ts` — directional sync loops
- `conflicts.ts` — server-wins for money, documented merge rules otherwise
- `engine.ts` — orchestration + backoff

Every queued mutation carries an idempotency key. The outbox and the SQLite
replica land in Roadmap Phase 9; nothing is implemented yet.
