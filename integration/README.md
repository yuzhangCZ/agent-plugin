# Integration Fixtures

`integration/opencode-cui` is a git submodule that points at the current source repository used for end-to-end integration.

Rules:

- Treat it as an integration fixture, not the primary development location for the migrated plugins.
- Update the submodule only in dedicated changes.
- Validate the submodule pointer after each bump before release.

## Verification Layers

- `pnpm verify:integration:fixture`
  - fast check
  - validates that the submodule is present and structurally usable
- `pnpm verify:integration:smoke`
  - heavier gate
  - runs the current `message-bridge` e2e smoke and `message-bridge-openclaw` bundle build from the monorepo root

## Dedicated Smoke Workflow

The repository provides a manual GitHub Actions workflow:

- `.github/workflows/integration-smoke.yml`

Design rules:

- trigger manually with `workflow_dispatch`
- run on `self-hosted`
- keep it out of the default hosted CI path

## Submodule Bump Policy

- bump `integration/opencode-cui` only in dedicated changes
- after each bump, run `pnpm verify:integration:fixture`
- before release or merge of risky fixture changes, run `pnpm verify:integration:smoke`
- do not treat the fixture repository as the primary development location for migrated plugins
