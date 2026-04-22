# Message Bridge Configuration Reference

This document defines the supported configuration fields for the
`message-bridge-openclaw` plugin, where to configure them, and how effective
values are resolved.

## Supported fields

The plugin reads channel config under `channels.message-bridge`:

- `enabled` (`boolean`, optional, default `true`)
- `debug` (`boolean`, optional, default `false`; enables raw WebSocket frame logging)
- `name` (`string`, optional)
- `gateway.url` (`string`, required, must start with `ws://` or `wss://`)
- `auth.ak` (`string`, required)
- `auth.sk` (`string`, required)
- `agentIdPrefix` (`string`, optional, default `"message-bridge"`)
- `runTimeoutMs` (`integer`, optional, default `300000`)

Not supported as user config:

- `GatewayUrl` / `gatewayUrl` (non-standard aliases, ignored)
- `gateway.heartbeatIntervalMs` / `gateway.reconnect.*` (connection policy uses gateway-client defaults)
- register metadata fields like `toolType`, `toolVersion`, `deviceName`, `macAddress`
- runtime default `toolType` is `openx`
- known `toolType` list is `["openx"]`; unknown values only emit `runtime.register.tool_type.unknown` warning and do not block startup

## Where to configure

You can configure these fields in three ways:

1. `openclaw channels add --channel message-bridge --url <gateway-url> --token <ak> --password <sk> [--name <name>]`
2. Channel onboarding flow (`openclaw onboard` / `openclaw channels add` wizard path)
3. Manual edit in OpenClaw config file:
   - default profile: `~/.openclaw/openclaw.json`
   - dev profile (`--dev`): `~/.openclaw-dev/openclaw.json`
   - custom path when `OPENCLAW_CONFIG_PATH` is set

## Resolution and precedence

For plugin-specific fields, effective values are resolved in this order:

1. Explicit values in `channels.message-bridge` in active `openclaw.json`
2. Plugin defaults for missing optional fields

Notes:

- `channels add` / onboarding do not create `GatewayUrl` aliases; they write canonical fields only.
- This plugin does not define dedicated env vars such as `MESSAGE_BRIDGE_GATEWAY_URL`.
- If you need environment-driven values, use `${VAR_NAME}` substitution in `openclaw.json`.
  See OpenClaw env docs:
  - `plugins/openclaw/docs/help/environment.md`
  - `plugins/openclaw/docs/zh-CN/help/environment.md`
