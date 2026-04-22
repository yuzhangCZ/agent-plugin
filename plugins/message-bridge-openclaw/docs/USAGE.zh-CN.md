# Message Bridge OpenClaw 插件使用指南

本文档说明 `message-bridge-openclaw` 当前在 OpenClaw 中的已验证安装方式，以及构建、配置、联调步骤。

如果你要按阶段执行验收，而不是只做一次联调，请同时参考：

- `docs/VALIDATION.zh-CN.md`
- `docs/LOGGING-MATRIX.zh-CN.md`
- `docs/CONFIGURATION.zh-CN.md`

当前插件目录：

- `<repo-root>/plugins/message-bridge-openclaw`

当前插件能力边界：

- 已支持：`register`、`heartbeat`、`chat`、`create_session`、`close_session`、`abort_session`、`status_query`
- 未支持：`permission_reply`、`question_reply`
- 文本输出为 block 级 streaming，不是 token 级 streaming
- 当前环境里模型首块延迟和超时仍可能影响实际流式体验

运行时依赖约束：

- 插件运行时使用宿主 OpenClaw 提供的 `plugin-sdk`
- 安装目录中不要复制 `node_modules/`
- 尤其不要包含 `node_modules/openclaw`

## 1. 当前支持的安装方式

- 正式私有 npm 安装
  - 首次安装推荐通过 `npx` 显式指定二方仓源拉起 `message-bridge-openclaw-install`
  - 安装过一次后也可以直接运行 `message-bridge-openclaw-install`
  - 自动校验 `openclaw` 是否已安装且版本满足最低要求
  - 自动幂等配置 `@wecode` 二方仓源到用户级 `.npmrc`
  - 自动执行 `openclaw plugins install`
  - 自动执行 `openclaw channels add`
  - 默认自动执行 `openclaw gateway restart`
- bundle 安装（推荐交付）
  - 执行 `pnpm run install:bundle:dev`
  - 自动生成完整的 `bundle/` 安装目录
  - 自动安装到 `~/.openclaw-dev/extensions/skill-openclaw-plugin`
  - 不需要手动修改任何文件
- 手动复制 bundle
  - 把 `bundle/index.js`、`bundle/package.json`、`bundle/openclaw.plugin.json`、`bundle/README.md` 复制到 OpenClaw profile 的 `extensions/skill-openclaw-plugin/`
- `openclaw plugins install`
  - 这是 OpenClaw 的通用安装入口
  - 但本仓库当前没有已验证的 npm 发布安装流，本文不把它作为主路径

推荐顺序：

1. 正式安装：`npx --registry ... --package @wecode/skill-openclaw-plugin message-bridge-openclaw-install ...`
2. 本地部署或交付验证：bundle 安装
3. 手动交付或排障：手动复制 bundle

## 2. 前置条件

必须满足：

- 已安装 OpenClaw
- `ai-gateway` 已启动
- Redis、MariaDB 已启动
- `ai-gateway` 中已存在可用 AK/SK
- OpenClaw profile 已具备可用模型认证

当前本地验证使用：

- OpenClaw `2026.3.11`
- 网关地址：`ws://127.0.0.1:8081/ws/agent`
- 测试凭据：
  - `ak`: `test-ak-openclaw-001`
  - `sk`: `test-sk-openclaw-001`

OpenClaw profile 常见路径：

- 默认 profile：`~/.openclaw`
- dev profile：`~/.openclaw-dev`

下文默认以 dev profile 为例；如果你使用默认 profile，把路径中的 `.openclaw-dev` 替换成 `.openclaw` 即可。

## 3. 构建

macOS / Linux：

```bash
cd <repo-root>/plugins/message-bridge-openclaw
pnpm install
pnpm run build
pnpm test
```

Windows PowerShell：

```powershell
cd C:\path\to\agent-plugin\plugins\message-bridge-openclaw
pnpm install
pnpm run build
pnpm test
```

如果你希望直接安装到 OpenClaw `--dev` 插件目录，执行：

```bash
pnpm run install:bundle:dev
```

如果你要验证发布态安装流程，安装包后可执行：

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

说明：

- `npx --registry ...` 负责让首次执行时能从私仓下载 helper 自身
- 命令会先检查 `openclaw --version`
- 命令会实时透传 `openclaw plugins install` 的终端输出
- 命令默认执行 `openclaw gateway restart`
- 如果确实不希望自动重启，显式追加 `--no-restart`
- 如果私仓需要认证，执行前要保证 npm 认证环境已可用

## 4. 手动复制 bundle

### 4.1 目标目录

