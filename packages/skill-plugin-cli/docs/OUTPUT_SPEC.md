# skill-plugin-cli 终端输出规格

## 1. 标题与目标

本文档是 `skill-plugin-cli` 终端输出的内部规格基线，用于约束实现与测试，不承担对外说明职责。

- 文档作用域仅覆盖 `skill-plugin-cli` 的用户可见终端输出。
- 文档直接定义最终文本输出格式，而不记录讨论过程。
- `OUTPUT-SPEC.md` 是唯一权威规格；后续实现与测试都从它派生。
- 本次不要求同步修改 `README.md`。

## 2. 通用规则

### 2.1 基本原则

- `--url` 定义为“指定插件连接 gateway 的地址”。
- 默认流程文案统一，不拆成两套流程。
- `opencode/openclaw` 的差异仅体现在宿主名、插件名、版本信息、配置路径和 next step。
- 成功结论统一使用“接入完成”，不使用“安装完成”。
- 扫码后状态文案统一为：`请在 WeLink 中创建助理`。

### 2.2 默认模式禁用项

默认模式禁止出现以下内部术语或冗余表达：

- `宿主配置接入`
- `结果确认`
- `结束收口`
- `可用`
- 两条语义等价的安装开始提示

### 2.3 配置路径规则

- 默认模式展示宿主主配置路径。
- 配置路径展示当前平台解析后的真实路径，不使用 `~` 缩写。
- 文档示例同时覆盖 Unix/mac 与 Windows 风格路径。
- 多文件写入场景下，默认模式只展示宿主主配置路径。
- 附加配置路径仅在 `--verbose` 或相关失败场景展示。

### 2.4 时间格式规则

- 标签固定为：`二维码有效期至:`
- 时间格式固定为：`YYYY-MM-DD HH:mm:ss UTC`
- 默认模式与 `--verbose` 使用同一时间格式。
- 不直接输出原始 ISO 8601 字符串。
- 不按本地时区差异化展示。

### 2.5 二维码块占位规则

- 文档中的 `<二维码渲染块>` 为结构占位，不是实际终端字面输出。
- 规格要求该位置必须存在二维码 ASCII 块或等价二维码文本表示。
- 当二维码 ASCII 渲染失败时，等价文本表示固定为：`weUrl: <url>`。
- 自动化测试不逐字断言二维码图案本身。
- 自动化测试只断言二维码块前后文案和二维码块存在性。
- 刷新场景必须重新输出新的二维码块。

## 3. 默认模式文本输出格式

### 3.1 固定模板

- 开始安装：
  - `正在为 <host> 安装 <packageName>，请稍候`
- 版本信息：
  - openclaw：`openclaw 版本：<version>`
  - opencode：默认不输出版本
- 配置路径：
  - openclaw：`openclaw 配置路径: <resolvedPath>`
  - opencode：`opencode 配置路径: <resolvedPath>`
- 插件安装完成：
  - `插件安装完成`
- 创建助理开始：
  - `请使用 WeLink 扫码创建助理`
- 二维码块：
  - `<二维码渲染块>`
  - 或在渲染失败时输出：`weUrl: <url>`
  - `pc WeLink 创建助理地址: <pcUrl>`
  - `二维码有效期至: <formattedTime>`
  - `请在 WeLink 中创建助理`
- 助理创建完成：
  - `助理创建完成，正在写入 <host> 连接配置`
- 可用性检查完成：
  - `已完成连接可用性检查`
- 成功结论：
  - `接入完成：<host> 已完成插件安装、助理创建与 gateway 配置`

### 3.2 next step

- openclaw：
  - `下一步：请手动重启 openclaw gateway 以使新配置生效`
  - `可执行命令：openclaw gateway restart`
- opencode：
  - `下一步：请重启 opencode 以使插件与配置生效`

### 3.3 openclaw 版本失败前置规则

- 当 `openclaw` 版本不满足最低要求时，默认模式输出顺序固定为：
  - `正在为 openclaw 安装 <packageName>，请稍候`
  - `openclaw 版本：<version>`
  - `接入失败：当前 openclaw 版本 <version> 不满足 >= <minimumRequiredVersion>`
- 该场景不得输出 `openclaw 配置路径: ...`

## 4. `--verbose` 文本输出格式

### 4.1 阶段日志

`--verbose` 模式保留阶段开始/完成日志，阶段文案固定为：

- `解析安装参数`
- `检查 <host> 环境`
- `准备 npm 仓源配置`
- `安装插件 <packageName>`
- `校验插件安装结果`
- `执行 WeLink 创建助理`
- `写入 <host> 连接配置`
- `检查连接可用性`

