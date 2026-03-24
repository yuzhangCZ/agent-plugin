# Issue Draft: Publish `message-bridge-openclaw` from Source Root

## Summary

Refactor `plugins/message-bridge-openclaw` so the release pipeline publishes from the source package root instead of the generated `bundle/` directory.

## Why

- The current release path adds an extra packaging layer.
- Publishing from `bundle/` makes the release shape diverge from the source tree.
- A root-publish flow will simplify pack checks, reduce duplication, and make future packaging changes easier to reason about.

## Proposed Change

- Keep bundle generation for runtime or install workflows if it is still needed.
- Move the npm publish source to `plugins/message-bridge-openclaw`.
- Make the published tarball come from the package root and its `files` allowlist instead of from `bundle/`.
- Update the release workflow, local release docs, and any pack checks that still assume `bundle/` is the publish root.

## Non-Goals

- Do not change the runtime plugin identity.
- Do not change OpenClaw config keys, channel id, or install path semantics.
- Do not redesign the release tag format.

## Risks And Migration Notes

- The current bundle-only tarball shape must remain minimal after the root-publish refactor.
- Existing local and CI release scripts must move in lockstep so the publish root does not diverge again.
- Pack validation needs to keep blocking `docs/`, `dist/`, and sourcemaps from leaking into the published tarball.

## Acceptance Criteria

- `npm pack` and `npm publish` work from the package root.
- The published tarball contains only the intended runtime files.
- The release workflow no longer depends on `bundle/` as the publish directory.
- Documentation and recovery notes reflect the new root-publish path.
