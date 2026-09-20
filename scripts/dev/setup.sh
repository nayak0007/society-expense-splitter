#!/usr/bin/env bash
#
# First-run developer setup — Roadmap T007.
#
#   bash scripts/dev/setup.sh
#
# Creates the `.env` files that `pnpm dev:infra` and the API need, without ever
# overwriting an existing one. Idempotent: running it twice is safe, and running it
# after editing `.env` leaves the edits alone.
#
# Why not have the developer `cp` the files by hand, as `LOCAL_SETUP.md` used to
# say: the API refuses to boot without `DATABASE_URL`, so the copy is not optional
# — and a step that is mandatory but manual is a step that gets skipped and then
# debugged. This is also the file that would grow the cookie-cutter work later
# (generating an encryption key, seeding a database), which is why it exists as a
# script rather than a line in a document.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

info() { printf '  %s\n' "$1"; }
warn() { printf '  ! %s\n' "$1" >&2; }

echo "Society Expense Splitter — local setup"
echo

# ── Environment files ────────────────────────────────────────────────────────
# `apps/api/.env` also feeds the compose API/worker services (see `env_file` in
# docker-compose.dev.yml), so this one file covers both loops.
seed_env() {
  local target="$1"
  local template="$2"

  if [ ! -f "$template" ]; then
    warn "missing template: $template (nothing to do)"
    return
  fi

  if [ -f "$target" ]; then
    info "kept existing $target"
    return
  fi

  cp "$template" "$target"
  info "created $target from $(basename "$template")"
}

echo "Environment:"
seed_env "apps/api/.env" "apps/api/.env.example"
seed_env "apps/mobile/.env" "apps/mobile/.env.example"

# ── Warnings worth acting on ─────────────────────────────────────────────────
echo
if [ -f apps/api/.env ] && grep -qE '^SUPABASE_URL=https://your-project\.supabase\.co' apps/api/.env; then
  warn "apps/api/.env still has the placeholder SUPABASE_URL — set it before using anything that verifies a token."
fi

if command -v docker >/dev/null 2>&1; then
  echo "Next:"
  echo "  pnpm dev:infra      # Postgres, Redis, MinIO"
  echo "  pnpm db:migrate     # apply Drizzle migrations once generated"
  echo "  pnpm --filter @ses/api dev"
else
  warn "docker is not installed — 'pnpm dev:infra' will not work. See docs/guides/LOCAL_SETUP.md."
fi

echo
echo "Done."
