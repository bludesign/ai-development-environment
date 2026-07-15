# AI Development Environment

A Next.js application for an AI-focused development environment.

## Development

Install Node.js 24.16 or newer in the Node 24 release line, then install dependencies:

```bash
npm ci
```

Common commands:

- `npm run dev` starts the development server (runs code generation first).
- `npm run full-check` formats and fixes the project before checking it.
- `npm run full-check:ci` runs the non-mutating CI checks.
- `npm run build` creates a deployable standalone build.
- `npm run start` starts the standalone production server.
- `npm run generate` regenerates the Prisma client, bundled GraphQL SDL, and resolver types.
- `npm run db:migrate` creates and applies a development migration; `npm run db:deploy` applies committed migrations; `npm run db:studio` opens Prisma Studio.

Copy `.env.example` to `.env` to configure `DATABASE_URL`. The production server accepts the standard Next.js `HOSTNAME` and `PORT` environment variables plus `DATABASE_URL`.

## GraphQL API

An Apollo Server (Federation subgraph) is mounted at `/api/graphql` through a Next.js route handler. Outside production — or when `APOLLO_SANDBOX=true` — introspection and the Apollo sandbox are enabled; open `/api/graphql` in a browser to explore the schema.

The SDL lives in `schemas/**/*.graphql` and is bundled into the app by `scripts/prebuild-schema.ts`; resolvers are dependency-injected factories under `src/graphql/resolvers/`. A placeholder `health` query verifies database connectivity — it returns `"ok"` when the database is reachable, otherwise `"degraded"`:

```graphql
{
  health
}
```

## Database (Prisma)

Data access uses [Prisma 7](https://www.prisma.io/) with the `prisma-client` generator (TypeScript query compiler, no native query-engine binary) and the better-sqlite3 driver adapter. It defaults to a SQLite file at `prisma/dev.db`; set `DATABASE_URL` to another `file:` URL to change its location. Other database URL schemes are rejected. Migrations are versioned in `prisma/migrations/` and applied with `prisma migrate deploy`.

## Homebrew

The Homebrew formula is maintained in [`bludesign/homebrew-ai-development-environment`](https://github.com/bludesign/homebrew-ai-development-environment).

```bash
brew tap bludesign/ai-development-environment
brew install ai-development-environment
brew services start ai-development-environment
```

The service listens on `http://127.0.0.1:3090` by default, applies pending database migrations on start, and stores its SQLite database under Homebrew's `var/ai-development-environment/`. Settings — including `DATABASE_URL` — live in `$(brew --prefix)/etc/ai-development-environment.env`, and logs are in `$(brew --prefix)/var/log/`.
