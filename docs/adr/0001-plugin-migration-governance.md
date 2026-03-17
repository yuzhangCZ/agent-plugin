# ADR 0001: Plugin Migration Governance

## Status

Accepted

## Context

`message-bridge` and `message-bridge-openclaw` are being migrated from the current `opencode-CUI` repository into `agent-plugin`.

The destination repository will become the primary development location. The source repository remains only as an integration fixture referenced by submodule.

## Decision

1. `agent-plugin` is the single primary repository for feature work on the two plugins.
2. `opencode-CUI` is referenced only for end-to-end integration and fixture reuse.
3. Migration is split from refactoring. Shared packages, naming cleanup, and protocol consolidation are explicitly deferred.
4. Migration phase must not change external package identity, plugin identity, install paths, config keys, or protocol wire shape.
5. `plugins/message-bridge-opencode-plugin` is not migrated; it remains legacy reference material only.
6. Submodule updates require a dedicated change and explicit verification.

## Consequences

- Development ownership moves to `agent-plugin` immediately after migration freeze.
- The source repository must not remain a long-term dual-write location.
- Follow-up refactors happen only after the migrated baseline is green.
