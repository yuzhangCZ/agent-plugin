# Migration Status Report

## Current State

The repository migration baseline is now active in `agent-plugin`.

Completed:

- monorepo workspace established
- `message-bridge` migrated with history
- `message-bridge-openclaw` migrated with history
- `integration/opencode-cui` submodule connected as fixture
- fixture submodule default branch aligned to `main`
- root verification commands established
- hosted CI established for `verify:workspace` and `verify:integration:fixture`
- dedicated self-hosted workflow established for `test:openclaw:runtime`

## Verification Commands

- `pnpm verify:workspace`
- `pnpm verify:integration:fixture`
- `pnpm run test:openclaw:runtime`

## CI Layers

- Hosted CI:
  - `.github/workflows/ci.yml`
  - validates workspace and fixture baseline
- Dedicated smoke gate:
  - `.github/workflows/integration-smoke.yml`
  - manual trigger
  - requires a self-hosted runner labeled `integration-smoke`

## Source Repository Status

The source repository remains:

- integration fixture
- historical reference

Its plugin README files include migration notices pointing contributors to `agent-plugin`.

## Remaining Follow-up

- observe hosted CI results on GitHub and fix any environment-specific drift
- provision or confirm a self-hosted runner labeled `integration-smoke`
- decide whether to create a migration milestone tag or PR summary
- continue long-tail documentation cleanup only if new drift is found
