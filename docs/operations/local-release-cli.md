# Local Release CLI

This repository provides a single local release CLI for both workspace packages:

- `@wecode/skill-opencode-plugin`
- `@wecode/skill-openclaw-plugin`

The CLI is intended for maintainers who need to build, verify, publish, and create local release git metadata from a developer machine without using the GitHub release workflows.

## Entry Points

```bash
pnpm release:local -- --target <message-bridge|message-bridge-openclaw|dual> ...
pnpm release:plan -- --target <message-bridge|message-bridge-openclaw|dual> ...
```

- `release:local` executes the full flow.
- `release:plan` is the same CLI with `--dry-run` enabled by default.
- `verify:release-local:e2e` runs an isolated fake-registry end-to-end validation harness.

## Before You Run It

Make sure all of the following are true:

- dependencies are installed with `pnpm install --frozen-lockfile`
- the target npm registry is configured in `.npmrc` or via environment variables
- `npm whoami` succeeds for the target registry
- the release version you want is known before you start
- you understand that publish and git are non-atomic

Recommended checks:

```bash
pnpm install --frozen-lockfile
npm config get registry
npm whoami
```

If you publish through a scoped private registry such as `@wecode:registry=...`, the CLI resolves that scoped registry and authenticates against it instead of blindly trusting the default registry.

## Current Package Differences

The CLI uses one interface, but the two packages still publish differently:

- `message-bridge` publishes from `plugins/message-bridge`
- `message-bridge-openclaw` publishes from `plugins/message-bridge-openclaw/bundle`

That difference is intentional for now. The follow-up refactor issue is tracked in [openclaw-root-publish-refactor-issue.md](./openclaw-root-publish-refactor-issue.md).

## Required Version Input

Single-target releases require exactly one of:

```bash
--version <semver>
--bump <patch|minor|major|prerelease>
```

Dual releases require either:

```bash
--bump <patch|minor|major|prerelease>
```

or:

```bash
--bridge-version <semver> --openclaw-version <semver>
```

## Flags

### Target Selection

- `--target message-bridge`
- `--target message-bridge-openclaw`
- `--target dual`

### Version Selection

- `--version <semver>`
- `--bridge-version <semver>`
- `--openclaw-version <semver>`
- `--bump patch|minor|major|prerelease`
- `--preid <alpha|beta|rc>`  
  Default: `beta`
- `--release stable|prerelease`  
  Optional explicit release kind check

### Execution Control

- `--dry-run`
- `--skip-publish`
- `--skip-git`
- `--push`
- `--allow-dirty`

Invalid combination:

- `--skip-publish --push`

## Default Behavior

Unless you override it:

- `npm publish` runs
- git commit and git tag are created locally
- remote push does not run
- only explicit `--push` sends the branch and new tags to `origin`
- `--skip-publish` cannot be combined with `--push`

This is the default safety model:

1. publish to npm
2. create local commit/tag
3. optionally push remote refs

If publish succeeds but later git steps fail, do not republish the same version.

## Stable Release Examples

Release `message-bridge` by bumping a patch version:

```bash
pnpm release:local -- --target message-bridge --bump patch
```

Release `message-bridge-openclaw` with an explicit version and keep the result local:

```bash
pnpm release:local -- --target message-bridge-openclaw --version 0.2.0
```

Preview a stable release without changing npm or git:

```bash
pnpm release:plan -- --target message-bridge --version 1.2.0
```

## Prerelease Examples

Create the next beta for `message-bridge`:

```bash
pnpm release:local -- --target message-bridge --bump prerelease --preid beta
```

Release an explicit RC for `message-bridge-openclaw`:

```bash
pnpm release:local -- --target message-bridge-openclaw --version 0.2.0-rc.1 --release prerelease --preid rc
```

## Dual Release Examples

Bump both packages with the same release type:

```bash
pnpm release:local -- --target dual --bump patch
```

Release both packages with explicit versions:

```bash
pnpm release:local -- --target dual --bridge-version 1.3.0 --openclaw-version 0.2.0
```

Dual mode is not atomic. If the first publish succeeds and the second fails, the first package may already be live in the registry.

## Build, Verify, and Publish Flow

For each target, the CLI does the following:

1. resolve the target version and release dist-tag
2. rewrite the target package version
3. run target-specific build steps
4. run the target-specific `verify:release` command
5. evaluate the publish readiness contract
6. publish if readiness is `true` and `--skip-publish` is not set
7. create local commit/tag if `--skip-git` is not set
8. push branch and tags only if `--push` is set

Publish readiness is the last gate before the irreversible `npm publish` step. The CLI prints:

- `releaseReady`
- `resolvedVersion`
- `resolvedDistTag`
- `resolvedPublishRoot`
- `executedChecks`

## Failure Cases and Recovery

### Dirty Worktree

The CLI rejects a dirty worktree by default.

Use `--allow-dirty` only when you intentionally need to keep unrelated local changes out of the release commit.

### Tag Already Exists

If the target release tag already exists locally, the CLI stops before any build or publish step.

### Registry or Auth Failure

If `npm config get registry` or `npm whoami` is wrong, the CLI fails before publish.

### Publish Succeeds but Git Does Not

This is the most important recovery case.

- the package may already be published
- the local commit and tag may be missing or incomplete
- do not republish the same version
- inspect the registry first, then repair git state manually

### Dual Release Partial Success

If the first package publishes and the second one fails:

- treat the first package version as already consumed
- do not rerun the same first version blindly
- repair or complete git state after you confirm what the registry contains

## End-to-End Validation Harness

Use the dedicated harness when you need to validate the full local release flow without touching the real private registry:

```bash
pnpm verify:release-local:e2e
```

Default behavior:

- copies the current workspace into a temporary isolated directory
- initializes a temporary git repository and a local bare remote
- starts a temporary fake npm registry
- publishes both packages for real into that fake registry
- verifies prerelease dist-tags, dual release behavior, failure recovery, and `--push`

Optional environment variables:

- `RELEASE_E2E_REGISTRY_URL`
- `RELEASE_E2E_NPM_TOKEN`
- `RELEASE_E2E_REMOTE_PATH`
- `RELEASE_E2E_KEEP_TMP=1`

If `RELEASE_E2E_REGISTRY_URL` is omitted, the harness starts its own temporary Verdaccio instance.

## Related Docs

- [README.md](../../README.md)
- [plugins/message-bridge/docs/operations/npm-publish-guide.md](../../plugins/message-bridge/docs/operations/npm-publish-guide.md)
- [openclaw-root-publish-refactor-issue.md](./openclaw-root-publish-refactor-issue.md)
