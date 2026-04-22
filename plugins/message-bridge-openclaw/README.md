# Message Bridge OpenClaw Plugin

> 迁移说明：`message-bridge-openclaw` 的主开发仓已迁移到 [agent-plugin](https://github.com/yuzhangCZ/agent-plugin)。当前仓库中的内容用于联调夹具与历史参考。

`message-bridge` is an OpenClaw channel plugin that connects an OpenClaw runtime
to the existing `ai-gateway` WebSocket protocol used by the OpenCode
`message-bridge` plugin.

This package is the OpenClaw-side adapter. It keeps the gateway protocol
unchanged and translates OpenClaw channel runtime events into the gateway
message contract.

维护说明：

- 官方受保障的发布路径只有 GitHub release workflow 和 `pnpm release:local`
- 这两条路径会要求显式提供默认网关地址，并在构建期通过 `MB_DEFAULT_GATEWAY_URL` 固化到 bundle 产物
- 普通本地开发构建未注入时，`channels.message-bridge.gateway.url` 默认仍回退到 `ws://localhost:8081/ws/agent`
- 本次不新增 OpenClaw 侧运行时环境变量覆盖入口；仍以配置文件为准

文档导航（联调优先）:

- `docs/README.md`（文档总导航）
- `docs/01-protocol-contract.zh-CN.md`（协议契约，action 级映射）
- `docs/02-openclaw-interface-surface.zh-CN.md`（OpenClaw 接口面）
- `docs/03-runtime-behavior.zh-CN.md`（状态机、映射、重试与失败语义）
- `docs/04-compat-and-known-diffs.zh-CN.md`（兼容性与已知差异）
- `docs/05-ops-and-configuration.zh-CN.md`（安装、配置、观测、排障）

归档与扩展参考:

- `docs/topics/*`（历史专题归档，不作为当前行为定义）
- `docs/protocol-sequence.md`（历史时序视图）
- `docs/protocol-compat-matrix.zh-CN.md`（历史兼容矩阵视图）
- `docs/USAGE.zh-CN.md`
- `docs/LOGGING-MATRIX.zh-CN.md`
- `docs/CONFIGURATION.zh-CN.md`
- `docs/CONFIGURATION.md`
- `docs/VALIDATION.zh-CN.md`
- `docs/implementation-plan.md`

## 安装方式

当前仓库已验证的安装方式包括本地扩展安装与私有 npm 分发：

- bundle 安装（推荐交付）：执行 `pnpm run install:bundle:dev`，自动把 `bundle/` 安装到 `~/.openclaw-dev/extensions/skill-openclaw-plugin`
- 手动复制 bundle：复制 `bundle/index.js`、`bundle/package.json`、`bundle/openclaw.plugin.json`、`bundle/README.md`
- 私有 npm 分发：通过 OpenClaw 的 npm 安装流安装 `@wecode/skill-openclaw-plugin`

首次私有 npm 安装推荐通过 `npx` 显式指定二方仓源来拉起 helper：

```bash
npx --yes \
  --registry https://your-private-registry.example.com/ \
  --package @wecode/skill-openclaw-plugin \
  message-bridge-openclaw-install \
  --registry https://your-private-registry.example.com/ \
  --url ws://127.0.0.1:8081/ws/agent \
  --token <ak> \
  --password <sk> \
  --dev
```

安装过一次之后，也可以直接使用 `message-bridge-openclaw-install`。该命令会：

- 检查 `openclaw` 是否已安装且版本满足 `>=2026.3.11`
- 幂等配置用户级 `.npmrc` 中的 `@wecode:registry=...`
- 调用 `openclaw plugins install @wecode/skill-openclaw-plugin`
- 调用 `openclaw plugins info skill-openclaw-plugin --json` 校验安装结果
- 调用 `openclaw channels add --channel message-bridge ...`
- 默认执行 `openclaw gateway restart`

CD 发布会先生成 `bundle/`，再把该目录作为 `@wecode/skill-openclaw-plugin` 的 npm 包根发布到私有 registry。安装命令、配置示例和 bundle 入口修改方式见 `docs/USAGE.zh-CN.md`。

关键约束：

- 不要把 `node_modules/` 复制到 `extensions/skill-openclaw-plugin`
- 插件运行时必须使用宿主 OpenClaw 提供的 `plugin-sdk`
- 如果插件目录里出现 `node_modules/openclaw`，可能会和宿主 `openclaw --version` 解析到的版本冲突

## V1 scope

Supported:

- `register`
- `heartbeat`
- `chat`
- `create_session`
- `close_session`
- `abort_session`
- `status_query`

Deferred in V1:

- `permission_reply`
- `question_reply`

Deferred actions fail closed with stable shape:

- `type=tool_error`
- `error=unsupported_in_openclaw_v1:<action>`
- no `errorCode` / `action` wire extension fields
- no `tool_done` fallback receipt for deferred actions

Upgrade path:

- current phase keeps both actions unsupported by design
- implementation target and rollout gate are tracked in `docs/implementation-plan.md` (phase four)

## Environment

Current validated environment:

- OpenClaw `2026.3.11`
- local `ai-gateway`
- Redis on `127.0.0.1:6379`
- MariaDB on `127.0.0.1:3306`
- gateway endpoint `ws://127.0.0.1:8081/ws/agent`

The plugin assumes the active OpenClaw profile already has:

- a usable auth profile in `agents/main/agent/auth-profiles.json`
- a valid default model in `agents.defaults.model`

## Build

```bash
cd <repo-root>/plugins/message-bridge-openclaw
pnpm install
pnpm run build
pnpm test
pnpm run pack:check
```

Successful build should produce a ready-to-install bundle directory at `bundle/`.
`pnpm run build` and `pnpm run build:bundle` are equivalent bundle-only builds.
`bundle/` is generated at build time and is not tracked in git.
`pnpm run install:bundle:dev` builds the bundle and installs it into the OpenClaw `--dev` profile.

## Install into OpenClaw dev environment

This guide uses the OpenClaw `--dev` environment.

The current dev plugin location is:

`~/.openclaw-dev/extensions/skill-openclaw-plugin`

Sync the plugin contents into that directory:

```bash
export OPENCLAW_EXT_DIR="${HOME}/.openclaw-dev/extensions/skill-openclaw-plugin"
rm -rf "$OPENCLAW_EXT_DIR"
mkdir -p "$OPENCLAW_EXT_DIR"
cp <repo-root>/plugins/message-bridge-openclaw/bundle/index.js "$OPENCLAW_EXT_DIR/"
cp <repo-root>/plugins/message-bridge-openclaw/bundle/package.json "$OPENCLAW_EXT_DIR/"
cp <repo-root>/plugins/message-bridge-openclaw/bundle/openclaw.plugin.json "$OPENCLAW_EXT_DIR/"
cp <repo-root>/plugins/message-bridge-openclaw/bundle/README.md "$OPENCLAW_EXT_DIR/"
```

安装目录中不要包含：

- `node_modules/`
- 特别是 `node_modules/openclaw`

推荐安装后的目录只包含：

- `index.js`
- `package.json`
- `openclaw.plugin.json`
- `README.md`

## OpenClaw dev config

Update the dev config file `~/.openclaw-dev/openclaw.json` with:

```json
{
  "agents": {
    "defaults": {
      "model": "openai-codex/gpt-5.3-codex",
      "blockStreamingDefault": "on",
      "blockStreamingBreak": "text_end"
    }
  },
  "plugins": {
    "allow": ["skill-openclaw-plugin"],
    "entries": {
      "skill-openclaw-plugin": {
        "enabled": true
      }
    }
  },
  "channels": {
    "message-bridge": {
      "enabled": true,
      "streaming": true,
      "gateway": {
        "url": "ws://127.0.0.1:8081/ws/agent"
      },
      "auth": {
        "ak": "test-ak-openclaw-001",
        "sk": "test-sk-openclaw-001"
      }
    }
  }
}
```

Minimum required fields are:

- `channels.message-bridge.gateway.url`
- `channels.message-bridge.auth.ak`
- `channels.message-bridge.auth.sk`

Interactive `setup` / `onboarding` only writes:

- `channels.message-bridge.name`
- `channels.message-bridge.gateway.url`
- `channels.message-bridge.auth.ak`
- `channels.message-bridge.auth.sk`

The following register metadata fields are runtime-derived and not user-configurable:

- `toolType` defaults to `openx`
- `toolVersion` comes from the plugin package version at runtime
- `deviceName`, `os`, and `macAddress` are derived by `gateway-client` when it builds the register payload

Known `toolType` values in this plugin: `openx`.  
When a non-`openx` value is injected, runtime logs `runtime.register.tool_type.unknown` and continues.

Progressive text delivery is enabled by default. Optional controls:

- `channels.message-bridge.streaming = false` to force non-streaming delivery mode
- `channels.message-bridge.blockStreaming` is removed and no longer supported
- `agents.defaults.blockStreamingChunk` / `agents.defaults.blockStreamingCoalesce` for chunking cadence overrides

## Start OpenClaw dev gateway

```bash
openclaw --dev gateway run --allow-unconfigured --verbose
```

Healthy startup should show:

- the plugin is loaded
- the `message-bridge` channel account starts
- the gateway connection becomes ready

## Bundle Install

Run:

```bash
cd <repo-root>/plugins/message-bridge-openclaw
pnpm run install:bundle:dev
```

This command will:

- run `pnpm run build`
- install the generated bundle into `~/.openclaw-dev/extensions/skill-openclaw-plugin`
- print the installed files
- print the next gateway start command

If you need manual install instead, copy the generated `bundle/` directory contents into:

- `~/.openclaw-dev/extensions/skill-openclaw-plugin`

The generated bundle directory already contains:

- `index.js`
- `package.json`
- `openclaw.plugin.json`
- `README.md`

No manual `package.json` edits are required.

## NPM Install Helper

For first-time private registry installation, prefer an explicit `npx` bootstrap command:

```bash
npx --yes \
  --registry https://your-private-registry.example.com/ \
  --package @wecode/skill-openclaw-plugin \
  message-bridge-openclaw-install \
  --registry https://your-private-registry.example.com/ \
  --url ws://127.0.0.1:8081/ws/agent \
  --token <ak> \
  --password <sk> \
  --dev
```

Behavior:

- `npx --registry ...` ensures the helper itself can be downloaded from the private registry on first use
- checks `openclaw --version` against the package `peerDependencies.openclaw`
- writes or updates `@wecode:registry=...` in the resolved user `.npmrc`
- streams `openclaw plugins install` output directly to the terminal
- verifies install result with `openclaw plugins info skill-openclaw-plugin --json`
- runs `openclaw channels add --channel message-bridge ...`
- restarts the OpenClaw gateway by default

If the private registry requires auth, make sure your npm auth environment is already available before running the command.

Pass `--no-restart` only when you explicitly need to defer gateway restart.

## Runtime Version Conflicts

如果启动时报类似下面的错误：

- `Cannot access 'ANTHROPIC_MODEL_ALIASES' before initialization`

优先检查插件目录里是否存在私有 OpenClaw runtime：

```bash
find ~/.openclaw-dev/extensions/skill-openclaw-plugin -maxdepth 2 -type d | grep node_modules
```

如果存在 `~/.openclaw-dev/extensions/skill-openclaw-plugin/node_modules/openclaw`，先删除整个 `node_modules/`，再按本文档重新安装最小文件集。

这类错误通常不是 OpenClaw 配置字段错误，而是：

- 宿主 `openclaw --version`
- 插件目录里的私有 `node_modules/openclaw`

两者版本混用导致的模块初始化冲突。

## Verify registration and heartbeat

Check the gateway log:

`<repo-root>/integration/opencode-cui/logs/local-stack/ai-gateway.log`

Expected result:

- registration for `test-ak-openclaw-001`
- `toolType=openx`
- periodic heartbeat logs

## Verify control path

Publish a status query:

```bash
redis-cli publish agent:test-ak-openclaw-001 '{"type":"status_query"}'
```

Expected result in `ai-gateway.log`:

- `status_response`
- `opencodeOnline=true`

## Verify chat path

Publish a chat invoke:

```bash
redis-cli publish agent:test-ak-openclaw-001 '{"type":"invoke","action":"chat","welinkSessionId":"welink-openclaw-verify-001","payload":{"toolSessionId":"tool-openclaw-verify-001","text":"Reply with exactly: hello from openclaw bridge verification"}}'
```

Expected result in `ai-gateway.log`:

- downstream `invoke`
- upstream `tool_event`
- upstream `tool_done`

Confirm the actual assistant output in the latest session file under:

`~/.openclaw-dev/agents/main/sessions`

## Known limitations

- `permission_reply` is not implemented
- `question_reply` is not implemented
- both actions return fail-closed standard `tool_error` with `error=unsupported_in_openclaw_v1:<action>`
- `close_session` success only clears local session state and does not emit `tool_done`
- streaming is block-level, not token-level
- published `openclaw plugins install` distribution flow is not yet validated for this package
- plugin install must not include `node_modules/openclaw`
