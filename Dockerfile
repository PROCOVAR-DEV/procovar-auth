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

# Firma de las APK (docs/firma-de-apk.md): un JRE y las dos herramientas de Android, apksigner y zipalign.
#
#   · JRE: `openjdk21-jre-headless` de Alpine (lleva `keytool`, que usa el script de importación). Sin JDK, sin Android SDK.
#     Alpine no permite fijar la versión menor sin que el build se rompa el día que la retire: se fija la MAYOR (21).
#   · apksigner.jar y zipalign: build-tools 35.0.0, VERSIONADOS en `docker/firma-apk/` con su SHA256SUMS (se comprueba aquí:
#     un fichero tocado rompe el build). No se descargan de dl.google.com a propósito: el build no depende de un tercero
#     y la versión es siempre la misma.
#   · TRAMPA DE ALPINE: `zipalign` es un binario de glibc y esta imagen es musl. Funciona con `gcompat` (probado) más su
#     propia libc++ (docker/firma-apk/lib64). Si algún día deja de arrancar, `apksigner` seguiría firmando, pero las APK sin alinear
#     fallarían (la firma avisa con «herramienta_no_disponible»).
#   · Tamaño: el JRE añade unos 100-200 MB a la imagen. Es el coste de firmar dentro de Accesos (decisión de Jose, 29/10/2026).
RUN apk add --no-cache openjdk21-jre-headless gcompat
COPY docker/firma-apk /opt/firma-apk
RUN cd /opt/firma-apk \
 && sha256sum -c SHA256SUMS \
 && chmod 0755 zipalign \
 && printf '#!/bin/sh\nexec java -Xmx512m -jar /opt/firma-apk/apksigner.jar "$@"\n' > /usr/local/bin/apksigner \
 && printf '#!/bin/sh\nexec /opt/firma-apk/zipalign "$@"\n' > /usr/local/bin/zipalign \
 && chmod 0755 /usr/local/bin/apksigner /usr/local/bin/zipalign

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
