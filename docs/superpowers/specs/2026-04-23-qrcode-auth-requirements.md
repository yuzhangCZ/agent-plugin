# 二维码扫码授权需求说明

日期：2026-04-23

## 背景

当前 `message-bridge` / `message-bridge-openclaw` 主要通过各自插件包内的安装脚本完成 `cli install`。现有安装流程依赖用户手动输入 `ak/sk`，存在以下问题：

- 安装门槛较高，交互流程偏长。
- 用户需要显式维护凭据输入，容易出错。
- `opencode` / `openclaw` 双端安装脚本逻辑分散在各自插件包内，安装与二维码展示逻辑难以复用。

为降低安装门槛，并为后续统一安装入口预留空间，需要引入二维码扫码授权能力。

## 用户可见结果

特性完成后，用户在 `cli install` 场景下应能看到以下结果：

1. 用户可通过扫码完成授权，而不再仅依赖手动输入 `ak/sk`。
2. 安装流程可获得二维码展示数据，并持续同步当前授权状态。
3. 授权成功后，安装流程可获得 `ak/sk`。
4. 二维码过期后，用户可进入刷新后的继续授权流程。

## 目标

本需求的目标是定义一套**二维码扫码授权完整会话能力**，并以 `cli install` 作为本期优先场景。

本期目标包括：

1. 定义二维码扫码授权会话的业务边界。
2. 将扫码授权成功结果固定为 `ak/sk`。
3. 明确会话终态与展示职责边界。
4. 为 `opencode` / `openclaw` 双端安装场景提供统一需求口径。

## 非目标

本期不覆盖以下内容：

- `plugin` 正式接入二维码授权能力。
- `bridge-runtime-sdk` 正式接入二维码授权能力。
- 配置落盘方案设计。
- 安装完成后的执行编排设计。
- UI 或终端二维码展示实现细节。
- 将认证结果抽象为通用 credential model。
- 在需求中承诺本期一定落地独立安装 CLI 包（如 `skill-agent-cli`）。

## 本期范围

本期明确交付场景仅为 `cli install`，且此处的 `cli install` 同时覆盖：

- `opencode`
- `openclaw`

本需求关注的是统一安装场景下的扫码授权能力，而不是单一插件包内部脚本优化。

## 成功结果定义

扫码授权成功后的标准结果固定为：

- `ak`
- `sk`

本期需求不以“原始服务端响应”作为交付定义，也不将“通用凭证对象”纳入需求范围。

## 核心能力定义

本需求定义的对象是**完整授权会话能力**，而不是单纯的接口调用封装。该能力至少应覆盖以下业务动作：

1. 创建二维码授权会话。
2. 获取二维码展示数据。
3. 轮询二维码状态。
4. 同步二维码状态变化。
5. 在二维码过期后支持刷新。
6. 在授权成功后返回 `ak/sk`。
7. 在结束场景下给出明确终态。

## 展示职责边界

二维码扫码授权核心能力只负责提供展示所需数据，不负责具体展示动作。

在本期场景中：

- 核心能力负责提供二维码内容、状态信息和刷新后的最新数据。
- `cli install` 作为接入方，负责将二维码展示给用户。

因此，“支持集成方完成二维码展示”的准确含义是：**提供展示数据，不负责展示实现本身。**

## 终态定义

扫码授权会话在需求层应具备完整终态集，包括：

- `confirmed`
- `cancelled`
- `expired`
- `timeout`
- `failed`

上述终态属于业务终态，不直接等同于服务端原始状态字段。

## 服务 API 接口说明

以下内容为当前需求依赖的外部服务接口事实输入，用于定义扫码授权会话的输入输出边界，不代表本期已确定的客户端实现方式。

### 二维码状态说明

当前已知服务端原始状态如下：

```text
wait: 0       // 未扫码
scaned: 1     // 已扫码
confirmed: 2  // 助理创建成功
cancel: 3     // 取消
```

这些状态属于接口层原始状态输入。需求层仍需在其基础上定义更完整的业务终态与会话语义。

### 1. 二维码生成接口

- 路径：`{domain}/assistant-api/nologin/we-crew/im-register/qrcode`
- 方法：`POST`
- 请求头：无认证信息

请求参数：

| 参数 | 参数类型 | 参数位置 | 必填 | 长度限制 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `channel` | `string` | `body` | Y | 100 | 渠道来源 |
| `mac` | `string` | `body` | N | 100 | 设备 MAC 地址 |

