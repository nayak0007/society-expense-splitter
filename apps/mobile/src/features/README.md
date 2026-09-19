# src/features

Vertical-slice feature modules — THE primary organising unit (SAD §4.2,
PRD §17). Each feature owns five sub-folders:

```
features/<feature>/
├── api/          # endpoint functions (typed, one per resource)
├── hooks/        # useXxx hooks (queries, mutations)
├── components/   # feature-private components
├── schemas/      # zod schemas (form + API boundary validation)
└── __tests__/    # colocated tests
```

Planned slices: auth, society, members, expenses, payments, maintenance,
complaints, notices, visitors, reports, notifications, ai, subscription, sync.

Hard rules (SAD §4.2): no cross-feature imports — shared code moves up to
`src/lib` or `packages/*` (enforced by ESLint `no-restricted-imports`); no
barrel `index.ts` re-exporting the folder.
