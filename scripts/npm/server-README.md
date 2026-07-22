# @ai-development-environment/server

Prebuilt Next.js standalone server for the [AI Development Environment](https://github.com/bludesign/ai-development-environment).

## Install

```bash
npm install -g @ai-development-environment/server
```

Requires Node.js 24 (`>=24.16.0 <25`).

## Run

```bash
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

Only SQLite `file:` URLs are supported for `DATABASE_URL`.

### Credential backends

`CREDENTIAL_STORAGE_TYPE` accepts `database`, `vault`, or `keychain`. Database is the default on npm, Linux, and Docker. Database secrets remain plaintext—with warnings on Settings and Credentials—until `CREDENTIAL_ENCRYPTION_KEY` is set. Generate it once with `openssl rand -base64 32`; it must be strict base64 decoding to exactly 32 bytes. Restart after setting it, back it up securely, and retain it for the lifetime of encrypted rows. Losing/changing it blocks credential operations, and key rotation is not supported.

Vault supports KV v2 only. Quote custom-header JSON as one shell value, for example `CREDENTIAL_VAULT_HEADERS='{"X-Vault-AWS-IAM-Server-ID":"vault.example.com"}'`. Standard token/namespace variables cannot conflict with equivalent custom headers. `VAULT_CACERT` must be readable by the server process. Plaintext Vault HTTP and `VAULT_SKIP_VERIFY=true` work but display prominent interception warnings. The default-prefix policy is:

```hcl
path "secret/data/ai-development-environment/credentials/*" {
  capabilities = ["create", "read", "update"]
}
path "secret/metadata/ai-development-environment/credentials/*" {
  capabilities = ["delete"]
}
```

No Vault `LIST` permission is needed. macOS Keychain is dynamically loaded only on Darwin; selecting it on Linux or in Docker reports an error without crashing the app. Do not run a Keychain-backed service as root. Switching storage backends does not migrate or delete existing values: re-enter mismatched credentials through their owning settings forms. External-backend outages affect only credential-dependent features.

## See also

- [`@ai-development-environment/control-agent`](https://www.npmjs.com/package/@ai-development-environment/control-agent) — the control agent for managed machines.
- The [Homebrew tap](https://github.com/bludesign/homebrew-ai-development-environment) — alternative install that runs the server as a `brew services` daemon.
