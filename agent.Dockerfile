# syntax=docker/dockerfile:1.7

FROM --platform=$BUILDPLATFORM node:24.18.0-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/agent-contract/package.json packages/agent-contract/package.json
COPY packages/control-agent/package.json packages/control-agent/package.json

RUN --mount=type=cache,target=/root/.npm npm ci

COPY packages/agent-contract packages/agent-contract
COPY packages/control-agent packages/control-agent

RUN npm run agent:build

FROM node:24.18.0-bookworm-slim AS runtime-dependencies

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/agent-contract/package.json packages/agent-contract/package.json
COPY packages/control-agent/package.json packages/control-agent/package.json

RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --workspace @ai-development-environment/control-agent --include-workspace-root=false

FROM node:24.18.0-bookworm-slim AS runner

ARG VERSION=0.0.0

ENV NODE_ENV=production \
    HOME=/home/node \
    SHELL=/bin/bash \
    PATH=/app/node_modules/.bin:$PATH \
    CONTROL_AGENT_CONFIG=/data/config.json \
    CONTROL_AGENT_VERSION=$VERSION

LABEL org.opencontainers.image.source="https://github.com/bludesign/ai-development-environment" \
      org.opencontainers.image.description="Containerized control agent for the AI Development Environment."

# Debian security revisions intentionally follow the pinned base image.
# hadolint ignore=DL3008
RUN --mount=type=cache,target=/root/.npm \
    apt-get update \
    && apt-get install --yes --no-install-recommends bash ca-certificates git openssh-client tini \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --no-audit --no-fund \
      opencode-ai@1.18.4

WORKDIR /app

COPY --from=runtime-dependencies /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/packages/control-agent/package.json ./package.json
COPY --from=builder --chown=node:node /app/packages/control-agent/dist ./dist

RUN mkdir -p /data /workspace \
    && chown node:node /data /workspace /home/node

USER node

VOLUME ["/data", "/home/node"]

WORKDIR /workspace

HEALTHCHECK --interval=30s --timeout=15s --start-period=15s --retries=3 \
  CMD ["node", "/app/dist/control-agent.js", "status"]

STOPSIGNAL SIGTERM

ENTRYPOINT ["tini", "--", "node", "/app/dist/control-agent.js"]
CMD ["run"]
