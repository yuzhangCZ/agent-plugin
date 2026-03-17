# Test Layering

## Layers

### unit
- Validate schema, normalizers, status aggregation, session state, and other pure logic.
- Must not depend on real host processes, real bundle artifacts, real network access, or real install directories.

### integration
- Validate plugin-internal collaboration using fake runtime, fake connection, fake dispatcher, and shared protocol fixtures.
- Must not depend on real OpenClaw processes, real install directories, or external service stacks.

### runtime-smoke
- Validate bundle loading, registration, initialization, and the minimal message flow using a loader harness.
- May use temporary HOME/workspace, shared mock gateway, bundle artifacts, and OpenClaw CLI.
- Must not depend on real install directories or the full Redis/MariaDB/ai-gateway stack.

## Shared Test Support
- `packages/test-support` is an internal test-only package.
- Production code under `plugins/*/src/**` must not import it.
- Shared scope is limited to protocol fixtures, transport helpers, timing helpers, and wire-level assertions.
- Host-specific runtime helpers remain inside each plugin.

## Change Rule
- This test refactor must not modify business logic under `src/**`.
- If a mismatch requires changing business semantics, stop and record it as a follow-up for separate evaluation.
