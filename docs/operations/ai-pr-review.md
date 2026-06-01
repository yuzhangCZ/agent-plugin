# AI PR Review Action 配置说明

## 目标

通过 GitHub Marketplace 的现成 Action 对 Pull Request diff 做自动审查，并把结果评论回 PR。

当前仓库已经提供：

- Workflow：`.github/workflows/ai-pr-review.yml`
- Action：`petarzarkov/gemini-code-review-action@v1.1.3`

## 配置步骤

1. 在 Google AI Studio 创建 Gemini API Key。
2. 进入 GitHub 仓库 `Settings > Secrets and variables > Actions`。
3. 在 `Secrets` 中新增：
   - `GEMINI_API_KEY`：Google AI Studio API Key
4. 可选，在 `Variables` 中新增：
   - `AI_REVIEW_MODEL`：默认 `gemini-3-flash-preview`

配置完成后，PR 在 `opened`、`synchronize`、`reopened`、`ready_for_review` 时会触发 `AI PR Review` workflow。

## 当前边界

- 默认使用中文输出。
- 默认跳过 draft PR；draft 转为 ready 后会触发审查。
- 默认启用 conversation context，减少同一个 PR 后续提交中的重复意见。
- 默认聚焦仓库主开发边界，排除 `.github/`、`docs/`、`integration/`、依赖目录、构建产物、覆盖率产物、Markdown、文本、lockfile 和 snapshot。
- Workflow 使用 `continue-on-error: true`，AI 审查失败不会阻塞主 CI。
- AI 评论只作为辅助审查，不替代人工 reviewer 和现有 `pnpm verify:workspace` 等验证命令。
- Marketplace Action 由第三方维护，升级版本前需要先查看 release note 和权限变化。

## 调试方式

如果 PR 中出现“AI 审查服务暂时不可用”，优先检查：

1. `GEMINI_API_KEY` 是否存在且可用。
2. `AI_REVIEW_MODEL` 是否是当前 API Key 可访问的模型。
3. GitHub Actions 日志中的 Action 输出、HTTP 状态码和响应摘要。
