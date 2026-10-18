#!/usr/bin/env bash
#
# Runs the mobile end-to-end journeys — Roadmap T035 / T077.
#
# Called by `.github/workflows/e2e.yml` *after* the app has been built and installed/launched
# on the device or simulator. It owns exactly two things the workflow should not repeat per
# platform: installing the Maestro CLI, and the split of the journeys.
#
# ## Why the journeys are run in two invocations
#
# Journey 1 creates an account, so it must type an address nothing has used before; journeys 2
# and 3 sign in as a **seeded** account, because they are about what happens after auth. One
# `MAESTRO_EMAIL` cannot be both, and a flow that switched accounts mid-run would be testing
# two things in one report. The derived address keeps the seeded account untouched and makes
# every re-run of journey 1 valid.
#
# ## Required environment
#
#   MAESTRO_EMAIL           seeded account for journeys 2-3
#   MAESTRO_PASSWORD        its password
#   MAESTRO_SIGNUP_EMAIL    catch-all inbox to derive journey 1's address from
#   MAESTRO_NAME            the name journey 1 types
#   MAESTRO_CATEGORY        a seeded category name
#   MAESTRO_TITLE           the expense title journey 3 creates
#   MAESTRO_AMOUNT          the amount journey 3 types, in rupees
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
flows="${root}/apps/mobile/.maestro"

for name in \
  MAESTRO_EMAIL \
  MAESTRO_PASSWORD \
  MAESTRO_SIGNUP_EMAIL \
  MAESTRO_NAME \
  MAESTRO_CATEGORY \
  MAESTRO_TITLE \
  MAESTRO_AMOUNT; do
  if [ -z "${!name:-}" ]; then
    echo "maestro: ${name} is not set — the journeys cannot run without it" >&2
    exit 2
  fi
done

if ! command -v maestro >/dev/null 2>&1; then
  curl -Ls "https://get.maestro.mobile.dev" | bash
  export PATH="${HOME}/.maestro/bin:${PATH}"
fi

# `+run-<id>` on the catch-all inbox: unique per run (so a re-run is a fresh sign-up) and
# still delivered to an inbox the project controls (so a confirmation link can be followed).
local_part="${MAESTRO_SIGNUP_EMAIL%@*}"
domain="${MAESTRO_SIGNUP_EMAIL#*@}"
signup_email="${local_part}+run-${GITHUB_RUN_ID:-local}@${domain}"

# The expense journey publishes a bill the API will not let anyone delete, so the run id goes
# into its title: the row a run created is identifiable in the ledger afterwards, and two runs
# cannot collide on the same title. Cleanup is by voiding that run's expense, not by editing the
# database (see docs/guides/MOBILE_E2E.md).
run_title="${MAESTRO_TITLE} — e2e ${GITHUB_RUN_ID:-local}"

common=(
  -e "MAESTRO_PASSWORD=${MAESTRO_PASSWORD}"
  -e "MAESTRO_NAME=${MAESTRO_NAME}"
  -e "MAESTRO_CATEGORY=${MAESTRO_CATEGORY}"
  -e "MAESTRO_TITLE=${run_title}"
  -e "MAESTRO_AMOUNT=${MAESTRO_AMOUNT}"
)

echo "maestro: journeys 2-3 as ${MAESTRO_EMAIL}"
maestro test \
  "${flows}/02-login-email.yaml" \
  "${flows}/03-expense-publish.yaml" \
  -e "MAESTRO_EMAIL=${MAESTRO_EMAIL}" \
  "${common[@]}"

echo "maestro: journey 1 as ${signup_email}"
maestro test "${flows}/01-signup.yaml" -e "MAESTRO_EMAIL=${signup_email}" "${common[@]}"