### 4.2 参数摘要

`--verbose` 允许输出参数摘要：

- `environment=<env>, registry=<registry>, url=<url>`

### 4.3 命令执行边界

`--verbose` 中执行命令的提示固定为：

- `正在执行命令：<完整命令>`
- 后面直接接命令原始输出
- `命令执行结束：<完整命令>`

## 5. 错误摘要与二维码刷新规则

### 5.1 二维码刷新规则

- 初始二维码不计入刷新次数。
- 每次因过期生成新二维码时，刷新计数递增 1。
- 终端输出必须展示刷新次数，格式固定为：`第 N/M 次`。
- 规格不限定刷新计数由 CLI 维护还是由 `skill-qrcode-auth` 提供，只要求最终输出一致。
- 刷新前固定输出：`二维码已过期，正在刷新`
- 刷新标题固定为：`========= 已刷新二维码（第 N/M 次） =========`
- 刷新后必须重新输出完整二维码块：
  - `<二维码渲染块>`
  - 或在渲染失败时输出：`weUrl: <url>`
  - `pc WeLink 创建助理地址: <pcUrl>`
  - `二维码有效期至: <formattedTime>`
  - `请在 WeLink 中创建助理`

### 5.2 网络错误摘要

- 默认模式二维码失败始终输出一条 `错误摘要：...`
- 网络错误摘要固定顺序：
  - `network_error, code=<code>, message=<message>`
- 字段缺失时省略缺失段。
- 最小兜底摘要固定保留为：
  - `network_error`

### 5.3 服务端错误摘要

- 默认模式二维码失败始终输出一条 `错误摘要：...`
- 服务端错误摘要固定顺序：
  - `businessCode=<businessCode>, error=<error>, message=<message>, httpStatus=<httpStatus>`
- 字段缺失时省略缺失段。
- 最小兜底摘要固定保留为：
  - `auth_service_error`

### 5.4 参数错误

- 参数错误统一追加：
  - `可执行 skill-plugin-cli --help 查看用法`

## 6. 场景示例

### 6.1 `--help`

```text
skill-plugin-cli

用于安装插件、创建 WeLink 助理，并完成与 gateway 的连接配置。

用法:
  skill-plugin-cli install --host opencode [--environment uat|prod] [--registry <url>] [--url <gateway-url>] [--verbose]
  skill-plugin-cli install --host openclaw [--environment uat|prod] [--registry <url>] [--url <gateway-url>] [--verbose]

示例:
  skill-plugin-cli install --host opencode
  skill-plugin-cli install --host openclaw --environment uat
  skill-plugin-cli install --host openclaw --url ws://localhost:8081/ws/agent
  skill-plugin-cli install --host opencode --verbose

参数:
  --host <opencode|openclaw>   指定接入目标
  --environment <uat|prod>     指定 WeLink 创建助理环境，默认 prod
  --registry <url>             指定 @wecode npm 仓源
  --url <gateway-url>          指定插件连接 gateway 的地址
  --verbose                    显示详细执行过程
  -h, --help                   查看帮助
```

### 6.2 默认成功流：openclaw

```text
[skill-plugin-cli] 正在为 openclaw 安装 @wecode/skill-openclaw-plugin，请稍候
[skill-plugin-cli] openclaw 版本：2026.4.10
[skill-plugin-cli] openclaw 配置路径: /Users/you/.openclaw/openclaw.json
[skill-plugin-cli] 插件安装完成
[skill-plugin-cli] 请使用 WeLink 扫码创建助理
<二维码渲染块>
[skill-plugin-cli] pc WeLink 创建助理地址: https://pc.example/qr-1
[skill-plugin-cli] 二维码有效期至: 2026-04-28 08:00:00 UTC
[skill-plugin-cli] 请在 WeLink 中创建助理
[skill-plugin-cli] 助理创建完成，正在写入 openclaw 连接配置
[skill-plugin-cli] 已完成连接可用性检查
[skill-plugin-cli] 接入完成：openclaw 已完成插件安装、助理创建与 gateway 配置
[skill-plugin-cli] 下一步：请手动重启 openclaw gateway 以使新配置生效
[skill-plugin-cli] 可执行命令：openclaw gateway restart
```

### 6.3 默认成功流：opencode

