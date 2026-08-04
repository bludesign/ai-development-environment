# @ai-development-environment/server

Prebuilt Next.js standalone server for the [AI Development Environment](https://github.com/bludesign/ai-development-environment).

## Install

```bash
npm install -g @ai-development-environment/server
```

Requires Node.js 24 (`>=24.16.0 <25`).

## Run

```bash
BETTER_AUTH_SECRET="replace-with-at-least-32-random-characters" \
BETTER_AUTH_URL="http://127.0.0.1:3090" \
ai-development-environment
```

The command applies pending database migrations, then starts the server on `http://127.0.0.1:3090` with agent GraphQL WebSockets on `ws://127.0.0.1:3091/graphql`. The SQLite database is stored at `~/.ai-development-environment/production.db` by default.

## Configuration

Override with environment variables:

| Variable                       | Default                                            |
| ------------------------------ | -------------------------------------------------- |
| `HOSTNAME`                     | `127.0.0.1`                                        |
| `PORT`                         | `3090`                                             |
| `AGENT_WS_HOSTNAME`            | `127.0.0.1`                                        |
| `AGENT_WS_PORT`                | `3091`                                             |
| `DATABASE_URL`                 | `file:~/.ai-development-environment/production.db` |
| `BETTER_AUTH_SECRET`           | Required; at least 32 characters                   |
| `BETTER_AUTH_URL`              | Required; the public server origin                 |
| `AUTH_MODE`                    | `password`                                         |
| `CREDENTIAL_STORAGE_TYPE`      | `database`                                         |
| `CREDENTIAL_ENCRYPTION_KEY`    | unset                                              |
| `VAULT_ADDR`                   | required for Vault                                 |
| `VAULT_TOKEN`                  | unset                                              |
| `VAULT_NAMESPACE`              | unset                                              |
| `CREDENTIAL_VAULT_MOUNT`       | `secret`                                           |
| `CREDENTIAL_VAULT_PATH_PREFIX` | `ai-development-environment/credentials`           |
| `CREDENTIAL_VAULT_HEADERS`     | `{}`                                               |
| `VAULT_CACERT`                 | unset                                              |
| `VAULT_TLS_SERVER_NAME`        | unset                                              |
| `VAULT_SKIP_VERIFY`            | `false`                                            |
| `CREDENTIAL_VAULT_READ_ONLY`   | `false`                                            |

Only SQLite `file:` URLs are supported for `DATABASE_URL`.

Generate `BETTER_AUTH_SECRET` once, back it up, and keep it stable across upgrades. Changing it invalidates active sessions. `AUTH_MODE` accepts `password`, `oidc`, or `both`. OIDC modes require a generic provider client ID and secret plus either a discovery URL or a complete authorization, token, and user-info endpoint set. See the [authentication documentation](https://ai-development-environment.mintlify.app/reference/authentication) for the complete `AUTH_OAUTH_*` variable list and redirect URL.

### Credential backends

`CREDENTIAL_STORAGE_TYPE` accepts `database`, `vault`, or `keychain`. Database is the default on npm, Linux, and Docker. Database secrets remain plaintext—with warnings on Settings and Credentials—until `CREDENTIAL_ENCRYPTION_KEY` is set. Generate it once with `openssl rand -base64 32`; it must be strict base64 decoding to exactly 32 bytes. Restart after setting it, back it up securely, and retain it for the lifetime of encrypted rows. Losing/changing it blocks credential operations, and key rotation is not supported.

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

A server pointed at a Vault that already holds credentials adopts them when it starts: it reads what is stored under the configured mount and prefix and rebuilds the local metadata rows describing it. Nothing needs to be re-entered, and the Credentials page reports how many items were adopted. Only secrets live in Vault—non-secret settings such as the Jira site URL or GitHub App ID are still entered per install. Point two installs at the same mount and prefix and they share one set of secrets, with no coordination between them; a write from either is immediately visible to the other.

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

macOS Keychain is dynamically loaded only on Darwin; selecting it on Linux or in Docker reports an error without crashing the app. Do not run a Keychain-backed service as root. Switching storage backends does not migrate or delete existing values: re-enter mismatched credentials through their owning settings forms. External-backend outages affect only credential-dependent features.

## See also

- [`@ai-development-environment/control-agent`](https://www.npmjs.com/package/@ai-development-environment/control-agent) — the control agent for managed machines.
- The [Homebrew tap](https://github.com/bludesign/homebrew-ai-development-environment) — alternative install that runs the server as a `brew services` daemon.
