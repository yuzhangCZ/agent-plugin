# agent-plugin

Monorepo for `message-bridge` and `message-bridge-openclaw`.

## Principles

- `agent-plugin` is the primary development repository for the two plugins.
- `opencode-CUI` is referenced as an integration fixture via submodule.
- Migration phase keeps external plugin identity, config keys, install paths, and protocol shapes unchanged.
- Shared package extraction and naming unification are deferred until after migration freeze.

## Workspaces

- `packages/skill-qrcode-auth`
- `plugins/message-bridge`
- `plugins/message-bridge-openclaw`
- `integration/opencode-cui`

## Root Commands

- `pnpm build`
- `pnpm test`
- `pnpm verify:workspace`
- `pnpm verify:integration:fixture`
- `pnpm run test:openclaw:runtime`
- `pnpm run verify:release-local:e2e`

## CI

GitHub Actions validates:

- `pnpm verify:workspace`
- `pnpm verify:integration:fixture`

The heavier OpenClaw runtime smoke remains a manual or dedicated-environment gate.

A dedicated manual workflow is available at `.github/workflows/integration-smoke.yml`.

That workflow expects a self-hosted runner labeled `integration-smoke`.

## Release

- `@wecode/skill-qrcode-auth`: push tag `release/skill-qrcode-auth/vX.Y.Z`
- `@wecode/skill-opencode-plugin`: push tag `release/message-bridge/vX.Y.Z`
- `@wecode/skill-openclaw-plugin`: push tag `release/message-bridge-openclaw/vX.Y.Z`
- package version is sourced from each plugin `package.json`; the repo root version is not used for release
- local release CLI guide: [docs/operations/local-release-cli.md](./docs/operations/local-release-cli.md)
- local release dry-run: `pnpm release:plan -- --target <skill-qrcode-auth|message-bridge|message-bridge-openclaw|dual> ...`
- local release execution: `pnpm release:local -- --target <skill-qrcode-auth|message-bridge|message-bridge-openclaw|dual> ...`
