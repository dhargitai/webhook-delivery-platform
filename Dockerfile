# syntax=docker/dockerfile:1

# One image for every service of the repository; Compose picks the service
# with `command`. Node runs everything, in every stage. Bun is only the package
# manager: it is installed in the build stage to run `bun install`, and it is
# not in the final image.

# ---- build -----------------------------------------------------------------
FROM node:24-slim AS build
WORKDIR /app

# The version in bun.lock's lockfile format; installing it through npm keeps
# the base image Node's.
RUN npm install --global bun@1.4.3

# Manifests first, so dependencies are reinstalled only when one changes.
COPY package.json bun.lock ./
COPY libs/domain/package.json libs/domain/
COPY libs/core/package.json libs/core/
COPY libs/messaging/package.json libs/messaging/
COPY libs/observability/package.json libs/observability/
COPY libs/common/package.json libs/common/
COPY apps/api/package.json apps/api/
COPY apps/relay/package.json apps/relay/
COPY apps/dispatcher/package.json apps/dispatcher/
COPY apps/mock-receiver/package.json apps/mock-receiver/
COPY apps/ops/package.json apps/ops/
COPY apps/worker/package.json apps/worker/
RUN bun install --frozen-lockfile

COPY tsconfig.base.json tsconfig.json ./
COPY libs libs
COPY apps apps
COPY migrations migrations
# Builds every workspace in dependency order into its dist/ (nest build or tsc,
# both run by Node).
RUN bun run build

# Keep only what runs: drop the sources, then reinstall the dependencies
# without the dev ones.
RUN rm -rf apps/*/src apps/*/test libs/*/src \
 && rm -rf node_modules apps/*/node_modules libs/*/node_modules \
 && bun install --frozen-lockfile --production

# ---- runtime ---------------------------------------------------------------
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/libs ./libs
COPY --from=build --chown=node:node /app/apps ./apps
COPY --from=build --chown=node:node /app/migrations ./migrations

USER node
# Compose overrides this per service; the API is the default.
CMD ["node", "apps/api/dist/main.js"]
