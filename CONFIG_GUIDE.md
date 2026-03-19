# AI PR Reviewer - 配置指南

## ⚠️ 重要：API 配置说明

### 问题诊断

根据测试，你提供的配置存在问题：
- **API Key**: `sk-sp-d80bdc30dfee412ca395ca48f7d92db6` 返回 "Invalid API-key provided"
- **Base URL**: `https://coding.dashscope.aliyuncs.com/v1` 不支持标准模型（qwen-max 等）

---

## ✅ 正确的配置方法

### 方案一：通义千问（阿里云 DashScope）

#### 1. 获取正确的 API Key

1. 访问 https://dashscope.console.aliyun.com
2. 登录阿里云账号
3. 开通 **DashScope 灵积模型服务**
4. 进入 **API Key 管理** → **创建新的 API Key**
5. 复制 Key（格式：`sk-xxxxxxxxxxxxxxxx`，**不是** `sk-sp-` 开头）

#### 2. GitHub 配置

**Settings → Secrets and variables → Actions → New repository secret:**

| Name | Value |
|------|-------|
| `OPENAI_API_KEY` | `sk-xxxxxxxxxxxxxxxx`（你的 DashScope API Key） |
| `OPENAI_BASE_URL` | `https://dashscope.aliyuncs.com/compatible-mode/v1` |

**Settings → Variables → Actions → New repository variable:**

| Name | Value |
|------|-------|
| `OPENAI_MODEL` | `qwen-plus` 或 `qwen-max` |

#### 3. 测试 API

```bash
curl -X POST https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions \
  -H "Authorization: Bearer sk-你的 API Key" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen-plus","messages":[{"role":"user","content":"你好"}]}'
```

---

### 方案二：DeepSeek（推荐，性价比最高）

#### 1. 获取 API Key

1. 访问 https://platform.deepseek.com
2. 注册/登录
3. 控制台 → API Keys → 创建
4. 新用户送 **¥10 额度**

#### 2. GitHub 配置

| Name | Value |
|------|-------|
| `OPENAI_API_KEY` | `sk-xxxxx`（DeepSeek API Key） |
| `OPENAI_BASE_URL` | `https://api.deepseek.com` |
| `OPENAI_MODEL` | `deepseek-chat` |

---

### 方案三：OpenAI 官方

| Name | Value |
|------|-------|
| `OPENAI_API_KEY` | `sk-proj-xxxxx` |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` |
| `OPENAI_MODEL` | `gpt-4o` |

---

## 📋 完整配置检查清单

在 GitHub 仓库中确认以下配置：

### Secrets（必需）
- [ ] `OPENAI_API_KEY` - API Key（必需）
- [ ] `OPENAI_BASE_URL` - Base URL（可选，默认 OpenAI）

### Variables（可选）
- [ ] `OPENAI_MODEL` - 模型名称（可选，默认 gpt-4o）

---

## 🧪 验证步骤

### 1. 本地测试 API

```python
import requests

API_KEY = "sk-你的 Key"
BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
MODEL = "qwen-plus"

response = requests.post(
    f"{BASE_URL}/chat/completions",
    headers={"Authorization": f"Bearer {API_KEY}"},
    json={
        "model": MODEL,
        "messages": [{"role": "user", "content": "你好"}]
    }
)

print(response.json())
```

### 2. 触发测试 PR

1. 修改任意代码文件
2. 创建 PR
3. 查看 GitHub Actions 日志
4. 检查 PR 评论

---

## 💰 成本对比

| 服务商 | 模型 | 价格（输入/输出） | 单次 PR 成本 |
|--------|------|------------------|-------------|
| DeepSeek | deepseek-chat | ¥0.5/¥2 per 1M tokens | ¥0.2-0.5 |
| 通义千问 | qwen-plus | ¥1-2/¥2-4 per 1M tokens | ¥0.5-1 |
| 通义千问 | qwen-max | ¥2-4/¥4-8 per 1M tokens | ¥1-3 |
| OpenAI | gpt-4o | $0.03/$0.15 per 1K tokens | ¥2-5 |

---

## ❓ 常见问题

### Q: `sk-sp-` 开头的 Key 是什么？
A: 这是阿里云服务账号类型的 Key，可能不适用于 DashScope API。请使用个人账号创建标准 API Key。

### Q: 如何确认 API Key 是否有效？
A: 使用上面的本地测试脚本，能返回正常回复即有效。

### Q: coding.dashscope.aliyuncs.com 是什么？
A: 这是阿里云代码专用端点，不支持标准通义千问模型。使用 `dashscope.aliyuncs.com/compatible-mode/v1`。

---

## 📞 获取帮助

1. DashScope 文档：https://help.aliyun.com/zh/dashscope
2. DeepSeek 文档：https://platform.deepseek.com/docs
3. 查看 workflow 日志获取详细错误信息

---

**配置完成后，删除此文件并提交 workflow 即可开始使用！**
