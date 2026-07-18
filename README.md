# AI Development Environment

A Next.js application for an AI-focused development environment.

## Development

Install Node.js 24.16 or newer in the Node 24 release line, then install dependencies:

```bash
npm ci
```

Common commands:

- `npm run dev:all` starts the development server and a watch-mode local agent.
- `npm run dev` starts only the development server.
- `npm run agent:dev` starts only the watch-mode development agent and waits for the local server.
- `npm run full-check` formats and fixes the project before checking it.
- `npm run full-check:ci` runs the non-mutating CI checks.
- `npm run check-translations` verifies that locale files have matching keys, do not contain strings copied unchanged across every language, and match the unit-test mock.
- `npm run build` creates a deployable standalone build.
- `npm run start` starts the standalone production server.
- `npm run generate` regenerates the Prisma client, bundled GraphQL SDL, and resolver types.
- `npm run db:migrate` creates and applies a development migration; `npm run db:deploy` applies committed migrations; `npm run db:studio` opens Prisma Studio.

Copy `.env.example` to `.env` to configure `DATABASE_URL`. The production server accepts the standard Next.js `HOSTNAME` and `PORT` environment variables plus `DATABASE_URL`.

### One-command agent development

Start the complete local environment with:

```bash
npm run dev:all
```

Next.js runs on `http://127.0.0.1:3000` and the development GraphQL WebSocket runs on port `3092`, so an installed Homebrew service can continue using ports `3090` and `3091`. The agent waits for Next.js, then automatically enrolls `<hostname>-dev` on its first run. Later runs reuse the stable identity stored at:

```text
~/.config/control-agent-dev/config.json
```

Next.js retains hot reload and agent source changes restart only the development agent. Open `http://127.0.0.1:3000/en/agents` to inspect it. `cloudflared` must still be installed before running Cloudflared jobs.

The common overrides are:

```bash
PORT=3010 \
AGENT_WS_PORT=3093 \
NEXT_PUBLIC_AGENT_WS_URL=ws://127.0.0.1:3093/graphql \
npm run dev:all
```

For agent-only development, `CONTROL_AGENT_DEV_SERVER`, `CONTROL_AGENT_DEV_WEBSOCKET_SERVER`, and `CONTROL_AGENT_DEV_CONFIG` override the local endpoints and dedicated credential path. Automatic development enrollment refuses non-loopback server addresses.

## GraphQL API

An Apollo Server (Federation subgraph) is mounted at `/api/graphql` through a Next.js route handler. Outside production — or when `APOLLO_SANDBOX=true` — introspection and the Apollo sandbox are enabled; open `/api/graphql` in a browser to explore the schema.

The SDL lives in `schemas/**/*.graphql` and is bundled into the app by `scripts/prebuild-schema.ts`; resolvers are dependency-injected factories under `src/graphql/resolvers/`. A placeholder `health` query verifies database connectivity — it returns `"ok"` when the database is reachable, otherwise `"degraded"`:

```graphql
{
  health
}
```

## Codebase REST and MCP APIs

Read-only codebase data is also available through REST and the Model Context Protocol:

- `GET /api/codebases` lists registered codebase checkouts.
- `GET /api/codebases/by-path?path=/absolute/folder` resolves one checkout by its exact path.
- `GET /api/openapi.json` serves the OpenAPI 3.1 contract for both REST operations.
- `/api/mcp` is a stateless Streamable HTTP MCP endpoint exposing `get_codebases` and `get_codebase`.

The localized `/en/tools` page discovers and runs these built-in tools. It can also manage and test external Streamable HTTP or legacy SSE MCP servers; saved custom header values remain server-side and are never returned to the browser.

## Database (Prisma)

Data access uses [Prisma 7](https://www.prisma.io/) with the `prisma-client` generator (TypeScript query compiler, no native query-engine binary) and the better-sqlite3 driver adapter. It defaults to a SQLite file at `prisma/dev.db`; set `DATABASE_URL` to another `file:` URL to change its location. Other database URL schemes are rejected. Migrations are versioned in `prisma/migrations/` and applied with `prisma migrate deploy`.

## Homebrew

The Homebrew formula is maintained in [`bludesign/homebrew-ai-development-environment`](https://github.com/bludesign/homebrew-ai-development-environment).

```bash
brew tap bludesign/ai-development-environment
brew install ai-development-environment
brew services start ai-development-environment
```

The service listens on `http://127.0.0.1:3090` by default, with agent GraphQL WebSockets on `ws://127.0.0.1:3091/graphql`. It applies pending database migrations on start and stores its SQLite database under Homebrew's `var/ai-development-environment/`. Settings — including `DATABASE_URL`, `AGENT_WS_HOSTNAME`, and `AGENT_WS_PORT` — live in `$(brew --prefix)/etc/ai-development-environment.env`, and logs are in `$(brew --prefix)/var/log/`.

## npm

The server and the agent are also published to npm as [`@ai-development-environment/server`](https://www.npmjs.com/package/@ai-development-environment/server) (a prebuilt standalone build) and [`@ai-development-environment/control-agent`](https://www.npmjs.com/package/@ai-development-environment/control-agent):

```bash
npm install -g @ai-development-environment/server @ai-development-environment/control-agent
ai-development-environment
```

The `ai-development-environment` command applies pending database migrations, then starts the server on `http://127.0.0.1:3090` with agent GraphQL WebSockets on `ws://127.0.0.1:3091/graphql`, storing its SQLite database at `~/.ai-development-environment/production.db`. It accepts the same `HOSTNAME`, `PORT`, `AGENT_WS_HOSTNAME`, `AGENT_WS_PORT`, and `DATABASE_URL` environment variables as the Homebrew service.

Unlike Homebrew, npm does not install `cloudflared`; install it separately (for example `brew install cloudflared`) before running Cloudflared jobs — `control-agent doctor` checks for it.

npm versions track the repository's `vX.Y.Z` release tags; the `publish-npm` job in `.github/workflows/release.yml` publishes both packages via npm trusted publishing on every release.

## Control agents

The generic TypeScript agent lives in `packages/control-agent`. It makes authenticated outbound HTTP and GraphQL WebSocket connections to the control plane; managed Macs do not expose a listening port. Agent identity and job history are durable, while subscriptions provide immediate delivery and live logs.

Install the agent from the tap:

```bash
brew install control-agent
```

Open the app's **Agents** page and create a one-time enrollment command, then run it on the target Mac. The server defaults to the same computer when omitted:

```bash
control-agent enroll \
  --server http://127.0.0.1:3090 \
  --enrollment-token <one-time-token>
brew services start control-agent
```

Useful diagnostics:

```bash
control-agent status
control-agent doctor
```

The credential and stable agent ID are stored at `~/.config/control-agent/config.json`. The first allow-listed job is `cloudflared.runTunnel`; there is no arbitrary shell execution surface.
