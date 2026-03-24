# Migration Identity Matrix

Migration phase rule: keep runtime/plugin identity stable while allowing private-registry npm package renames.

## message-bridge

| Identity | Current Value | Migration Phase |
| --- | --- | --- |
| Directory | `plugins/message-bridge` | unchanged |
| npm package | `@wecode/skill-opencode-plugin` | private registry package name |
| External protocol behavior | current implementation | unchanged |
| Config and install semantics | current implementation | unchanged |

## message-bridge-openclaw

| Identity | Current Value | Migration Phase |
| --- | --- | --- |
| Directory | `plugins/message-bridge-openclaw` | unchanged |
| npm package | `@wecode/skill-openclaw-plugin` | private registry package name |
| OpenClaw channel/plugin id | `message-bridge` | unchanged |
| Install directory | `~/.openclaw[-dev]/extensions/message-bridge` | unchanged |
| Config key | `channels.message-bridge` | unchanged |
| Gateway registration semantics | current implementation | unchanged |

## Additional Constraints

- Runtime plugin identity remains unchanged even if npm package names change.
- Do not change config keys during migration.
- Do not change install paths during migration.
- Do not combine migration with shared package extraction.
