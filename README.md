# AI Development Environment

A Next.js application for an AI-focused development environment.

## Development

Install Node.js 24.16 or newer in the Node 24 release line, then install dependencies:

```bash
npm ci
```

Common commands:

- `npm run dev` starts the development server.
- `npm run full-check` formats and fixes the project before checking it.
- `npm run full-check:ci` runs the non-mutating CI checks.
- `npm run build` creates a deployable standalone build.
- `npm run start` starts the standalone production server.

The production server accepts the standard Next.js `HOSTNAME` and `PORT` environment variables.

## Homebrew

The Homebrew formula is maintained in [`bludesign/ai-development-environment-tap`](https://github.com/bludesign/ai-development-environment-tap).

Because the tap repository does not use Homebrew's `homebrew-` naming convention, add it with its explicit remote:

```bash
brew tap bludesign/ai-development-environment-tap \
  https://github.com/bludesign/ai-development-environment-tap.git
brew install ai-development-environment
brew services start ai-development-environment
```
