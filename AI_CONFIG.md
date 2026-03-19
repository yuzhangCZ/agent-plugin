# AI PR Reviewer 配置指南

## 环境变量说明

### 必需配置

| 变量名 | 说明 | 示例 |
|--------|------|------|
| `OPENAI_API_KEY` | API Key | `sk-xxxxx` |
| `OPENAI_BASE_URL` | API Base URL（可选） | `https://api.openai.com/v1` |
| `OPENAI_MODEL` | 模型名称（可选） | `gpt-4o` |

### 可选配置

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `REVIEW_STYLE` | 审查风格 | `concise` |

---

## 配置示例

### 方案一：OpenAI 官方

**GitHub Secrets:**
```
OPENAI_API_KEY = sk-proj-xxxxx
OPENAI_BASE_URL = https://api.openai.com/v1
```

**GitHub Variables (可选):**
```
OPENAI_MODEL = gpt-4o
```

**成本**: ~$0.03/1K input tokens, ~$0.15/1K output tokens

---

### 方案二：DeepSeek（推荐，性价比高）

**GitHub Secrets:**
```
OPENAI_API_KEY = sk-xxxxx
OPENAI_BASE_URL = https://api.deepseek.com
```

**GitHub Variables:**
```
OPENAI_MODEL = deepseek-chat
```

**成本**: ¥0.5/1M input tokens, ¥2/1M output tokens（便宜 10 倍！）

---

### 方案三：通义千问（阿里云）

**GitHub Secrets:**
```
OPENAI_API_KEY = sk-xxxxx
OPENAI_BASE_URL = https://dashscope.aliyuncs.com/compatible-mode/v1
```

**GitHub Variables:**
```
OPENAI_MODEL = qwen-max
```

**成本**: ¥2-4/1M tokens

---

### 方案四：本地部署（Ollama/vLLM）

**GitHub Secrets:**
```
OPENAI_API_KEY = ollama  # 本地不需要，随便填
OPENAI_BASE_URL = http://your-server:11434/v1
```

**GitHub Variables:**
```
OPENAI_MODEL = llama3:70b
```

**成本**: 免费（自有服务器）

---

## 审查风格

| 风格 | 说明 | 适合场景 |
|------|------|----------|
| `concise` | 只指出关键问题，简洁明了 | 日常开发，小 PR |
| `detailed` | 详细分析，给出示例代码 | 重要功能，大 PR |
| `strict` | 严格审查，包括代码风格 | 核心模块，安全敏感代码 |

---

## 提示词设计（业界最佳实践）

本脚本采用以下提示词设计原则：

### 1. 角色设定
```
你是一位资深代码审查专家，拥有 15 年软件工程经验。
```

### 2. 审查原则
- 准确性优先 - 只报告确定的问题
- 建设性反馈 - 每个问题都要给出修复建议
- 分级报告 - Critical/Warning/Suggestion
- 上下文感知 - 理解变更意图
- 尊重原作者 - 用词专业友好

### 3. 审查维度（按优先级）
1. 🔴 Critical - 安全漏洞、逻辑错误、崩溃 bug
2. 🟡 Warning - 性能问题、潜在 bug、代码异味
3. 🟢 Suggestion - 代码风格、可读性改进

### 4. 检查清单
- 安全问题（SQL 注入、XSS、敏感信息）
- 逻辑错误（空指针、边界条件、资源泄漏）
- 性能问题（N+1 查询、循环内重复计算）
- 代码质量（函数过长、重复代码、魔术数字）

### 5. 输出格式
强制 JSON 格式，包含：
- summary: 一句话总结
- score: 1-10 分
- comments: 详细意见数组
- positive_feedback: 做得好的地方
- approved: 是否建议批准

---

## 输出示例

```json
{
  "summary": "PR 实现了用户认证功能，整体代码质量良好，但存在 2 个安全问题需要修复",
  "score": 7,
  "has_critical_issues": true,
  "comments": [
    {
      "severity": "critical",
      "category": "security",
      "file": "src/auth.js",
      "line": 42,
      "title": "硬编码的 API Key",
      "description": "API Key 直接写在代码中，存在泄露风险",
      "suggestion": "使用环境变量存储：process.env.API_KEY"
    }
  ],
  "positive_feedback": [
    "函数命名清晰",
    "添加了单元测试"
  ],
  "approved": false
}
```

---

## 快速开始

### 1. 选择服务商

推荐使用 **DeepSeek**（性价比最高）：
- 注册：https://platform.deepseek.com
- 新用户送 ¥10 额度
- 代码能力强，审查准确

### 2. 获取 API Key

1. 登录服务商控制台
2. 创建 API Key
3. 复制 Key（`sk-xxxxx` 格式）

### 3. 配置 GitHub

**Secrets** (Settings → Secrets and variables → Actions):
```
OPENAI_API_KEY = sk-xxxxx
OPENAI_BASE_URL = https://api.deepseek.com  # 如果用 DeepSeek
```

**Variables** (可选):
```
OPENAI_MODEL = deepseek-chat
```

### 4. 测试

创建一个测试 PR，查看 AI 审查评论！

---

## 常见问题

**Q: 可以使用多个模型吗？**
A: 可以，通过 `OPENAI_MODEL` 变量切换。

**Q: 如何调整审查严格度？**
A: 修改 `REVIEW_STYLE` 环境变量。

**Q: AI 误报怎么办？**
A: 提示词已优化减少误报，如仍有问题可以调整提示词模板。

**Q: 成本如何控制？**
A: 
- 限制单次审查文件数（MAX_FILES = 15）
- 限制 patch 大小（MAX_PATCH_SIZE = 5000）
- 使用性价比高的模型（如 DeepSeek）

---

## 参考资源

- [OpenAI API 文档](https://platform.openai.com/docs)
- [DeepSeek API 文档](https://platform.deepseek.com/docs)
- [通义千问 API 文档](https://help.aliyun.com/zh/dashscope)
