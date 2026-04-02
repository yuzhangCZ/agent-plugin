# 配置契约

**Version:** 2.5
**Date:** 2026-04-01
**Status:** Active
**Owner:** message-bridge maintainers
**Related:** `../../product/prd.md`, `../../architecture/overview.md`, `./protocol-contract.md`

本文档以当前代码实现为准，描述 `message-bridge` 已支持的配置项、环境变量、默认值、校验规则与兼容约束。

## In Scope

- 插件侧用户级配置根解析
- `message-bridge.jsonc|json` 的发现顺序、优先级与环境变量覆盖规则
- 第三方宿主通过 `OPENCODE_CONFIG_DIR` 实现用户级 bridge 配置隔离

## Out of Scope

- OpenCode 自身配置文件的完整合并语义
- setup/install CLI 的配置写入路径
- 服务端或 gateway 侧的配置发现逻辑

## External Dependencies

- OpenCode 宿主需把 `OPENCODE_CONFIG_DIR` 传递到插件运行环境
- 若宿主仅设置 `OPENCODE_CONFIG`，插件只会记录诊断 warning，不会把它当作 bridge 配置根

## 1. 配置来源与优先级

配置按以下顺序覆盖，后者优先级更高：

1. 内建默认值
2. 用户级配置
   - 若设置 `OPENCODE_CONFIG_DIR`
     - `$OPENCODE_CONFIG_DIR/message-bridge.jsonc`
     - `$OPENCODE_CONFIG_DIR/message-bridge.json`
   - 否则
     - `~/.config/opencode/message-bridge.jsonc`
     - `~/.config/opencode/message-bridge.json`
3. 项目级配置
   - `<workspace>/.opencode/message-bridge.jsonc`
   - `<workspace>/.opencode/message-bridge.json`
4. 环境变量 `BRIDGE_*`

补充规则：

- 同一目录下若 `.jsonc` 与 `.json` 同时存在，优先读取 `.jsonc`
- 当设置 `OPENCODE_CONFIG_DIR` 时，用户级 bridge 配置只从该目录读取，不再回退默认 `~/.config/opencode`
- 项目级配置会从 `workspacePath` 或 `process.cwd()` 开始，沿父目录向上查找，直到文件系统根目录
- 配置文件支持 JSONC，包括注释与尾逗号
- `auth.ak` / `auth.sk` 在环境变量层采用成对（原子）解析策略，且会受 `BRIDGE_GATEWAY_CHANNEL` 是否显式设置影响（见第 6.1 节）
- `OPENCODE_CONFIG` 不参与 bridge 用户级配置定位；若仅设置该变量，配置层会记录 `config.user_config.opencode_config_ignored` warning

## 2. 默认值

默认值定义于 `src/config/default-config.ts`。其中 `gateway.url` 通过 `src/config/default-gateway-url.ts` 统一提供：构建阶段仅在显式设置 `MB_DEFAULT_GATEWAY_URL` 时注入覆盖值；未注入时继续使用源码默认值，并最终回退到 localhost。

| 配置键 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 是否启用 bridge |
| `config_version` | `1` | 配置版本 |
| `gateway.url` | 默认来源于 `default-config` 链路；显式设置 `MB_DEFAULT_GATEWAY_URL` 时使用注入值，否则回退到 `ws://localhost:8081/ws/agent` | Gateway WebSocket 地址 |
| `gateway.channel` | `openx` | 配置侧字段名；注册报文中映射到 `toolType` |
| `gateway.heartbeatIntervalMs` | `30000` | 心跳间隔，单位毫秒 |
| `gateway.reconnect.baseMs` | `1000` | 重连基础退避，单位毫秒 |
| `gateway.reconnect.maxMs` | `30000` | 重连最大退避，单位毫秒 |
| `gateway.reconnect.exponential` | `true` | 是否启用指数退避 |
| `gateway.reconnect.jitter` | `full` | 重连抖动策略；`full` 表示在 `0..cappedDelay` 间随机 |
| `gateway.reconnect.maxElapsedMs` | `600000` | 单轮自动重连总时长上限，单位毫秒 |
| `gateway.ping.intervalMs` | `30000` | 保留字段，当前未见运行时消费 |
| `sdk.timeoutMs` | `10000` | SDK 调用超时，单位毫秒 |
| `auth.ak` | `""` | Access Key，启用时必填 |
| `auth.sk` | `""` | Secret Key，启用时必填 |
| `events.allowlist` | `DEFAULT_EVENT_ALLOWLIST` | 上行事件白名单 |
| `debug` | `false` | 关闭原始 WebSocket 报文日志与额外调试输出 |