```text
[skill-plugin-cli] 正在为 opencode 安装 @wecode/skill-opencode-plugin，请稍候
[skill-plugin-cli] opencode 配置路径: /Users/you/.config/opencode/opencode.json
[skill-plugin-cli] 插件安装完成
[skill-plugin-cli] 请使用 WeLink 扫码创建助理
<二维码渲染块>
[skill-plugin-cli] pc WeLink 创建助理地址: https://pc.example/qr-1
[skill-plugin-cli] 二维码有效期至: 2026-04-28 08:00:00 UTC
[skill-plugin-cli] 请在 WeLink 中创建助理
[skill-plugin-cli] 助理创建完成，正在写入 opencode 连接配置
[skill-plugin-cli] 已完成连接可用性检查
[skill-plugin-cli] 接入完成：opencode 已完成插件安装、助理创建与 gateway 配置
[skill-plugin-cli] 下一步：请重启 opencode 以使插件与配置生效
```

### 6.4 带 `--url` 的成功流

```text
[skill-plugin-cli] 正在为 openclaw 安装 @wecode/skill-openclaw-plugin，请稍候
[skill-plugin-cli] openclaw 版本：2026.4.10
[skill-plugin-cli] openclaw 配置路径: /Users/you/.openclaw/openclaw.json
[skill-plugin-cli] 插件安装完成
[skill-plugin-cli] 请使用 WeLink 扫码创建助理
<二维码渲染块>
[skill-plugin-cli] pc WeLink 创建助理地址: https://pc.example/qr-1
[skill-plugin-cli] 二维码有效期至: 2026-04-28 08:00:00 UTC
[skill-plugin-cli] 请在 WeLink 中创建助理
[skill-plugin-cli] 助理创建完成，正在写入 openclaw 连接配置
[skill-plugin-cli] 已完成连接可用性检查
[skill-plugin-cli] 接入完成：openclaw 已完成插件安装、助理创建与 gateway 配置
[skill-plugin-cli] 下一步：请手动重启 openclaw gateway 以使新配置生效
[skill-plugin-cli] 可执行命令：openclaw gateway restart
```

### 6.5 二维码过期并刷新 1 次

```text
[skill-plugin-cli] 二维码已过期，正在刷新

[skill-plugin-cli] ========= 已刷新二维码（第 1/3 次） =========

<二维码渲染块>

[skill-plugin-cli] pc WeLink 创建助理地址: https://pc.example/qr-2
[skill-plugin-cli] 二维码有效期至: 2026-04-28 08:05:00 UTC
[skill-plugin-cli] 请在 WeLink 中创建助理
```

### 6.6 二维码连续刷新

```text
[skill-plugin-cli] 二维码已过期，正在刷新

[skill-plugin-cli] ========= 已刷新二维码（第 1/3 次） =========

<二维码渲染块>

[skill-plugin-cli] pc WeLink 创建助理地址: https://pc.example/qr-2
[skill-plugin-cli] 二维码有效期至: 2026-04-28 08:05:00 UTC
[skill-plugin-cli] 请在 WeLink 中创建助理
[skill-plugin-cli] 二维码已过期，正在刷新

[skill-plugin-cli] ========= 已刷新二维码（第 2/3 次） =========

<二维码渲染块>

[skill-plugin-cli] pc WeLink 创建助理地址: https://pc.example/qr-3
[skill-plugin-cli] 二维码有效期至: 2026-04-28 08:10:00 UTC
[skill-plugin-cli] 请在 WeLink 中创建助理
```

### 6.7 刷新耗尽超时

```text
[skill-plugin-cli] 请使用 WeLink 扫码创建助理
<二维码渲染块>
[skill-plugin-cli] pc WeLink 创建助理地址: https://pc.example/qr-1
[skill-plugin-cli] 二维码有效期至: 2026-04-28 08:00:00 UTC
[skill-plugin-cli] 二维码已过期，正在刷新

[skill-plugin-cli] ========= 已刷新二维码（第 1/3 次） =========

<二维码渲染块>

[skill-plugin-cli] pc WeLink 创建助理地址: https://pc.example/qr-2
[skill-plugin-cli] 二维码有效期至: 2026-04-28 08:05:00 UTC
[skill-plugin-cli] 请在 WeLink 中创建助理
...
[skill-plugin-cli] 接入失败：WeLink 创建助理超时，请重新执行命令
[skill-plugin-cli] 错误摘要：auth_service_error
```

### 6.8 用户取消

```text
[skill-plugin-cli] 请使用 WeLink 扫码创建助理
<二维码渲染块>
[skill-plugin-cli] pc WeLink 创建助理地址: https://pc.example/qr-1
[skill-plugin-cli] 二维码有效期至: 2026-04-28 08:00:00 UTC
[skill-plugin-cli] 请在 WeLink 中创建助理
[skill-plugin-cli] 接入已取消：WeLink 创建助理已取消
```

### 6.9 未安装 openclaw

