# Migration Identity Matrix

Migration phase rule: move repository location only. Do not change user-facing identity.

## message-bridge

| Identity | Current Value | Migration Phase |
| --- | --- | --- |
| Directory | `plugins/message-bridge` | unchanged |
| npm package | `@opencode-cui/message-bridge` | unchanged |
| External protocol behavior | current implementation | unchanged |
| Config and install semantics | current implementation | unchanged |

## message-bridge-openclaw

| Identity | Current Value | Migration Phase |
| --- | --- | --- |
| Directory | `plugins/message-bridge-openclaw` | unchanged |
| `package.json.name` | `message-bridge` | unchanged |
| OpenClaw channel/plugin id | `message-bridge` | unchanged |
| Install directory | `~/.openclaw[-dev]/extensions/message-bridge` | unchanged |
| Config key | `channels.message-bridge` | unchanged |
| Gateway registration semantics | current implementation | unchanged |

## Additional Constraints

- Do not rename packages during migration.
- Do not change config keys during migration.
- Do not change install paths during migration.
- Do not combine migration with shared package extraction.