响应字段：

| 参数 | 参数类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `code` | `string` | Y | 成功时为 `200` |
| `message` | `string` | N | 描述信息 |
| `error` | `string` | N | 错误信息 |
| `data` | `object` | N | 二维码信息对象 |
| `data.accessToken` | `string` | Y | 二维码状态获取凭据 |
| `data.qrcode` | `string` | Y | 二维码唯一标识 |
| `data.weUrl` | `string` | Y | H5 扫码内容，例如 `h5://.../index.html?qrcode=xxx&channel=xx` |
| `data.pcUrl` | `string` | Y | PC 端拉起 app 链接，例如 `xxxapp://...?qrcode=xxx&channel=xx` |
| `data.status` | `string` | Y | 当前二维码状态 |
| `data.expireTime` | `string` | Y | 二维码过期时间 |
| `data.mac` | `string` | Y | MAC 地址 |
| `data.channel` | `string` | Y | `channel` 来源 |

异常示例：

```json
{
  "code": "1001",
  "error": "Invalid parameter exception",
  "message": "Invalid parameter"
}
```

需求层关注点：

- 调用方需要从该接口拿到二维码会话标识、查询凭据与展示数据。
- `accessToken` 是后续查询二维码详情接口的鉴权输入。
- `weUrl` 与 `pcUrl` 是展示层数据，不等同于“核心能力负责展示”。

### 2. 二维码查询接口

- 路径：`{domain}/assistant-api/nologin/we-crew/im-register/qrcode-detail/${qrcode}`
- 方法：`GET`
- 请求头：`qrcodeToken: <创建二维码返回的 accessToken>`

请求参数：

| 参数 | 参数类型 | 参数位置 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `qrcode` | `string` | `path` | Y | 二维码唯一标识 |

响应字段：

| 参数 | 参数类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `code` | `string` | Y | 成功时为 `200` |
| `message` | `string` | N | 描述信息 |
| `data` | `object` | N | 二维码详情对象 |
| `data.qrcode` | `string` | Y | 二维码唯一标识 |
| `data.weUrl` | `string` | Y | H5 扫码内容 |
| `data.pcUrl` | `string` | Y | PC 端拉起 app 链接 |
| `data.status` | `string` | Y | 当前二维码状态 |
| `data.ak` | `string` | Y | 二维码状态为 `confirmed` 时返回 |
| `data.sk` | `string` | Y | 二维码状态为 `confirmed` 时返回 |
| `data.expireTime` | `string` | Y | 二维码过期时间 |
| `data.expired` | `string` | Y | 二维码是否已过期 |

异常说明：

- `400`
  - `585705`：无效的二维码
  - `585704`：不存在的二维码信息，请确认
- `401`
  - `587706`：当前二维码已失效或无权限访问二维码信息

异常示例：

```json
{
  "code": "585704",
  "error": "无效的二维码编码",
  "errorEn": "The QR code is invalid",
  "message": "Internal service error"
}
```

需求层关注点：

- 该接口既承担状态查询，也承担成功结果返回。
- 当状态为 `confirmed` 时，接口返回 `ak/sk`，与本期需求中“成功结果固定为 `ak/sk`”保持一致。
- `expired`、`无效二维码`、`无权限访问` 等返回，说明调用方需要区分“可继续刷新”和“本次会话结束”的业务语义。

## 当前约束与后续候选方向

当前 `opencode` / `openclaw` 的安装脚本位于各自插件包中，逻辑难以复用。为统一安装流程与二维码展示职责，后续实现可评估引入独立安装 CLI 包，例如 `skill-agent-cli`。

需要明确的是：

- `skill-agent-cli` 当前仅作为后续实现候选承载体，不是本期硬性验收项。
- `plugin` / `bridge-runtime-sdk` 当前同样仅列为后续候选范围。
- 本文档不定义包路径、模块职责拆分、状态机内部实现、发布依赖关系或迁移步骤。

## 结论

本期需求围绕 `cli install` 场景，定义一套二维码扫码授权完整会话能力。该能力负责创建二维码、同步状态、处理过期刷新，并在成功后返回 `ak/sk`；二维码展示由接入方负责。`plugin`、`bridge-runtime-sdk` 以及独立安装 CLI 包仅作为后续扩展与实现承载方向，不构成本期需求承诺。
