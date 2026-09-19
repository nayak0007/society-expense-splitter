# src/components/feedback

Offline/sync-aware feedback primitives (SAD §4.2): `Skeleton`, `ErrorState`,
`EmptyState`, `SyncChip`, `OfflineBanner`, `Toast`.

`OfflineBanner` reads the React Query online state wired in
`src/lib/api/query-network.ts`. These land with the first data screens.
