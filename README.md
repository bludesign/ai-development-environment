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

## iOS device enrollment

The localized **Devices** area enrolls iPhones and iPads through Apple’s Profile Service flow. A user first opens the authenticated `/en/devices/enroll` page (or the equivalent locale), supplies a recognizable device label, consents to the disclosed collection, and installs a temporary profile. The profile requests only `UDID`, `PRODUCT`, and `VERSION`; iOS returns those values to a short-lived, token-authenticated callback. The server also records the IP address observed at profile download and response time.

Each enrollment token contains 256 bits of randomness, expires after 30 minutes, is stored only as a SHA-256 hash, and is consumed atomically. Identical iOS callback retries are idempotent; a different replay is rejected. Expired, unattached enrollments are retained for seven days before cleanup. Deleting a local device also deletes its enrollment and IP history, but does not remove the device from Apple’s annual registration list.

The first enrollment automatically creates a ten-year RSA-2048/SHA-256 self-signed profile signer. Its certificate, private key, device UDIDs, IP history, and any App Store Connect `.p8` key are stored in the configured SQLite database. They are intentionally excluded from ordinary logs and list views, but the database file must be treated as sensitive. A self-signed enrollment profile appears as **Unverified** in iOS; users should confirm the displayed organization before installation.

App Store Connect registration is optional. In Settings, provide an issuer ID, key ID, and ES256 PKCS#8 `.p8` key that has Certificates, Identifiers & Profiles access. Saving verifies the credentials against `GET /v1/devices?limit=1`. Registration first reconciles the UDID with Apple, then calls the Devices API only when needed. It does not regenerate a provisioning profile or rebuild an IPA; after adding a device, create a new provisioning profile and export a new IPA from **Builds**.

### Cloudflare Access paths

When the dashboard is behind Cloudflare Access, create narrowly scoped, more-specific Access applications for the following paths and attach a **Bypass / Everyone** policy. Configure paths without query strings because Access path matching does not support them.

| Access application path        | Route method  | Why it must bypass login                                                               |
| ------------------------------ | ------------- | -------------------------------------------------------------------------------------- |
| `/api/ios/enrollment-profile`  | `GET`         | Safari and the profile installation process retrieve the signed profile.               |
| `/api/ios/profile-response`    | `POST`        | iOS Settings posts the CMS-signed device response and cannot complete an Access login. |
| `/api/ios/enrollment-complete` | `GET`         | The validated callback redirects to this generic, script-free landing page.            |
| `/api/builds/*/artifacts/*`    | `GET`, `HEAD` | Apple’s manifest and package installer fetch artifacts outside the dashboard session.  |

Do **not** bypass `/en/devices*` (or another locale), `/api/ios/enrollment/start`, `/api/ios/devices/export.tsv`, or `/api/graphql`. Those remain behind Cloudflare Access. Access applications are path-scoped rather than method-scoped; the route handlers themselves expose only the methods listed above. Avoid JavaScript or CAPTCHA challenges on the callback. Add a WAF skip for the exact `/api/ios/profile-response` path only if production logs show that a managed rule blocks genuine iOS callbacks.

Cloudflare Tunnel keeps the origin private, so IP observations trust headers in this order: a valid `CF-Connecting-IP`, the first valid `X-Forwarded-For` entry, then `X-Real-IP`. The selected header source is saved with every observation. In direct mode this same behavior assumes the existing trusted localhost/LAN deployment boundary; do not expose an unprotected origin to untrusted networks.

Without Cloudflare, enrollment works behind any reverse proxy that provides publicly trusted HTTPS and correct `X-Forwarded-Proto`/`X-Forwarded-Host` values, or when `PUBLIC_BASE_URL` specifies the public HTTPS origin. Direct HTTP localhost/LAN dashboard access remains available, but the enrollment form and profile download are disabled because iOS requires a trusted HTTPS callback.

## Codebase REST and MCP APIs

Read-only codebase data is also available through REST and the Model Context Protocol:

- `GET /api/codebases` lists registered codebase checkouts.
- `GET /api/codebases/by-path?path=/absolute/folder` resolves one checkout by its exact path.
- `GET /api/openapi.json` serves the OpenAPI 3.1 contract for both REST operations.
- `/api/mcp` is a stateless Streamable HTTP MCP endpoint exposing `get_codebases` and `get_codebase`.

The localized `/en/tools` page discovers and runs these built-in tools. It can also manage and test external Streamable HTTP or legacy SSE MCP servers; saved custom header values remain server-side and are never returned to the browser.

## Database (Prisma)

