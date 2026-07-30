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

One control plane is often reachable at two addresses — a LAN address at the desk and a public or VPN address elsewhere. Configure both and the agent prefers the local one, falling back to the remote one when the local address stops answering:

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

The credential and stable agent ID are stored at `~/.config/control-agent/config.json`.

## See also

- [`@ai-development-environment/server`](https://www.npmjs.com/package/@ai-development-environment/server) — the control-plane server.
- The [Homebrew tap](https://github.com/bludesign/homebrew-ai-development-environment) — alternative install that runs the agent as a `brew services` daemon.
