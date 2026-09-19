# Society Expense Splitter

A modern Expo (React Native) application for managing apartment society expenses, maintenance, payments, complaints, visitors, and announcements.

## Project Status

🚧 Phase 1 — Project Setup & Foundations (pre-feature; no business functionality yet)

## Documentation

- [docs/PRD.md](docs/PRD.md) — product requirements (what & why)
- [docs/Architecture.md](docs/Architecture.md) — technical architecture (how; normative)
- [docs/Roadmap.md](docs/Roadmap.md) — phased implementation plan (T001–T015 for Phase 1)

## Tech Stack

- Expo (SDK 57) + React Native + Expo Router
- TypeScript (strict)
- Turborepo + pnpm workspace
- NestJS (Backend, Phase 1 T006+)
- PostgreSQL + Drizzle · Supabase
- Razorpay · MSG91 · Resend · Expo Push

## Folder Structure

```
society-expense-splitter/
├── apps/
│   ├── mobile/          # Expo app (Expo Router + NativeWind)
│   └── api/             # NestJS API + workers (scaffolded in T006)
├── packages/
│   ├── config/          # shared tsconfig / eslint / prettier / jest presets
│   ├── contracts/       # zod API contract (T010)
│   ├── domain/          # pure domain: Money, branded IDs, Result (T011–T012)
│   ├── split-engine/    # shared split calculation (Phase 4)
│   └── db-schema/       # Drizzle Postgres + SQLite schemas
├── docs/
└── scripts/             # dev/ops scripts (created per task)
```

Rules of the road (from docs/Architecture.md §4):

- `apps/mobile/app/` contains Expo Router routes only — thin wrappers.
- Feature code lives in vertical slices under `apps/mobile/src/features/<feature>/`.
- Shared business logic lives in `packages/*` so client and server cannot drift.
- No barrel `index.ts` re-exporting whole folders.

## Getting Started

Prerequisites: Node ≥ 24.16.0 (see `.nvmrc`), pnpm ≥ 11 (via Corepack), Docker (for local infra, T007+).

```bash
corepack enable
pnpm install
cp apps/mobile/.env.example apps/mobile/.env   # then fill values
pnpm dev                                       # or: pnpm --filter @ses/mobile dev
```

Quality gates (run from root):

```bash
pnpm lint        # ESLint (custom rules: no any, no raw hex in .tsx, no cycles)
pnpm typecheck   # tsc --noEmit across workspaces
pnpm test        # Jest across workspaces
pnpm format:check
```

Commits are enforced as Conventional Commits by commitlint on commit-msg; staged files are auto-formatted by lint-staged on pre-commit.

## Current Milestone

Phase 1 — Workspace bootstrapped (M01): monorepo, quality gates, mobile scaffold. See docs/Roadmap.md.
