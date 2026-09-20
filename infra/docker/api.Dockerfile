# syntax=docker/dockerfile:1
#
# The API and the worker image — SAD §4.5 (`infra/docker/`), Roadmap T006.
#
# ## One Dockerfile, two targets
#
# The SAD's folder listing names `api.Dockerfile` and `worker.Dockerfile`. They
# are the same image with a different `CMD`: same base, same dependencies, same
# build. Two files would mean two dependency installs and two cache entries that
# drift, and a divergence between them would surface as a worker-only production
# bug. So there is one file with two final stages, and `docker-compose.dev.yml`
# selects one per service. `infra/docker/worker.Dockerfile` is deliberately absent.
#
# ## Why the build has stages at all
#
# A single-stage build would ship the Expo app's dependency tree (hundreds of
# megabytes of React Native) inside a Node API image, because pnpm's store lives
# at the workspace root. The final stage receives only the deployed API.
#
# ## `pnpm deploy`, not a hand-rolled copy
#
# `pnpm deploy --prod` produces a self-contained directory with the package's
# production dependency tree laid out normally. Two details are hard-won:
#
#   * `--legacy` is REQUIRED. From pnpm v10, deploy refuses a workspace without
#     `inject-workspace-packages=true`, which cannot be enabled here without
#     changing how Metro resolves symlinks in the mobile app. Without the flag the
#     build fails with ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE.
#   * `HUSKY=0` disables the root `prepare` script. `pnpm deploy` runs it, and
#     husky fails in an image that has no `.git` directory — a build failure with
#     nothing to do with the API.
#
# Verified on this machine before being written down: deploy produced a 91 MB tree
# that boots and serves. What could not be verified here is the container runtime
# itself — no Docker daemon is available in this environment — so the base image
# choice and the healthcheck are the parts to confirm in CI.

# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 — install, build, deploy
# ─────────────────────────────────────────────────────────────────────────────
FROM node:24.16.0-alpine AS build

# `corepack` ships with Node 24 and reads `packageManager` from the root
# package.json, so the pnpm version is pinned by the repository rather than by
# whatever happens to be in the image.
RUN corepack enable

WORKDIR /repo

# Manifests first, so a source-only change does not re-run the install.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/mobile/package.json apps/mobile/
COPY apps/api/package.json apps/api/
COPY packages/application/package.json packages/application/
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db-schema/package.json packages/db-schema/
COPY packages/domain/package.json packages/domain/
COPY packages/split-engine/package.json packages/split-engine/

# `--frozen-lockfile` on purpose: an image that resolves fresh versions is not a
# reproducible artefact, and a lockfile drift should fail the build loudly.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    HUSKY=0 pnpm install --frozen-lockfile

# Source last — the layer most likely to change, so it invalidates the least.
COPY . .

RUN HUSKY=0 pnpm --filter @ses/api build

# The deploy tree is the runtime artefact. `--prod` leaves devDependencies behind
# (Jest, the Nest CLI, rspack — none of which belong in a production image).
RUN HUSKY=0 pnpm --filter @ses/api deploy --prod --legacy /app

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 — runtime
# ─────────────────────────────────────────────────────────────────────────────
FROM node:24.16.0-alpine AS runtime

# The image sets NODE_ENV itself rather than inheriting it from the environment:
# it changes library behaviour (`postgres` pool defaults, Nest's error verbosity)
# and a deployment that forgot to set it would run production code in development
# mode. The schema defaults to `development` too, so this is the one place the
# value is decided.
ENV NODE_ENV=production
# Bind all interfaces — a container that listens on 127.0.0.1 is unreachable from
# outside, which is the single most common "the container starts but nothing
# responds" cause.
ENV HOST=0.0.0.0
ENV PORT=3000

WORKDIR /app

# `tini` reaps zombies and forwards signals. Without an init process, `node` is
# PID 1 and Node does not install signal handlers for SIGTERM by default, so
# `docker stop` waits out the full timeout and kills the process — skipping the
# graceful shutdown that drains in-flight requests (T006).
RUN apk add --no-cache tini

# Only what the runtime reads: the bundle, the dependency tree, the manifest.
# `src/`, `test/` and the tooling configs sit in the deploy tree but are copied
# out of it deliberately — shipping test fixtures and TypeScript sources into
# production widens the image for nothing.
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json

# Never root. A container process that escapes the application now has no
# privileges in the image, and this is what lets an orchestrator enforce
# `runAsNonRoot` (SAD §13.4 hardening).
USER node

EXPOSE 3000

# ─────────────────────────────────────────────────────────────────────────────
# Stage 3 — the API entrypoint
# ─────────────────────────────────────────────────────────────────────────────
FROM runtime AS api

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/v1/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]

# ─────────────────────────────────────────────────────────────────────────────
# Stage 4 — the worker entrypoint
# ─────────────────────────────────────────────────────────────────────────────
#
# No HEALTHCHECK: the worker serves no HTTP, and inventing a liveness signal for
# it would mean adding a port purely for the orchestrator. Its supervisor is the
# process itself — a crashed worker exits non-zero and is restarted.
FROM runtime AS worker

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/worker.js"]
