# src/lib/db

Local SQLite replica + outbox (SAD §4.2, §12 Offline Architecture):

- `client.ts` — expo-sqlite + drizzle client
- `schema.ts` — re-exports the SQLite schema variant from `@ses/db-schema`
- `migrations/` — drizzle migrations for the on-device DB
- `queries/` — query functions used by React Query (`queryFn` side)

The local DB is a _replica with an outbox_, never the source of truth — the
server owns all financial state (SAD §1.1). Nothing is implemented yet; the
replica lands in Roadmap Phase 9.
