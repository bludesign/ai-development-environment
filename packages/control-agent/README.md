# @ai-development-environment/control-agent

Control agent for the [AI Development Environment](https://github.com/bludesign/ai-development-environment). It makes authenticated outbound HTTP and GraphQL WebSocket connections to the control plane; managed machines do not expose a listening port.

## Install

```bash
npm install -g @ai-development-environment/control-agent
```

Requires Node.js 24 (`>=24.16.0 <25`). Running Cloudflared jobs additionally requires [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) on the `PATH` (for example `brew install cloudflared`) — `control-agent doctor` checks for it.

## Usage

Open the server's **Agents** page and create a one-time enrollment command, then run it on the target machine (the server defaults to the same computer when omitted):

```bash
control-agent enroll \
  --server http://127.0.0.1:3090 \
  --enrollment-token <one-time-token>
control-agent run
```

Diagnostics:

```bash
control-agent status
control-agent doctor
```

The credential and stable agent ID are stored at `~/.config/control-agent/config.json`.

## See also

- [`@ai-development-environment/server`](https://www.npmjs.com/package/@ai-development-environment/server) — the control-plane server.
- The [Homebrew tap](https://github.com/bludesign/homebrew-ai-development-environment) — alternative install that runs the agent as a `brew services` daemon.
