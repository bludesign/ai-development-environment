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

| Variable            | Default                                            |
| ------------------- | -------------------------------------------------- |
| `HOSTNAME`          | `127.0.0.1`                                        |
| `PORT`              | `3090`                                             |
| `AGENT_WS_HOSTNAME` | `127.0.0.1`                                        |
| `AGENT_WS_PORT`     | `3091`                                             |
| `DATABASE_URL`      | `file:~/.ai-development-environment/production.db` |

Only SQLite `file:` URLs are supported for `DATABASE_URL`.

## See also

- [`@ai-development-environment/control-agent`](https://www.npmjs.com/package/@ai-development-environment/control-agent) — the control agent for managed machines.
- The [Homebrew tap](https://github.com/bludesign/homebrew-ai-development-environment) — alternative install that runs the server as a `brew services` daemon.
