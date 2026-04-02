# Message-Bridge OpenCode 集成指导

**Version:** 1.6  
**Date:** 2026-04-01  
**Status:** Active  
**Owner:** message-bridge maintainers  
**Related:** `../../README.md`, `../README.md`, `../design/interfaces/config-contract.md`, `./npm-publish-guide.md`

面向通过 `@opencode-ai/sdk` 代码方式集成 OpenCode 的应用方，说明如何接入 `message-bridge` 插件。

## 1. 插件接入方式

在启动 OpenCode 之前，通过 `process.env.OPENCODE_CONFIG_CONTENT` 声明插件：

```js
process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
  $schema: 'https://opencode.ai/config.json',
  plugin: ['@opencode-cui/message-bridge'],
});
```

如果需要本地联调，也可以改为本地目录：

```js
process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
  $schema: 'https://opencode.ai/config.json',
  plugin: ['file:///absolute/path/to/plugins/message-bridge'],
});
```

## 2. 环境变量配置

在启动 OpenCode 之前，通过 `process.env` 准备以下配置：

| 配置项 | 环境变量 | 是否必须 | 说明 |
|---|---|---|---|
| `ak` | `BRIDGE_AUTH_AK` | 是 | 插件鉴权 AK |
| `sk` | `BRIDGE_AUTH_SK` | 是 | 插件鉴权 SK |
| `channel` | `BRIDGE_GATEWAY_CHANNEL` | 是 | 填写应用别名，用于标识当前接入应用 |
| `gateway.url` | `BRIDGE_GATEWAY_URL` | 否 | 生产环境通常不需要配置；切换到 UAT 等非生产环境时再显式填写 |
| `directory` | `BRIDGE_DIRECTORY` | 否 | 按需配置，用于指定插件目录上下文 |

如果应用希望把 bridge 用户级配置与原生 OpenCode 隔离，还需要显式设置：

| 配置项 | 环境变量 | 是否必须 | 说明 |
|---|---|---|---|
| `bridge user config root` | `OPENCODE_CONFIG_DIR` | 建议 | 作为 `message-bridge.jsonc|json` 的用户级硬隔离目录 |

`auth` 凭证读取补充：

- 当 `BRIDGE_GATEWAY_CHANNEL` 显式设置（`trim()` 后非空）时，`BRIDGE_AUTH_AK` 与 `BRIDGE_AUTH_SK` 只能通过环境变量提供，本地配置中的 `auth.ak/sk` 不参与回退。
- 当 `BRIDGE_GATEWAY_CHANNEL` 未设置或仅空白时，`BRIDGE_AUTH_AK` 与 `BRIDGE_AUTH_SK` 只有“同时提供”才会覆盖本地；若只提供一项，会整体回退本地 `auth.ak/sk`。

最小示例：

```js
process.env.BRIDGE_AUTH_AK = 'your-ak';
process.env.BRIDGE_AUTH_SK = 'your-sk';
process.env.BRIDGE_GATEWAY_CHANNEL = 'your-app-alias';
process.env.OPENCODE_CONFIG_DIR = '/absolute/path/to/third-party-opencode-config';
```

UAT 示例：

```js
process.env.BRIDGE_AUTH_AK = 'your-ak';
process.env.BRIDGE_AUTH_SK = 'your-sk';
process.env.BRIDGE_GATEWAY_CHANNEL = 'your-app-alias';
process.env.BRIDGE_GATEWAY_URL = 'wss://gateway-uat.example.com/ws/agent';
process.env.OPENCODE_CONFIG_DIR = '/absolute/path/to/third-party-opencode-config';
```

隔离规则补充：

- `OPENCODE_CONFIG_DIR` 一旦设置，`message-bridge` 的用户级配置只从该目录读取，不再回退 `~/.config/opencode`
- `OPENCODE_CONFIG` 不会改变 bridge 的用户级配置目录；仅设置它不能解决第三方宿主与原生 OpenCode 的配置污染问题

## 3. `.npmrc` 要求

如果使用 npm 包方式接入，必须提前准备 `.npmrc`：

```ini
@opencode-cui:registry=https://<your-private-registry>/
registry=https://registry.npmjs.org/
strict-ssl=false
```

说明：

- `@opencode-cui:registry`：指定 `@opencode-cui` 走企业二方仓
- `registry`：保留公共 npm 默认源
- `strict-ssl=false`：在企业私仓证书链不完整时禁用 SSL 校验，避免启动阶段拉包失败

## 4. 启动与生效限制

所有插件相关配置都必须在启动 OpenCode 之前完成，包括：

- `process.env.OPENCODE_CONFIG_CONTENT`
- `BRIDGE_AUTH_AK`
- `BRIDGE_AUTH_SK`
- `BRIDGE_GATEWAY_CHANNEL`
- `BRIDGE_GATEWAY_URL`（如有）
- `BRIDGE_DIRECTORY`（如有）
- `OPENCODE_CONFIG_DIR`（如需用户级配置隔离）
- `.npmrc`

配置变更后需要重启 OpenCode 才会生效，包括：

- 插件声明变更
- bridge 环境变量变更
- `.npmrc` 变更

一句话原则：

**先配置，再启动；修改后重启。**

## 5. 代码示例

```js
import { createOpencode } from '@opencode-ai/sdk';

process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
  $schema: 'https://opencode.ai/config.json',
  plugin: ['@opencode-cui/message-bridge'],
});

process.env.BRIDGE_AUTH_AK = 'your-ak';
process.env.BRIDGE_AUTH_SK = 'your-sk';
process.env.BRIDGE_GATEWAY_CHANNEL = 'your-app-alias';
process.env.OPENCODE_CONFIG_DIR = '/absolute/path/to/third-party-opencode-config';

const { server } = await createOpencode({
  hostname: '127.0.0.1',
  port: 4096,
});

// 启动完成后查看 OpenCode / 插件日志，确认插件已加载

server.close();
```

## 6. FAQ

### 6.1 如何判断插件已加载成功

启动后可通过日志确认插件加载结果。

常见日志目录：

- macOS：`~/.local/share/opencode/log/`
- Windows：`%USERPROFILE%\.local\share\opencode\log`

搜索 `message-bridge` 相关日志。成功时，日志中应至少出现以下事件之一：

- `runtime.singleton.initialized`
- `runtime.start.completed`
- `gateway.ready`

失败时，优先检查以下日志：

- `plugin.init.failed_non_fatal`
- `failed to load plugin`

### 6.2 插件包下载失败怎么排查

优先检查以下几项：

- `.npmrc` 是否已配置 `@opencode-cui` 二方仓地址
- 企业私仓是否要求禁用 SSL 校验
- 以上配置是否都在 OpenCode 启动前完成

如果首次通过 `npx` 无法拉取安装器包，可先使用私仓 bootstrap 命令执行安装：

```bash
npx -y --registry=https://cmc.centralrepo.rnd.huawei.com/artifactory/api/npm/product_npm/ @wecode/skill-opencode-plugin install
```

OpenCode 的插件下载与依赖缓存目录：

- macOS：`~/.cache/opencode/node_modules/`
- Windows：`%USERPROFILE%\.cache\opencode\node_modules\`

如果插件下载或安装卡住，也可以直接检查或清理缓存目录：

- macOS：`~/.cache/opencode`
- Windows：`%USERPROFILE%\.cache\opencode`