- 默认 profile：`~/.openclaw/extensions/skill-openclaw-plugin`
- dev profile：`~/.openclaw-dev/extensions/skill-openclaw-plugin`

### 4.2 macOS / Linux

```bash
export OPENCLAW_EXT_DIR=~/.openclaw-dev/extensions/skill-openclaw-plugin
mkdir -p "$OPENCLAW_EXT_DIR"
cp ./bundle/index.js "$OPENCLAW_EXT_DIR/index.js"
cp ./bundle/package.json "$OPENCLAW_EXT_DIR/package.json"
cp ./bundle/openclaw.plugin.json "$OPENCLAW_EXT_DIR/openclaw.plugin.json"
cp ./bundle/README.md "$OPENCLAW_EXT_DIR/README.md"
```

### 4.3 Windows PowerShell

```powershell
$target = "$env:USERPROFILE\.openclaw-dev\extensions\skill-openclaw-plugin"
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item .\bundle\index.js "$target\index.js" -Force
Copy-Item .\bundle\package.json "$target\package.json" -Force
Copy-Item .\bundle\openclaw.plugin.json "$target\openclaw.plugin.json" -Force
Copy-Item .\bundle\README.md "$target\README.md" -Force
```

安装后的目标目录建议只保留：

- `index.js`
- `package.json`
- `openclaw.plugin.json`
- `README.md`

不要保留：

- `node_modules/`
- `node_modules/openclaw`

## 5. bundle 安装

这一方式适合“减少手工配置并直接复制安装”。推荐命令是 `pnpm run install:bundle:dev`。

### 6.1 执行 bundle

```bash
cd <repo-root>/plugins/message-bridge-openclaw
pnpm run install:bundle:dev
```

该命令会：

- 执行 `pnpm run build`
- 检查 `bundle/` 中的安装产物
- 安装到 `~/.openclaw-dev/extensions/skill-openclaw-plugin`
- 打印已安装文件列表
- 打印下一步启动命令

`build:bundle` 的输出文件：

- `bundle/index.js`
- `bundle/package.json`
- `bundle/openclaw.plugin.json`
- `bundle/README.md`

注意：`bundle/` 是构建生成目录，不纳入 git 跟踪；每次发布/安装前按需执行 `pnpm run build:bundle`。

说明：

- `openclaw` / `openclaw/*` 被保留为 external
- 目标环境里仍然需要安装 OpenClaw runtime
- bundle 目录内容可以直接复制到插件安装目录

### 6.2 一键安装脚本

当前仓库提供：

- macOS / Linux: `scripts/install-bundle-dev.sh`
- Windows PowerShell: `scripts/install-bundle-dev.ps1`

这两个脚本都只从 `bundle/` 安装，不会从源码目录复制，也不会把 `node_modules/openclaw` 混入目标目录。

### 6.3 手动复制安装（备选）

如果你不想用一键安装脚本，也可以手动复制 `bundle/` 内容。

macOS / Linux：

```bash
export OPENCLAW_EXT_DIR=~/.openclaw-dev/extensions/skill-openclaw-plugin
mkdir -p "$OPENCLAW_EXT_DIR"
cp ./bundle/index.js "$OPENCLAW_EXT_DIR/index.js"
cp ./bundle/package.json "$OPENCLAW_EXT_DIR/package.json"
cp ./bundle/openclaw.plugin.json "$OPENCLAW_EXT_DIR/openclaw.plugin.json"
cp ./bundle/README.md "$OPENCLAW_EXT_DIR/README.md"
```

Windows PowerShell：

```powershell
$target = "$env:USERPROFILE\.openclaw-dev\extensions\skill-openclaw-plugin"
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item .\bundle\index.js "$target\index.js" -Force
Copy-Item .\bundle\package.json "$target\package.json" -Force
Copy-Item .\bundle\openclaw.plugin.json "$target\openclaw.plugin.json" -Force
Copy-Item .\bundle\README.md "$target\README.md" -Force
```

Bundle 安装目录不需要再修改 `package.json`。生成的 `bundle/package.json` 已经固定为 `index.js` 入口。

## 6.5 运行时版本冲突排查

如果启动 `openclaw gateway run` 时出现类似：

- `Cannot access 'ANTHROPIC_MODEL_ALIASES' before initialization`

先排查插件目录里是否混入了私有 OpenClaw runtime。

macOS / Linux：

```bash
find ~/.openclaw-dev/extensions/skill-openclaw-plugin -maxdepth 2 -type d | grep node_modules
```

Windows PowerShell：