Data access uses [Prisma 7](https://www.prisma.io/) with the `prisma-client` generator (TypeScript query compiler, no native query-engine binary) and the better-sqlite3 driver adapter. It defaults to a SQLite file at `prisma/dev.db`; set `DATABASE_URL` to another `file:` URL to change its location. Other database URL schemes are rejected. Migrations are versioned in `prisma/migrations/` and applied with `prisma migrate deploy`.

## Credential storage

Long-lived Jira, GitHub, cache-server, external MCP, iOS-signing, App Store Connect, and APNs credentials go through a server-only credential service. `/en/credentials` shows the selected backend, protection warnings, and item metadata; it never returns secret values, ciphertext, authentication headers, or secret-derived previews.

`CREDENTIAL_STORAGE_TYPE` selects one of three backends:

- `database` (the npm, Linux, Docker, and source-install default) stores payloads in the SQLite `Credential` table. Without `CREDENTIAL_ENCRYPTION_KEY`, new payloads are plaintext and Settings/Credentials show a warning. Generate a key with `openssl rand -base64 32`, set the resulting strict base64 value, and restart. The key must decode to exactly 32 bytes. Adding a valid key encrypts every existing plaintext credential atomically with AES-256-GCM. Back up and retain the key: a missing, invalid, or changed key blocks credential reads and writes whenever encrypted rows exist, and key rotation is not yet supported.
- `vault` uses HashiCorp Vault KV v2. Set `VAULT_ADDR`; optionally set `VAULT_TOKEN`, `VAULT_NAMESPACE`, `CREDENTIAL_VAULT_MOUNT` (default `secret`), `CREDENTIAL_VAULT_PATH_PREFIX` (default `ai-development-environment/credentials`), and `CREDENTIAL_VAULT_HEADERS`. The latter must be a JSON object of string values and should be shell-quoted, for example `CREDENTIAL_VAULT_HEADERS='{"X-Vault-AWS-IAM-Server-ID":"vault.example.com"}'`. Custom headers cannot override transport-managed headers or conflict with `VAULT_TOKEN`/`VAULT_NAMESPACE`. TLS options are `VAULT_CACERT`, `VAULT_TLS_SERVER_NAME`, and `VAULT_SKIP_VERIFY`. Plaintext HTTP and disabled certificate verification are supported but produce prominent security warnings.
- `keychain` uses the native macOS login Keychain service `com.bludesign.ai-development-environment.credentials`. It is loaded only on Darwin. Selecting it on Linux or in a container leaves the app running and reports an unsupported-backend error; credential-dependent operations fail with an actionable message. Run Homebrew services without `sudo`, because a root service uses a different or unavailable Keychain and may trigger authorization problems.

Vault needs data read/write access and permanent metadata deletion, but never `LIST` access. For the default mount and prefix, a minimal policy is:

```hcl
path "secret/data/ai-development-environment/credentials/*" {
  capabilities = ["create", "read", "update"]
}

path "secret/metadata/ai-development-environment/credentials/*" {
  capabilities = ["delete"]
}
```

Each metadata row records the backend that received its payload. Changing `CREDENTIAL_STORAGE_TYPE` does not migrate, read, or delete values from the previous backend: mismatched items are reported and must be re-entered through their owning settings forms. Backend-to-backend migration and key rotation are intentionally unsupported. Vault/Keychain outages do not take down the dashboard; only features that need an unavailable credential fail.

## Homebrew

The Homebrew formula is maintained in [`bludesign/homebrew-ai-development-environment`](https://github.com/bludesign/homebrew-ai-development-environment).

```bash
brew tap bludesign/ai-development-environment
brew install ai-development-environment
brew services start ai-development-environment
```

The service listens on `http://127.0.0.1:3090` by default, with agent GraphQL WebSockets on `ws://127.0.0.1:3091/graphql`. It applies pending database migrations on start, stores its SQLite database under Homebrew's `var/ai-development-environment/`, and defaults credential storage to macOS Keychain. Settings — including every credential/Vault variable — live in the owner-only `$(brew --prefix)/etc/ai-development-environment.env`, and logs are in `$(brew --prefix)/var/log/`.

## npm

The server and the agent are also published to npm as [`@ai-development-environment/server`](https://www.npmjs.com/package/@ai-development-environment/server) (a prebuilt standalone build) and [`@ai-development-environment/control-agent`](https://www.npmjs.com/package/@ai-development-environment/control-agent):

```bash
npm install -g @ai-development-environment/server @ai-development-environment/control-agent
ai-development-environment
```

The `ai-development-environment` command applies pending database migrations, then starts the server on `http://127.0.0.1:3090` with agent GraphQL WebSockets on `ws://127.0.0.1:3091/graphql`, storing its SQLite database at `~/.ai-development-environment/production.db`. It accepts the same server and credential-storage variables as the Homebrew service, but defaults to database credential storage on every platform.

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
