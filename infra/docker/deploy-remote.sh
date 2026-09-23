#!/usr/bin/env bash
#
# Remote side of `api-deploy.yml` — runs ON the target VM, piped over SSH
# (`ssh host bash -s < deploy-remote.sh`), never copied.
#
# Contract with the workflow: REGISTRY_IMAGE, TAG and the runtime variables are
# exported into the environment by the caller. The script pulls the tagged
# image, restarts the two containers, and reports success only when the new API
# answers its readiness probe — so a failed roll-over fails the workflow rather
# than leaving the VM silently running the old version.
#
# Why compose here: the VM runs `docker compose` with the deploy compose file
# (image = REGISTRY_IMAGE:TAG), which keeps the local dev compose
# (`docker-compose.dev.yml`) and the production shape visibly different
# rather than one file drifting between purposes.
set -euo pipefail

: "${REGISTRY_IMAGE:?REGISTRY_IMAGE is required}"
: "${TAG:?TAG is required}"
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${REDIS_URL:?REDIS_URL is required}"

echo "$REGISTRY_PASSWORD" | docker login ghcr.io -u "$REGISTRY_USERNAME" --password-stdin 2>/dev/null || true

# Pull before stopping anything, so a failed pull never takes the running
# version down with it.
docker pull "$REGISTRY_IMAGE:$TAG"

# The deploy compose file lives next to this script on the VM. If the VM has
# not been provisioned with it yet, fail loudly rather than half-deploying.
DEPLOY_DIR="${DEPLOY_DIR:-/opt/ses}"
COMPOSE_FILE="$DEPLOY_DIR/compose.yaml"
if [ ! -f "$COMPOSE_FILE" ]; then
  echo "FATAL: $COMPOSE_FILE not found on the VM." >&2
  echo "Provision the VM with the deploy compose file (see docs/guides/DEPLOYMENT.md) first." >&2
  exit 1
fi

echo "Rolling api + worker to $REGISTRY_IMAGE:$TAG…"
REGISTRY_IMAGE="$REGISTRY_IMAGE" TAG="$TAG" \
  docker compose -f "$COMPOSE_FILE" up -d --no-build api worker

# Readiness gate: the new container must answer /v1/health/ready before this
# reports success. Ready — not live: a process that starts but cannot reach its
# database must fail the deploy, not the probe timeout.
echo "Waiting for readiness…"
for i in $(seq 1 60); do
  if docker compose -f "$COMPOSE_FILE" exec -T api \
      node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/v1/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    echo "Deploy complete: $REGISTRY_IMAGE:$TAG is ready."
    exit 0
  fi
  sleep 5
done

echo "FATAL: new api container never became ready. Recent logs:" >&2
docker compose -f "$COMPOSE_FILE" logs --tail 50 api >&2
exit 1