## 3. 最小可用配置

```jsonc
{
  "auth": {
    "ak": "your-access-key",
    "sk": "your-secret-key"
  }
}
```

如果需要显式关闭 bridge：

```jsonc
{
  "enabled": false
}
```

## 4. 完整配置结构

```jsonc
{
  "enabled": true,
  "debug": false,
  "config_version": 1,
  "gateway": {
    "url": "wss://gateway.example.com/ws/agent",
    "channel": "openx",
    "heartbeatIntervalMs": 30000,
    "reconnect": {
      "baseMs": 1000,
      "maxMs": 30000,
      "exponential": true
    },
    "ping": {
      "intervalMs": 30000
    }
  },
  "sdk": {
    "timeoutMs": 10000
  },
  "auth": {
    "ak": "your-access-key",
    "sk": "your-secret-key"
  },
  "events": {
    "allowlist": [
      "message.updated",
      "session.status"
    ]
  }
}
```

## 5. 配置项说明

| 配置键 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `enabled` | `boolean` | 否 | `true` | 为 `false` 时安全禁用，且不要求 `auth.ak/sk` |
| `debug` | `boolean` | 否 | `false` | 调试日志开关；开启后额外以 `info` 级输出可读的原始 WebSocket 上下行报文 |
| `config_version` | `number` | 否 | `1` | 当前只支持 `1` |
| `gateway.url` | `string` | 否 | 默认来源于 `default-config` 链路；显式设置 `MB_DEFAULT_GATEWAY_URL` 时使用注入值，否则回退到 `ws://localhost:8081/ws/agent` | 必须以 `ws://` 或 `wss://` 开头 |
| `gateway.channel` | `string` | 否 | `openx` | 注册消息中的 `toolType` 来源；内置已知值为 `openx`、`uniassistant`、`codeagent` |
| `gateway.heartbeatIntervalMs` | `number` | 否 | `30000` | 正整数 |
| `gateway.reconnect.baseMs` | `number` | 否 | `1000` | 正整数 |
| `gateway.reconnect.maxMs` | `number` | 否 | `30000` | 正整数 |
| `gateway.reconnect.exponential` | `boolean` | 否 | `true` | 是否指数退避 |
| `gateway.reconnect.jitter` | `'none' \| 'full'` | 否 | `full` | `full` 会在 `0..cappedDelay` 间随机 |
| `gateway.reconnect.maxElapsedMs` | `number` | 否 | `600000` | 正整数；表示单轮自动重连总时长 |
| `gateway.ping.intervalMs` | `number` | 否 | `30000` | 当前仅配置层存在，未见运行时消费 |
| `sdk.timeoutMs` | `number` | 否 | `10000` | 正整数 |
| `auth.ak` | `string` | 条件必填 | `""` | `enabled !== false` 时必填 |
| `auth.sk` | `string` | 条件必填 | `""` | `enabled !== false` 时必填 |
| `events.allowlist` | `string[]` | 否 | `DEFAULT_EVENT_ALLOWLIST` | 仅允许精确事件名，不支持通配符 |

## 6. 环境变量映射