```powershell
Get-ChildItem "$env:USERPROFILE\.openclaw-dev\extensions\skill-openclaw-plugin" -Depth 2 -Directory |
  Where-Object { $_.FullName -match 'node_modules' }
```

如果发现 `node_modules/openclaw`：

1. 删除插件目录中的 `node_modules`
2. 重新按“目录复制安装”或“bundle 单文件安装”部署
3. 再执行 `openclaw --dev gateway run --allow-unconfigured --verbose`

这类错误通常不是 `openclaw.json` 配置字段错误，而是插件目录中的私有 `openclaw` 和宿主 OpenClaw 版本混用导致的模块初始化问题。

## 7. 配置 OpenClaw

配置文件路径：

- 默认 profile：`~/.openclaw/openclaw.json`
- dev profile：`~/.openclaw-dev/openclaw.json`

示例配置：

```json
{
  "agents": {
    "defaults": {
      "model": "openai-codex/gpt-5.3-codex"
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
      "runTimeoutMs": 300000,
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

最少需要确认这些字段是正确的：

- `channels.message-bridge.gateway.url`
- `channels.message-bridge.auth.ak`
- `channels.message-bridge.auth.sk`

`setup` / `onboarding` 当前只支持写入这些字段：

- `channels.message-bridge.name`
- `channels.message-bridge.gateway.url`
- `channels.message-bridge.auth.ak`
- `channels.message-bridge.auth.sk`

以下注册元数据不允许用户配置，统一由运行时采集：

- `toolType` 默认值为 `openx`
- `toolVersion` 来自插件运行时包版本
- `deviceName`、`os`、`macAddress` 由 `gateway-client` 在构造 register payload 时统一派生

当前插件内置已知 `toolType` 仅 `openx`。若注入其他值，会记录 `runtime.register.tool_type.unknown` 警告日志，但不会阻断连接。

当前阶段默认 `runTimeoutMs` 已提高到 `300000`，它当前同时作用于两条执行链：

- `dispatchReplyWithBufferedBlockDispatcher(... replyOptions.timeoutOverrideSeconds)`
- `subagent.waitForRun(... timeoutMs)`

如果你没有显式配置 `runTimeoutMs`，插件会使用这个更保守的默认值；如果你已经在配置里写了该字段，则继续以你的显式值为准。

如果你想进一步调细 block 级 streaming，再按需补充：

```json
{
  "agents": {
    "defaults": {
      "blockStreamingChunk": {
        "minChars": 20,
        "maxChars": 80,
        "breakPreference": "sentence"
      },
      "blockStreamingCoalesce": {
        "minChars": 20,
        "maxChars": 80,
        "idleMs": 150
      }
    }
  }
}
```

说明：`channels.message-bridge.blockStreaming` 已移除，不再支持；插件只认 `channels.message-bridge.streaming` 作为流式开关。

当前文本流式行为（v0.7）：

- `runtime_reply` 主路径：
  - `deliver(kind=block)` 会实时上送（首块 `message.part.updated`，后续 `message.part.delta`）。
  - `deliver(kind=final)` 只做缓存，结束时统一收敛，不直接作为增量上送。
- `subagent_fallback` 回退路径：
  - 显式非流式（`deliver:false`），只在完成时回填最终文本。

新增观测字段（日志）：

- `streamMode`
  - `runtime_block_streaming`
  - `fallback_non_streaming`
- `streamingEnabled`
  - `true`: 插件启用流式主路径
  - `false`: 插件显式关闭流式，强制走非流式输出模式
- `streamingSource`
  - `default_on` / `explicit_on` / `explicit_off`
- `streamDefaultsInjected`
  - `true`: 本次请求由插件注入默认流式 profile（仅缺失字段）
  - `false`: 使用用户显式配置或流式被关闭
- `finalReconciled`
  - `true`：最终文本与流式累计文本不一致，完成时采用 final 覆盖
  - `false`：最终文本与累计文本一致（或可直接前缀补齐）

## 8. 启动

dev profile：

```bash
openclaw --dev gateway run --allow-unconfigured --verbose
```

默认 profile：

```bash
openclaw gateway run --allow-unconfigured --verbose
```

健康启动后应能看到：

- 插件被加载
- `message-bridge` channel account 启动
- 网关连接进入 ready 状态

## 9. 联调验证

### 9.1 校验注册和心跳

查看 `ai-gateway` 日志，确认：

- agent 注册成功
- `toolType=openx`
- 心跳持续正常

当前本机日志路径：

- `<repo-root>/integration/opencode-cui/logs/local-stack/ai-gateway.log`

OpenClaw 自身文件日志（插件日志也在其中）默认路径：

- macOS/Linux：`/tmp/openclaw/openclaw-YYYY-MM-DD.log`
- Windows：`%TEMP%\\openclaw\\openclaw-YYYY-MM-DD.log`

常用查看命令与输出说明：

```bash
# 1) 实时看 OpenClaw 文件日志（推荐，跨平台）
openclaw logs --follow
```

- 会打印结构化日志行（pretty/compact），能看到 `gateway.*`、`runtime.*`、`bridge.chat.*` 事件名。

```bash
# 2) 机器可读 JSON 输出
openclaw logs --follow --json
```

- 会打印 JSON 行对象，常见 `type`：`meta` / `log` / `notice` / `raw`。
- `type=log` 时可看到 `level/subsystem/message/...meta字段`。

```bash
# 3) 直接跟踪 ai-gateway 日志（本地联调）
tail -f <repo-root>/integration/opencode-cui/logs/local-stack/ai-gateway.log
```

- 会打印 ai-gateway 收发与转发日志，适合看 Redis 下行与上行 `tool_event/tool_done/tool_error` 记录。

Windows（PowerShell）等价命令：

```powershell
Get-Content "$env:TEMP\\openclaw\\openclaw-$(Get-Date -Format yyyy-MM-dd).log" -Wait
Get-Content "C:\\path\\to\\opencode-CUI\\logs\\local-stack\\ai-gateway.log" -Wait
```

### 9.2 校验状态查询

```bash
redis-cli publish agent:test-ak-openclaw-001 '{"type":"status_query"}'
```

预期：

- `ai-gateway` 收到 `status_response`

### 9.3 校验聊天链路

```bash
redis-cli publish agent:test-ak-openclaw-001 '{"type":"invoke","action":"chat","welinkSessionId":"welink-openclaw-verify-001","payload":{"toolSessionId":"tool-openclaw-verify-001","text":"Reply with exactly: hello from openclaw bridge verification"}}'
```

预期：

- 下行 `invoke`
- 上行 `tool_event`
- 最终 `tool_done`

如果模型正常返回，还可以在 OpenClaw session 文件中看到 assistant 落盘内容。

## 10. 常见问题

### 10.1 新建会话没有回复

阶段一修复后，插件默认 `runTimeoutMs` 已提高到 `300000`。如果新建会话仍然没有回复，先按这个顺序看 OpenClaw 日志：

- `bridge.chat.started`
- `bridge.chat.model_selected`
- `bridge.chat.first_chunk`
- `bridge.chat.failed`
- `embedded run agent end: ... LLM request timed out.`

如果有，说明：

- 只有 `bridge.chat.started`：插件已收到请求，但还没进入可见回复阶段
- 有 `bridge.chat.model_selected`，没有 `bridge.chat.first_chunk`：通常是首块过慢或首块前 timeout
- 出现 `bridge.chat.failed`：看其中的 `failureStage`、`errorCategory`、`configuredTimeoutMs`
- 同时出现 `embedded run agent end: ... LLM request timed out.`：问题在模型请求超时，不在插件安装

当前阶段不调整模型路由策略，只修桥接层 timeout 与诊断链路。

### 10.2 有 `tool_event`，但没有可见流式文本

当前插件只支持 block 级 streaming。

另外，是否真正看到流式，还取决于：

- OpenClaw 首块文本是否及时产出
- 当前模型是否超时
- 当前 session 上下文是否过大

### 10.3 出现 `loaded without install/load-path provenance`

这是本地开发扩展的 provenance warning。

影响：

- 不影响功能

原因：

- 插件是从本地扩展目录直接加载的，不是正式安装记录

### 10.4 启动时报 `ANTHROPIC_MODEL_ALIASES before initialization`

优先怀疑安装产物中混入了私有 `node_modules/openclaw`，而不是配置字段本身错误。

先检查：

- `openclaw --version`
- 插件目录下是否存在 `node_modules/openclaw`

如果同时存在宿主 OpenClaw 和插件私有 OpenClaw 两套版本，Node 可能优先解析插件目录中的旧版本，导致启动期模块初始化冲突。

## 11. 建议的交付方式

开发环境建议：

- 优先用“目录复制安装”
- 如果需要高频改动和调试，用“符号链接安装”

需要嵌入式交付时建议：

- 使用 `npm run build:bundle`
- 交付单个 `index.js` + `package.json` + `openclaw.plugin.json`

这样目标环境不需要复制整套源码目录，只需要最小插件文件集。
