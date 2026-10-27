# @ai-development-environment/server

Prebuilt Next.js standalone server for the [AI Development Environment](https://github.com/bludesign/ai-development-environment).

## Install

```bash
npm install -g @ai-development-environment/server
```

Requires Node.js 24 (`>=24.16.0 <25`).

## Run

```bash
export APP_SECRET="$(openssl rand -base64 32)"
export APP_ORIGINS="http://127.0.0.1:3090"
ai-development-environment
```

The command applies pending database migrations, then starts the server on `http://127.0.0.1:3090` with agent GraphQL WebSockets on `ws://127.0.0.1:3091/graphql`. The SQLite database is stored at `~/.ai-development-environment/production.db` by default.

## Configuration

Override with environment variables:

| Variable                       | Default                                                                                 |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| `HOSTNAME`                     | `127.0.0.1`                                                                             |
| `PORT`                         | `3090`                                                                                  |
| `AGENT_WS_HOSTNAME`            | `127.0.0.1`                                                                             |
| `AGENT_WS_PORT`                | `3091`                                                                                  |
| `DATABASE_URL`                 | `file:~/.ai-development-environment/production.db`                                      |
| `APP_SECRET`                   | Required except for automatic macOS Keychain storage; base64 or hex of exactly 32 bytes |
| `APP_SECRET_PREVIOUS`          | unset; set only while rotating `APP_SECRET`                                             |
| `APP_ORIGINS`                  | unset; inferred from each request's host                                                |
| `TRUST_PROXY_HEADERS`          | `false`                                                                                 |
| `MCP_OAUTH_ENABLED`            | `false`                                                                                 |
| `MCP_OAUTH_DCR_ENABLED`        | `false`                                                                                 |
| `AUTH_MODE`                    | `password`                                                                              |
| `CREDENTIAL_STORAGE_TYPE`      | `database`                                                                              |
| `VAULT_ADDR`                   | required for Vault                                                                      |
| `VAULT_TOKEN`                  | unset                                                                                   |
| `VAULT_NAMESPACE`              | unset                                                                                   |
| `CREDENTIAL_VAULT_MOUNT`       | `secret`                                                                                |
| `CREDENTIAL_VAULT_PATH_PREFIX` | `ai-development-environment/credentials`                                                |
| `CREDENTIAL_VAULT_HEADERS`     | `{}`                                                                                    |
| `VAULT_CACERT`                 | unset                                                                                   |
| `VAULT_TLS_SERVER_NAME`        | unset                                                                                   |
| `VAULT_SKIP_VERIFY`            | `false`                                                                                 |
| `CREDENTIAL_VAULT_READ_ONLY`   | `false`                                                                                 |

Only SQLite `file:` URLs are supported for `DATABASE_URL`.

For database or Vault storage, generate `APP_SECRET` once with `openssl rand -base64 32`, back it up, and keep it stable across upgrades. It must be base64 or hex encoding of exactly 32 random bytes — a passphrase is rejected, because session signing, database credential encryption, and install-link signing are all derived from it. Changing it signs everyone out and invalidates outstanding install links. For database credentials, pass the old value as `APP_SECRET_PREVIOUS` to re-encrypt them on the next start; remove it once the server has started cleanly. Keychain and Vault credentials do not depend on this secret.

On macOS with `CREDENTIAL_STORAGE_TYPE=keychain`, leave `APP_SECRET` unset or blank to use automatic storage. Before starting services, the server reads service `com.bludesign.ai-development-environment.app-secret`, account `APP_SECRET`, from your login Keychain. If the entry is absent, it generates and persists a 32-byte secret. Every server installation under the same macOS account shares it across restarts and upgrades. An explicit environment value always takes precedence, must still be valid, and is never copied into Keychain. No secret is written to an environment file. The Homebrew formula already selects Keychain storage; npm and source installs must select it explicitly.

Back up the Keychain entry. Removing an environment override switches to the stored or newly generated Keychain root and can invalidate existing sessions and signed links. A locked, inaccessible, or malformed entry stops startup instead of replacing the secret: unlock your login Keychain and grant access, restore the original entry, or supply `APP_SECRET` explicitly. Initialization uses a temporary lock under `~/.ai-development-environment/`; concurrent starts wait up to 30 seconds, and abandoned locks expire automatically. If the lock cannot be acquired, check directory permissions and retry. Builds never access Keychain. Automatic storage is available only on macOS.

`APP_ORIGINS` is the optional comma-separated list of origins this server is reached at. Localhost is always trusted outside production. Leaving both it and `PUBLIC_BASE_URL` unset makes the server trust each request's own `Host`, which means the absolute URLs it generates follow whatever host the caller asked for.

The first account to register claims the instance and closes public registration. Every account then has identical, complete authority: any signed-in user can create and delete accounts, set anyone's password, revoke sessions, and issue API keys. There are no roles.

`AUTH_MODE` accepts `password`, `oidc`, or `both`. OIDC modes require a generic provider client ID and secret plus either a discovery URL or a complete authorization, token, and user-info endpoint set. See the [authentication documentation](https://ai-development-environment.mintlify.app/reference/authentication) for the complete `AUTH_OAUTH_*` variable list and redirect URL.

Incoming MCP OAuth is independent of `AUTH_MODE` and disabled by default. Set a canonical HTTPS `PUBLIC_BASE_URL` (or an exact `APP_ORIGINS`), deploy migrations, then set `MCP_OAUTH_ENABLED=true`. CIMD identifies clients by default; enable `MCP_OAUTH_DCR_ENABLED=true` only for older clients that require dynamic registration. OAuth access is limited to `/api/mcp`, with separate read, write, and destructive consent. Manage revocation in **Settings → Connected Applications**. Existing sessions, API keys, and enrolled agents continue working. See the [MCP OAuth setup and rollout guide](https://ai-development-environment.mintlify.app/reference/mcp-oauth).

### Credential backends

`CREDENTIAL_STORAGE_TYPE` accepts `database`, `vault`, or `keychain`. Database is the default on npm, Linux, and Docker. Database secrets are always encrypted with a key derived from `APP_SECRET`; there is no plaintext mode and no separate encryption key to configure. Rows written before encryption became unconditional are encrypted at the next start. Rotation is supported: set the old root as `APP_SECRET_PREVIOUS` and stored credentials are re-encrypted on start. Vault and Keychain storage do not use the derived key at all.

Vault supports KV v2 only. Quote custom-header JSON as one shell value, for example `CREDENTIAL_VAULT_HEADERS='{"X-Vault-AWS-IAM-Server-ID":"vault.example.com"}'`. Standard token/namespace variables cannot conflict with equivalent custom headers. `VAULT_CACERT` must be readable by the server process. Plaintext Vault HTTP and `VAULT_SKIP_VERIFY=true` work but display prominent interception warnings. The default-prefix policy is:

```hcl
path "secret/data/ai-development-environment/credentials/*" {
  capabilities = ["create", "read", "update"]
}
path "secret/metadata/ai-development-environment/credentials/*" {
  capabilities = ["list", "delete"]
}
```

`list` is optional. With it, a server discovers every credential under the prefix, including per-server MCP header bundles and APNs certificates; without it, discovery still covers each credential stored at a fixed path.

### Reusing an existing Vault on a new install

A server pointed at a Vault that already holds credentials adopts them when it starts: it reads what is stored under the configured mount and prefix and rebuilds the local metadata rows describing it. Nothing needs to be re-entered, and the Credentials page reports how many items were adopted. A credential this install recorded under an earlier backend is adopted the same way, because the configured backend is the only one a read can reach: once Vault is confirmed to hold that secret, the local row is repointed at Vault and the superseded database copy is dropped from it. Only secrets live in Vault—non-secret settings such as the Jira site URL or GitHub App ID are still entered per install. Point two installs at the same mount and prefix and they share one set of secrets, with no coordination between them; a write from either is immediately visible to the other.

Because the Vault token is the only thing gating this, treat it as the credential: anyone who can point a new install at the Vault gets a working install.

### Read-only Vault installs

`CREDENTIAL_VAULT_READ_ONLY=true` declares that an install must never write to Vault. Secret fields become read-only across the settings forms, and credential writes and deletions are refused before any request is sent; non-secret settings stay editable. The setting applies only when `CREDENTIAL_STORAGE_TYPE=vault`—database and keychain storage ignore it and report a warning on the Credentials page. A token that simply lacks write capabilities does not need the flag: Vault's denial is reported as the same read-only error rather than a bare HTTP 403. A read-only install needs:

```hcl
path "secret/data/ai-development-environment/credentials/*" {
  capabilities = ["read"]
}
path "secret/metadata/ai-development-environment/credentials/*" {
  capabilities = ["read", "list"]
}
```

macOS Keychain is dynamically loaded only on Darwin; selecting it on Linux or in Docker reports an error without crashing the app. Do not run a Keychain-backed service as root. Switching storage backends never copies a value into the new backend. Switching to Vault, whose contents the server can read back, keeps working for every secret Vault already holds; anything the configured backend does not hold is reported as a mismatch on the Credentials page and must be re-entered through its owning settings form. External-backend outages affect only credential-dependent features.

## See also

- [`@ai-development-environment/control-agent`](https://www.npmjs.com/package/@ai-development-environment/control-agent) — the control agent for managed machines.
- The [Homebrew tap](https://github.com/bludesign/homebrew-ai-development-environment) — alternative install that runs the server as a `brew services` daemon.
