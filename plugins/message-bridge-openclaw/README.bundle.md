# Message Bridge OpenClaw Plugin

`message-bridge-openclaw` is an OpenClaw native channel plugin that bridges
OpenClaw runtime events to the existing `ai-gateway` protocol used by the
OpenCode-side `message-bridge` plugin.

## Install

This package is intended to be installed into a real OpenClaw host.

- first-time bootstrap: use `npx --registry <private-registry> --package @wecode/skill-openclaw-plugin message-bridge-openclaw-install ...`
- install helper: after the package is available, you can run `message-bridge-openclaw-install` directly
- the helper writes `@wecode:registry=https://cmc.centralrepo.rnd.huawei.com/artifactory/api/npm/product_npm/` into the resolved user `.npmrc`
- npm install: use the package through OpenClaw's plugin installation flow
- local dev install: build the bundle and install `bundle/` into an isolated
  OpenClaw profile

The published artifact only contains:

- `index.js`
- `install.mjs`
- `package.json`
- `openclaw.plugin.json`
- `README.md`

The package does not ship `dist/`, docs, sourcemaps, or a bundled copy of
`openclaw`.

## Host Requirement

- `openclaw >=2026.3.11`

The plugin relies on the host-provided `openclaw/plugin-sdk` at runtime.

## Local Validation

From the repository root:

```bash
pnpm --dir plugins/message-bridge-openclaw run build
pnpm --dir plugins/message-bridge-openclaw run pack:check
```

To run host-backed verification, provide a real OpenClaw binary:

```bash
export OPENCLAW_BIN=/path/to/openclaw
pnpm --dir plugins/message-bridge-openclaw run verify:release
```

## Runtime Coverage

The host-backed runtime smoke validates:

- plugin load into OpenClaw
- `register`
- `chat`
- `status_query`
- deferred action fail-closed behavior
