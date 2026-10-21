# @ai-development-environment/control-agent

Control agent for the [AI Development Environment](https://github.com/bludesign/ai-development-environment). It makes authenticated outbound HTTP and GraphQL WebSocket connections to the control plane; managed machines do not expose a listening port.

## Install

```bash
npm install -g @ai-development-environment/control-agent
```

Requires Node.js 24 (`>=24.16.0 <25`). Saved commands use the agent user's login shell and require no additional runtime.

## Usage

Open the server's **Agents** page and create a one-time enrollment command, then run it on the target machine (the server defaults to the same computer when omitted):

```bash
control-agent enroll \
  --server http://127.0.0.1:3090 \
  --enrollment-token <one-time-token>
control-agent run
```

### Local and remote endpoints

One control plane is often reachable at two addresses — a LAN address at the desk and a public or VPN address elsewhere. Configure both and the agent prefers the local one, moving to the remote one when the local address stops answering and the remote one is confirmed to be answering. A control plane that is down at _every_ configured address is not a failover: the agent keeps its session and the jobs running under it, and reconnects when the server comes back.

```bash
control-agent enroll \
  --server http://192.168.1.10:3090 \
  --remote-server https://control.example.com \
  --enrollment-token <one-time-token>
```

Change the addresses on an enrolled agent, or print the current ones by passing no flags:

```bash
control-agent endpoints
control-agent endpoints --remote-server https://control.example.com
control-agent endpoints --clear-remote
```

The websocket address of each endpoint is derived from its server URL unless `--websocket-server` or `--remote-websocket-server` sets it explicitly.

Changing a server address re-derives its websocket address, because one stored against the old server no longer points anywhere useful. If the websocket is served from somewhere other than `/graphql` on the same host and port — behind a reverse proxy, say — pass it alongside the new server address:

```bash
control-agent endpoints --server http://192.168.1.20:3090 --websocket-server ws://192.168.1.20:3092/graphql
```

### Enrollment

```bash
control-agent enrollment
control-agent unenroll
```

`enrollment` reports whether this machine is enrolled and whether each configured endpoint answers for it. `unenroll` removes the local credential; the control plane still lists the agent until it is deleted there.

Diagnostics:

```bash
control-agent status
control-agent doctor
```

## OpenCode 2

The OpenCode integration requires OpenCode `>=2.1.1 <3`. The agent uses
`@opencode/client` 2.1.1; the Docker image includes `@opencode/cli` 2.1.1.
Install the CLI on each machine running a control agent:

```bash
npm install -g @opencode/cli@2.1.1
# Or, on macOS:
brew install anomalyco/tap/opencode-v2
opencode --version
```

OpenCode 1's `opencode-ai` package and the former `@opencode-ai/sdk/v2` entrypoint
do not provide this integration. Remove a package-managed OpenCode 1 installation
before installing OpenCode 2, since both expose the `opencode` command. Set
`CONTROL_AGENT_OPENCODE_EXECUTABLE` to the full executable path when the agent
should use a specific installation. An invalid override fails explicitly.

Connect providers using OpenCode's `/connect` interface or `opencode auth login`.
Models, credentials, and variants are resolved for each registered worktree.
The agent starts authenticated services on loopback with private state under
its configuration directory. Runs with control-plane MCP tools receive their
own service and connection headers. The agent does not start or stop the user's
shared OpenCode service.

Supported existing configuration and `.opencode/skills` files can remain in
place. Native v2 MCP configuration groups connections under `mcp.servers`.
OpenCode 1 plugin implementations require porting to the new plugin API;
terminal preferences migrate to global `cli.json`. Review the official
[migration guide](https://opencode.ai/v2/docs/migrate-v1/) and
[MCP configuration](https://opencode.ai/v2/docs/mcp-servers/).

History sync retries while OpenCode's native history migration is pending and
reports migration errors without replacing saved transcripts. Full native forms
support typed fields, defaults, conditional visibility, validation, external-step
acknowledgements, and cancellation. A rejected native answer remains editable.

Deploy the server and its additive database migration before upgrading agents.
Existing questions and answers retain their original representation; new native
fields are stored alongside it.

From the repository root, verify the integration with:

```bash
npm run agent:test:run
npm run test:opencode-v2
```

The native smoke test requires the CLI. It uses temporary XDG directories and a
deterministic local model endpoint, then closes its owned service and removes
the temporary data.

The credential and stable agent ID are stored at `~/.config/control-agent/config.json`.

## See also

- [`@ai-development-environment/server`](https://www.npmjs.com/package/@ai-development-environment/server) — the control-plane server.
- The [Homebrew tap](https://github.com/bludesign/homebrew-ai-development-environment) — alternative install that runs the agent as a `brew services` daemon.
