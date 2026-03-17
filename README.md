# agent-plugin

Monorepo for `message-bridge` and `message-bridge-openclaw`.

## Principles

- `agent-plugin` is the primary development repository for the two plugins.
- `opencode-CUI` is referenced as an integration fixture via submodule.
- Migration phase keeps external plugin identity, config keys, install paths, and protocol shapes unchanged.
- Shared package extraction and naming unification are deferred until after migration freeze.

## Workspaces

- `plugins/message-bridge`
- `plugins/message-bridge-openclaw`
- `integration/opencode-cui`

## Root Commands

- `pnpm build`
- `pnpm test`
- `pnpm verify:workspace`
- `pnpm verify:integration:fixture`
- `pnpm verify:integration:smoke`

## CI

GitHub Actions validates:

- `pnpm verify:workspace`
- `pnpm verify:integration:fixture`

The heavier `verify:integration:smoke` command remains a manual or dedicated-environment gate.