| 环境变量 | 映射配置键 | 说明 |
|---|---|---|
| `BRIDGE_ENABLED` | `enabled` | 仅当值为 `true` 时解析为 `true`，其余值解析为 `false` |
| `BRIDGE_DEBUG` | `debug` | 仅当值为 `true` 时解析为 `true`，其余值解析为 `false`；开启后额外输出原始 WebSocket 报文 |
| `BRIDGE_CONFIG_VERSION` | `config_version` | 使用 `parseInt(..., 10)` 解析 |
| `BRIDGE_GATEWAY_URL` | `gateway.url` | 支持 `${VAR_NAME}` 替换 |
| `BRIDGE_GATEWAY_CHANNEL` | `gateway.channel` | 支持 `${VAR_NAME}` 替换；会在归一化阶段 `trim()` |
| `BRIDGE_GATEWAY_RECONNECT_BASE_MS` | `gateway.reconnect.baseMs` | 使用 `parseInt(..., 10)` 解析 |
| `BRIDGE_GATEWAY_RECONNECT_MAX_MS` | `gateway.reconnect.maxMs` | 使用 `parseInt(..., 10)` 解析 |
| `BRIDGE_GATEWAY_RECONNECT_EXPONENTIAL` | `gateway.reconnect.exponential` | 仅当值为 `true` 时解析为 `true` |
| `BRIDGE_GATEWAY_RECONNECT_JITTER` | `gateway.reconnect.jitter` | 仅接受 `none` 或 `full` |
| `BRIDGE_GATEWAY_RECONNECT_MAX_ELAPSED_MS` | `gateway.reconnect.maxElapsedMs` | 使用 `parseInt(..., 10)` 解析 |
| `BRIDGE_GATEWAY_HEARTBEAT_INTERVAL_MS` | `gateway.heartbeatIntervalMs` | 优先于兼容别名 |
| `BRIDGE_EVENT_HEARTBEAT_INTERVAL_MS` | `gateway.heartbeatIntervalMs` | 兼容别名；仅在前者不存在时生效 |
| `BRIDGE_GATEWAY_PING_INTERVAL_MS` | `gateway.ping.intervalMs` | 当前仅配置层存在，未见运行时消费 |
| `BRIDGE_AUTH_AK` | `auth.ak` | 支持 `${VAR_NAME}` 替换；是否生效受第 6.1 节规则约束 |
| `BRIDGE_AUTH_SK` | `auth.sk` | 支持 `${VAR_NAME}` 替换；是否生效受第 6.1 节规则约束 |
| `BRIDGE_SDK_TIMEOUT_MS` | `sdk.timeoutMs` | 使用 `parseInt(..., 10)` 解析 |
| `BRIDGE_EVENTS_ALLOWLIST` | `events.allowlist` | 以逗号分隔并逐项 `trim()` |
| `BRIDGE_ASSISTANT_DIRECTORY_MAP_FILE` | 运行时目录映射文件路径 | 指向对象 key 映射 JSON 文件，形如 `{ "<assistantId>": { "directory": "<path>" } }`；根 key 表示下行协议中的 `assistantId`，运行期更新文件后后续请求可见；旧平铺格式与其他非法条目都会记录 warning，但不会阻断同文件合法条目生效，也不会阻断请求回退 |

宿主侧用户级配置根相关变量：

| 环境变量 | 是否参与 bridge 配置定位 | 说明 |
|---|---|---|
| `OPENCODE_CONFIG_DIR` | 是 | 作为 bridge 用户级配置的硬隔离根 |
| `OPENCODE_CONFIG` | 否 | 仅用于诊断；单独设置时会记录 warning，不会改变 bridge 用户级配置目录 |

### 6.1 `auth.ak` / `auth.sk` 解析规则（与 `BRIDGE_GATEWAY_CHANNEL` 关联）

`auth.ak` 与 `auth.sk` 按“成对凭证”处理，不支持半覆盖混用来源。

| 条件 | `auth.ak/sk` 来源策略 | 结果 |
|---|---|---|
| `BRIDGE_GATEWAY_CHANNEL` 显式设置（`trim()` 后非空） | 仅读取 `BRIDGE_AUTH_AK` + `BRIDGE_AUTH_SK` | 任一缺失会注入空串，随后按现有校验失败（`MISSING_REQUIRED`） |
| `BRIDGE_GATEWAY_CHANNEL` 未设置或仅空白，且环境变量同时提供 `AK+SK` | 使用环境变量整体覆盖本地配置 | 最终取环境变量成对值 |
| `BRIDGE_GATEWAY_CHANNEL` 未设置或仅空白，且环境变量未同时提供 `AK+SK` | 不注入环境变量凭证 | 完整回退到本地配置中的 `auth.ak/sk`（成对回退） |

环境变量示例：

```bash
BRIDGE_ENABLED=true
BRIDGE_AUTH_AK=your-access-key
BRIDGE_AUTH_SK=your-secret-key
BRIDGE_GATEWAY_URL=ws://gateway.example.com/ws/agent
BRIDGE_GATEWAY_CHANNEL=openx
BRIDGE_GATEWAY_RECONNECT_BASE_MS=1000
BRIDGE_GATEWAY_RECONNECT_MAX_MS=30000
BRIDGE_SDK_TIMEOUT_MS=10000
BRIDGE_EVENTS_ALLOWLIST=message.updated,session.status
BRIDGE_ASSISTANT_DIRECTORY_MAP_FILE=/path/to/assistant-directory-map.json
```

