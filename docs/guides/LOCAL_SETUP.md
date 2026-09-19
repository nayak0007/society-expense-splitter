# Local Setup

> Status: stub — expanded in Roadmap T007 (Docker Compose local stack: Postgres,
> Redis, MinIO). The steps below are sufficient for the mobile-only workflow.

## Prerequisites

- Node ≥ 24.16.0 (`.nvmrc`)
- pnpm ≥ 11 (`corepack enable`)
- Docker Desktop (only needed once local infra lands)

## Mobile app

```bash
corepack enable
pnpm install
cp apps/mobile/.env.example apps/mobile/.env
pnpm --filter @ses/mobile dev
```

Open the Expo Go app / dev client, or press `a` (Android) / `i` (iOS).

## Quality gates

```bash
pnpm lint && pnpm typecheck && pnpm test
```

## Git hooks

Installed automatically by `pnpm install` (husky `prepare` script):

- `pre-commit`: lint-staged (eslint --fix + prettier on staged files)
- `commit-msg`: commitlint (Conventional Commits — types and scopes in
  commitlint.config.js)

## API + local infrastructure

Not yet scaffolded (T006/T007). This section will document
`pnpm dev:infra`, seeded buckets, and the API env file.