```text
[skill-plugin-cli] 正在为 openclaw 安装 @wecode/skill-openclaw-plugin，请稍候
[skill-plugin-cli] 接入失败：未检测到 openclaw 命令。
```

### 6.10 OpenClaw 版本不满足

```text
[skill-plugin-cli] 正在为 openclaw 安装 @wecode/skill-openclaw-plugin，请稍候
[skill-plugin-cli] openclaw 版本：2026.3.10
[skill-plugin-cli] 接入失败：当前 openclaw 版本 2026.3.10 不满足 >= 2026.3.24
```

### 6.11 插件安装失败

```text
[skill-plugin-cli] 正在为 openclaw 安装 @wecode/skill-openclaw-plugin，请稍候
[skill-plugin-cli] openclaw 版本：2026.4.10
[skill-plugin-cli] openclaw 配置路径: /Users/you/.openclaw/openclaw.json
[skill-plugin-cli] 接入失败：openclaw plugins install @wecode/skill-openclaw-plugin 失败，退出码 1
```

### 6.12 qrcode-server 业务错误

```text
[skill-plugin-cli] 请使用 WeLink 扫码创建助理
[skill-plugin-cli] 接入失败：WeLink 创建助理服务异常
[skill-plugin-cli] 错误摘要：businessCode=50012, error=assistant_limit_exceeded, message=assistant count exceeded
```

### 6.13 fetch 网络异常

```text
[skill-plugin-cli] 请使用 WeLink 扫码创建助理
[skill-plugin-cli] 接入失败：无法连接 WeLink 创建助理服务
[skill-plugin-cli] 错误摘要：network_error, code=ECONNREFUSED, message=connect ECONNREFUSED 127.0.0.1:443
```

### 6.14 参数错误

```text
[skill-plugin-cli] 参数错误：--host 必须为 opencode 或 openclaw
[skill-plugin-cli] 可执行 skill-plugin-cli --help 查看用法
```

```text
[skill-plugin-cli] 参数错误：--environment 仅支持 uat 或 prod，默认值为 prod
[skill-plugin-cli] 可执行 skill-plugin-cli --help 查看用法
```

```text
[skill-plugin-cli] 参数错误：不支持的子命令: foo
[skill-plugin-cli] 可执行 skill-plugin-cli --help 查看用法
```

### 6.15 `--verbose` 示例

```text
[skill-plugin-cli][openclaw] 开始：解析安装参数
[skill-plugin-cli] 完成：解析安装参数 · environment=prod, registry=https://registry.example.com/, url=ws://localhost:8081/ws/agent
[skill-plugin-cli][openclaw] 开始：检查 openclaw 环境
[skill-plugin-cli] 完成：检查 openclaw 环境 · version=2026.4.10
[skill-plugin-cli][openclaw] 开始：准备 npm 仓源配置
[skill-plugin-cli][openclaw] 开始：安装插件 @wecode/skill-openclaw-plugin
[skill-plugin-cli] 正在执行命令：openclaw plugins install @wecode/skill-openclaw-plugin
Installing plugin @wecode/skill-openclaw-plugin...
Done.
[skill-plugin-cli] 命令执行结束：openclaw plugins install @wecode/skill-openclaw-plugin
[skill-plugin-cli][openclaw] 开始：校验插件安装结果
[skill-plugin-cli][openclaw] 开始：执行 WeLink 创建助理
[skill-plugin-cli] 请使用 WeLink 扫码创建助理
<二维码渲染块>
[skill-plugin-cli] pc WeLink 创建助理地址: https://pc.example/qr-1
[skill-plugin-cli] 二维码有效期至: 2026-04-28 08:00:00 UTC
[skill-plugin-cli] 请在 WeLink 中创建助理
[skill-plugin-cli][openclaw] 开始：写入 openclaw 连接配置
[skill-plugin-cli][openclaw] 开始：检查连接可用性
[skill-plugin-cli] 接入完成：openclaw 已完成插件安装、助理创建与 gateway 配置
[skill-plugin-cli] 下一步：请手动重启 openclaw gateway 以使新配置生效
[skill-plugin-cli] 可执行命令：openclaw gateway restart
```

### 6.16 配置路径的 Unix/mac 与 Windows 示例

```text
[skill-plugin-cli] openclaw 配置路径: /Users/you/.openclaw/openclaw.json
[skill-plugin-cli] openclaw 配置路径: C:\Users\you\.openclaw\openclaw.json
[skill-plugin-cli] opencode 配置路径: /Users/you/.config/opencode/opencode.json
[skill-plugin-cli] opencode 配置路径: C:\Users\you\.config\opencode\opencode.json
```
