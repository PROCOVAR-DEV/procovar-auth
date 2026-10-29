# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=24-alpine

#######################################################################
# Base — shared by every stage so apk + workdir are cached once
#######################################################################
FROM node:${NODE_VERSION} AS base
RUN apk add --no-cache libc6-compat
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1


#######################################################################
# Deps — install with BuildKit cache mount (npm cache survives rebuilds)
#######################################################################
FROM base AS deps
COPY package.json package-lock.json* .npmrc* ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --legacy-peer-deps --no-audit --no-fund


#######################################################################
# Builder — Prisma generate + Next build (standalone output)
#######################################################################
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Cache mounts make incremental builds much faster:
#   - .next/cache  → Next/SWC compilation cache (skips re-compiling unchanged modules)
#   - node_modules/.cache → Babel/SWC/PostCSS sub-caches
RUN --mount=type=cache,target=/app/.next/cache,uid=0,gid=0 \
    --mount=type=cache,target=/app/node_modules/.cache,uid=0,gid=0 \
    npx prisma generate --config prisma.config.js \
 && NODE_OPTIONS="--max-old-space-size=4096" npm run build


#######################################################################
# Runner — minimal image: standalone bundle + Prisma CLI for migrations
#######################################################################
FROM base AS runner

ENV NODE_ENV=production \
    PORT=3500 \
    HOSTNAME=0.0.0.0

# tini = proper PID 1 (signal forwarding, zombie reaping)
RUN apk add --no-cache tini \
 && addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs \
 && mkdir -p /app/logs \
 && chown -R nextjs:nodejs /app

# Next.js standalone bundle (already includes only the prod deps it traces)
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static     ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public           ./public

# Prisma assets needed at boot for `migrate deploy`
COPY --from=builder --chown=nextjs:nodejs /app/prisma            ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/prisma.config.js  ./

# Seed scripts, and the sources they import.
#
# The seed is not a one-off: a new sucursal, a new application, a permission
# added to the catalog — all of them are "run the seed again". Without this the
# only way to do it was to copy files into a running container by hand, which is
# exactly the kind of step that gets done wrong at the worst moment.
#
# `tsx` and the TypeScript sources are already in the image (node_modules comes
# whole from the builder), so this only adds the source tree itself.
COPY --from=builder --chown=nextjs:nodejs /app/scripts        ./scripts
COPY --from=builder --chown=nextjs:nodejs /app/src            ./src
COPY --from=builder --chown=nextjs:nodejs /app/tsconfig.json  ./

# Full node_modules from the builder.
# Trade-off: bigger image (~500 MB more), but ZERO extra install step in the
# runner — every COPY hits BuildKit cache as long as deps don't change, so
# rebuilds are dominated by the Next.js build itself, not by Docker layers.
# This also guarantees Prisma CLI + every transitive dep (@prisma/dev,
# valibot, hono, etc.) is present at runtime for `migrate deploy`.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules      ./node_modules

COPY --chown=nextjs:nodejs docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

USER nextjs
EXPOSE 3500

ENTRYPOINT ["/sbin/tini", "--", "./docker-entrypoint.sh"]
