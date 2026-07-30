# syntax=docker/dockerfile:1.7

FROM --platform=$BUILDPLATFORM node:24.18.0-bookworm-slim AS builder

ARG VERSION=0.0.0

ENV NEXT_TELEMETRY_DISABLED=1

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/agent-contract/package.json packages/agent-contract/package.json
COPY packages/control-agent/package.json packages/control-agent/package.json

RUN --mount=type=cache,target=/root/.npm npm ci

COPY . .

RUN npm run build \
    && node scripts/prepare-npm-server-package.mjs --version "$VERSION"

FROM node:24.18.0-bookworm-slim AS runtime-dependencies

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

WORKDIR /app

# Prisma probes libssl to choose a schema-engine build, and node:*-bookworm-slim ships
# without it, so the CLI warns and falls back to the openssl-1.1.x engine. libssl3 lets
# @prisma/engines resolve the correct debian-openssl-3.0.x engine during npm install.
# Debian security revisions intentionally follow the pinned base image.
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install --yes --no-install-recommends libssl3 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/.npm-staging/server ./

# The staged server manifest installs native modules for the target platform while keeping
# the Next.js build platform-independent. This makes one Dockerfile work for amd64 and arm64.
RUN --mount=type=cache,target=/root/.npm npm install --omit=dev --no-audit --no-fund

FROM node:24.18.0-bookworm-slim AS runner

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOME=/home/node \
    HOSTNAME=0.0.0.0 \
    PORT=3090 \
    AGENT_WS_HOSTNAME=0.0.0.0 \
    AGENT_WS_PORT=3091 \
    DATABASE_URL=file:/data/production.db

LABEL org.opencontainers.image.source="https://github.com/bludesign/ai-development-environment" \
      org.opencontainers.image.description="Self-hosted Next.js control plane for AI-assisted development across your Macs."

WORKDIR /app

# `bin/ai-development-environment.js` shells out to `prisma migrate deploy` on boot, which
# probes libssl again; without it the CLI warns and loads the wrong schema engine.
# Debian security revisions intentionally follow the pinned base image.
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install --yes --no-install-recommends libssl3 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=runtime-dependencies --chown=node:node /app ./
COPY --chmod=755 scripts/docker/entrypoint.sh /usr/local/bin/entrypoint.sh

RUN mkdir -p /data && chown node:node /data /home/node

# The entrypoint starts as root only to take ownership of a bind-mounted /data, then drops
# to `node` before exec'ing the command below. Pass `--user` to skip that and run as a
# caller-chosen identity instead.
VOLUME ["/data"]

EXPOSE 3090 3091

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/api/graphql',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:'{ health }'})}).then(async response=>{const body=await response.json();if(!response.ok||body.data?.health!=='ok')process.exit(1)}).catch(()=>process.exit(1))"]

STOPSIGNAL SIGTERM

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "bin/ai-development-environment.js"]