补充说明：

- `MB_DEFAULT_GATEWAY_URL` 是构建期注入变量，不属于运行时 `BRIDGE_*` 环境变量集合
- `BRIDGE_GATEWAY_URL` 仍然是最高优先级的运行时覆盖入口
- 环境变量名 `BRIDGE_ASSIANT_DIRECTORY_MAP_FILE` 保留历史拼写；运行时特殊通道值已收敛为 `uniassistant`
- `BRIDGE_GATEWAY_CHANNEL` 是唯一有效的通道环境变量入口；`BRIDGE_CHANNEL` 已移除，当前实现会忽略它
- 下行协议公开字段已经统一为 `assistantId`
- 旧协议字段 `assiantId` 已废弃，当前会被静默忽略，不再触发目录映射或 `agent` 透传

## 7. 兼容与废弃约束

当前实现包含以下兼容或清理规则：

- `BRIDGE_AK` / `BRIDGE_SK` 不再支持
- `BRIDGE_CHANNEL` 不再支持
- `BRIDGE_EVENT_HEARTBEAT_INTERVAL_MS` 仍兼容旧心跳变量命名
- `BRIDGE_GATEWAY_TOOL_TYPE` 已移除，当前实现会忽略它
- `BRIDGE_GATEWAY_DEVICE_NAME`
- `BRIDGE_GATEWAY_MAC_ADDRESS`
- `BRIDGE_GATEWAY_TOOL_VERSION`

上面三个 `gateway` 元数据相关环境变量已移除，当前实现会忽略它们。注册时使用的 `deviceName`、`macAddress`、`toolVersion` 由运行时自动采集，不属于可配置项。

## 8. 校验规则

当前代码已实现的校验规则：

- 根配置必须是对象
- `config_version` 必须为 `1`
- `enabled` 必须为 `boolean`
- `gateway.url` 必须以 `ws://` 或 `wss://` 开头
- `gateway.reconnect.baseMs` 必须为正整数
- `gateway.reconnect.maxMs` 必须为正整数
- `gateway.reconnect.maxElapsedMs` 必须为正整数
- `gateway.heartbeatIntervalMs` 必须为正整数
- `sdk.timeoutMs` 必须为正整数
- `events.allowlist` 必须为字符串数组
- `events.allowlist` 每一项都必须是受支持的精确事件名
- 当 `enabled !== false` 时，`auth.ak` 与 `auth.sk` 必填

当前未见独立校验的字段：

- `debug`
- `gateway.channel`
- `gateway.reconnect.exponential`
- `gateway.reconnect.jitter`

补充说明：

- `exponential=true` 表示按指数增长重连间隔，再受 `maxMs` 截断
- `maxElapsedMs` 表示单轮自动重连总时长，而不是单次等待时间
- `gateway.ping.intervalMs`
- `BRIDGE_ASSISTANT_DIRECTORY_MAP_FILE`

## 9. 默认白名单

默认 `events.allowlist` 包含：

- `message.updated`
- `message.part.updated`
- `message.part.delta`
- `message.part.removed`
- `session.status`
- `session.idle`
- `session.updated`
- `session.error`
- `permission.updated`
- `permission.asked`
- `question.asked`

不支持通配符事件模式。

## 10. 日志事件

配置加载与校验阶段会产生日志事件：

- `config.resolve.started`
- `config.source.loaded`
- `config.resolve.completed`
- `config.env.snapshot`
- `config.user_config.opencode_config_ignored`
- `config.source.load_failed`
- `config.validation.passed`
- `config.validation.failed`

其中 `config.env.snapshot` 固定以 `info` 级输出，不受 `debug` 开关影响；敏感字段仍按统一日志脱敏规则处理。

当 `debug=true` 时，连接层还会额外输出以下 `info` 级原始报文日志：

- `「onOpen」===>「...」`
- `「onMessage」===>「...」`
- `「onError」===>「...」`
- `「sendMessage」===>「...」`
