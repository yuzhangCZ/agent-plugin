#!/usr/bin/env python3
"""
AI PR Reviewer - 自动代码审查脚本
支持 OpenAI 兼容 API（OpenAI / DeepSeek / 通义千问等）

环境变量:
- OPENAI_API_KEY: API Key（必需）
- OPENAI_BASE_URL: API Base URL（可选，默认 https://api.openai.com/v1）
- OPENAI_MODEL: 模型名称（可选，默认 gpt-4o）
- REVIEW_STYLE: 审查风格（可选：concise/detailed/strict）
"""

import os
import sys
import json
import requests
from github import Github

# ============== 配置 ==============
API_KEY = os.getenv('OPENAI_API_KEY')
BASE_URL = os.getenv('OPENAI_BASE_URL', 'https://api.openai.com/v1').rstrip('/')
MODEL = os.getenv('OPENAI_MODEL', 'gpt-4o')
STYLE = os.getenv('REVIEW_STYLE', 'concise')

# 文件过滤
IGNORE_PATTERNS = ['*.md', '*.txt', '*.lock', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']
IGNORE_DIRS = ['vendor/', 'node_modules/', 'dist/', 'build/', '.git/']
MAX_FILES = 15
MAX_PATCH_SIZE = 5000

# ============== 提示词模板 ==============

SYSTEM_PROMPT = """你是一位资深代码审查专家，拥有 15 年软件工程经验。你的任务是审查 Pull Request 的代码变更，发现潜在问题并提供建设性意见。

## 审查原则
1. **准确性优先** - 只报告确定的问题，避免误报
2. **建设性反馈** - 每个问题都要给出可操作的修复建议
3. **分级报告** - 按严重程度分类（Critical/Warning/Suggestion）
4. **上下文感知** - 理解变更的整体意图，不要断章取义
5. **尊重原作者** - 用词专业、友好，避免指责性语言

## 审查维度（按优先级）
1. 🔴 **Critical** - 安全漏洞、逻辑错误、会导致崩溃的 bug
2. 🟡 **Warning** - 性能问题、潜在的 bug、代码异味
3. 🟢 **Suggestion** - 代码风格、可读性改进、最佳实践

## 输出要求
- 使用中文输出
- 只审查变更的代码（diff），不要对未变更的代码指手画脚
- 忽略纯格式变更（假设有 linter 处理）
- 如果代码没有问题，明确说明"未发现明显问题"
- 对于复杂变更，先总结变更意图再给意见"""

USER_PROMPT_TEMPLATE = """## PR 信息
**标题**: {title}
**描述**: {description}

## 变更文件 ({file_count} 个)

{file_contents}

## 输出格式

请严格按照以下 JSON 格式输出（只输出 JSON，不要其他内容）：

```json
{{
  "summary": "一句话总结变更内容和整体质量",
  "score": 7,
  "has_critical_issues": false,
  "comments": [
    {{
      "severity": "critical",
      "category": "bug",
      "file": "src/example.js",
      "line": 42,
      "title": "简短的问题标题",
      "description": "详细描述问题和影响",
      "suggestion": "具体的修复建议或代码示例"
    }}
  ],
  "positive_feedback": ["做得好的地方 1", "做得好的地方 2"],
  "approved": true
}}
```"""

CRITICAL_ISSUES_CHECKLIST = """
## 重点检查以下问题：

### 安全问题
- SQL 注入、XSS、CSRF 漏洞
- 敏感信息硬编码（密码、API Key、Token）
- 不安全的反序列化
- 权限校验缺失

### 逻辑错误
- 空指针/未定义检查
- 边界条件处理
- 并发/竞态条件
- 资源泄漏
- 异常处理缺失

### 性能问题
- N+1 查询
- 循环内重复计算
- 不必要的同步操作

### 代码质量
- 函数过长/复杂度过高
- 重复代码
- 魔术数字
- 命名不清晰
"""

# ============== 工具函数 ==============

def should_ignore_file(filename):
    """检查文件是否应该被忽略"""
    for pattern in IGNORE_PATTERNS:
        if pattern.startswith('*.'):
            if filename.endswith(pattern[1:]):
                return True
        elif pattern in filename:
            return True
    for dir_pattern in IGNORE_DIRS:
        if dir_pattern in filename:
            return True
    return False

def get_pr_diff(github_token, repo, pr_number):
    """获取 PR 变更 diff"""
    g = Github(github_token)
    pr = g.get_repo(repo).get_pull(pr_number)
    
    files = []
    for f in pr.get_files():
        if should_ignore_file(f.filename):
            print(f"⏭️  跳过：{f.filename}")
            continue
        
        patch = f.patch or ''
        if len(patch) > MAX_PATCH_SIZE:
            patch = patch[:MAX_PATCH_SIZE] + '\n...(内容过长，已截断)'
        
        files.append({
            'filename': f.filename,
            'status': f.status,
            'additions': f.additions,
            'deletions': f.deletions,
            'patch': patch
        })
    
    return files[:MAX_FILES], pr

def build_prompt(files, pr_title, pr_body):
    """构建审查提示词"""
    file_contents = ""
    for i, f in enumerate(files, 1):
        status_icon = {'added': '🆕', 'modified': '✏️', 'removed': '🗑️', 'renamed': '📝'}.get(f['status'], '📄')
        file_contents += f"\n### {i}. {status_icon} {f['filename']} (+{f['additions']} -{f['deletions']})\n"
        file_contents += f"```diff\n{f['patch']}\n```\n\n"
    
    file_contents += CRITICAL_ISSUES_CHECKLIST
    
    return USER_PROMPT_TEMPLATE.format(
        title=pr_title,
        description=pr_body[:500] if pr_body else "无描述",
        file_count=len(files),
        file_contents=file_contents
    )

def call_openai_api(prompt):
    """调用 OpenAI 兼容 API"""
    if not API_KEY:
        print("❌ 缺少 OPENAI_API_KEY 环境变量")
        return None
    
    endpoint = f"{BASE_URL}/chat/completions"
    
    print(f"🔑 OPENAI_API_KEY: {'✅ 已设置 (' + API_KEY[:6] + '...)' if API_KEY else '❌ 未设置'}")
    print(f"🔑 OPENAI_BASE_URL: {BASE_URL}")
    print(f"🔑 OPENAI_MODEL: {MODEL}")
    print(f"📡 正在调用 API: {endpoint}...")
    
    headers = {
        'Authorization': f'Bearer {API_KEY}',
        'Content-Type': 'application/json'
    }
    
    payload = {
        'model': MODEL,
        'messages': [
            {'role': 'system', 'content': SYSTEM_PROMPT},
            {'role': 'user', 'content': prompt}
        ],
        'max_tokens': 3000,
        'temperature': 0.2
    }
    
    try:
        response = requests.post(endpoint, headers=headers, json=payload, timeout=60)
        
        print(f"📡 API 响应状态码：{response.status_code}")
        
        if response.status_code == 200:
            result = response.json()
            content = result['choices'][0]['message']['content']
            print(f"✅ AI 返回内容长度：{len(content)}")
            return content
        else:
            print(f"❌ API 错误：{response.status_code}")
            print(f"响应内容：{response.text[:500]}")
            return None
            
    except requests.exceptions.Timeout:
        print("❌ API 请求超时（>60 秒）")
        return None
    except Exception as e:
        print(f"❌ 请求失败：{e}")
        return None

def parse_ai_response(content):
    """解析 AI 返回的 JSON"""
    import re
    
    try:
        return json.loads(content)
    except:
        pass
    
    json_match = re.search(r'```(?:json)?\s*({.*?})\s*```', content, re.DOTALL)
    if json_match:
        try:
            return json.loads(json_match.group(1))
        except:
            pass
    
    start = content.find('{')
    end = content.rfind('}') + 1
    if start != -1 and end > start:
        try:
            return json.loads(content[start:end])
        except:
            pass
    
    print("❌ 无法解析 AI 返回的 JSON")
    return None

def post_review(pr, review_data):
    """发布审查评论到 PR"""
    emoji = '✅' if review_data.get('approved') else '⚠️'
    score = review_data.get('score', 'N/A')
    summary = review_data.get('summary', '无总结')
    
    comment = f"""{emoji} **AI 代码审查完成**

**评分**: {score}/10
**总结**: {summary}

"""
    
    positive = review_data.get('positive_feedback', [])
    if positive:
        comment += "### 👍 做得好的地方\n"
        for p in positive[:3]:
            comment += f"- {p}\n"
        comment += "\n"
    
    comments = review_data.get('comments', [])
    if comments:
        comment += "### 📋 详细意见\n\n"
        
        critical = [c for c in comments if c.get('severity') == 'critical']
        warning = [c for c in comments if c.get('severity') == 'warning']
        suggestion = [c for c in comments if c.get('severity') == 'suggestion']
        
        if critical:
            comment += "#### 🔴 Critical ({})\n".format(len(critical))
            for c in critical:
                comment += format_comment(c)
        
        if warning:
            comment += "\n#### 🟡 Warning ({})\n".format(len(warning))
            for c in warning:
                comment += format_comment(c)
        
        if suggestion:
            comment += "\n#### 🟢 Suggestion ({})\n".format(len(suggestion))
            for c in suggestion:
                comment += format_comment(c)
    else:
        comment += "**未发现明显问题**，代码质量良好！\n"
    
    comment += """
---
*此审查由 AI 生成，仅供参考。请结合人工判断进行最终决策。*
"""
    
    pr.create_issue_comment(comment)
    
    for c in comments:
        if c.get('line') and c.get('file'):
            try:
                commits = pr.get_commits()
                if commits.totalCount > 0:
                    latest_commit = commits[0]
                    icon = {'critical': '🔴', 'warning': '🟡', 'suggestion': '🟢'}.get(c.get('severity'), '💬')
                    body = f"{icon} **{c.get('title', '')}**\n\n{c.get('description', '')}\n\n💡 {c.get('suggestion', '')}"
                    pr.create_review_comment(
                        body=body[:8000],
                        path=c['file'],
                        position=c['line'],
                        commit=latest_commit
                    )
            except Exception as e:
                print(f"⚠️ 行内评论失败：{e}")

def format_comment(c):
    """格式化单条评论"""
    icon = {'critical': '🔴', 'warning': '🟡', 'suggestion': '🟢'}.get(c.get('severity'), '💬')
    file_ref = f"`{c.get('file', 'unknown')}`"
    if c.get('line'):
        file_ref += f":L{c['line']}"
    
    return f"""- {icon} **{c.get('title', '问题')}** ({file_ref})
  {c.get('description', '')}
  > 💡 {c.get('suggestion', '无建议')}

"""

# ============== 主函数 ==============

def main():
    print("=" * 60)
    print("🤖 AI PR Reviewer 启动")
    print("=" * 60)
    
    github_token = os.getenv('GITHUB_TOKEN')
    if not github_token:
        print("❌ 缺少 GITHUB_TOKEN 环境变量")
        sys.exit(1)
    
    event_path = os.getenv('GITHUB_EVENT_PATH')
    if not event_path:
        print("❌ 不在 GitHub Actions 环境中")
        sys.exit(1)
    
    with open(event_path) as f:
        event = json.load(f)
    
    if 'pull_request' not in event:
        print("⏭️ 不是 PR 事件，跳过")
        sys.exit(0)
    
    pr_number = event['pull_request']['number']
    repo = event['repository']['full_name']
    pr_title = event['pull_request']['title']
    pr_body = event['pull_request'].get('body', '')
    
    print(f"\n🔍 审查 PR #{pr_number}: {pr_title}")
    print(f"📁 仓库：{repo}")
    print(f"🎨 风格：{STYLE}")
    
    print("\n📄 获取 PR 变更...")
    files, pr = get_pr_diff(github_token, repo, pr_number)
    
    if not files:
        print("✅ 没有需要审查的代码变更")
        pr.create_issue_comment("🤖 AI 审查：未发现需要审查的代码变更（可能是纯文档更新）")
        sys.exit(0)
    
    print(f"✅ 获取到 {len(files)} 个文件变更")
    for f in files:
        print(f"   - {f['filename']} (+{f['additions']} -{f['deletions']})")
    
    print("\n📝 构建提示词...")
    prompt = build_prompt(files, pr_title, pr_body)
    print(f"📊 Prompt 长度：{len(prompt)} 字符")
    
    print("\n🤖 调用 AI 进行审查...")
    review_content = call_openai_api(prompt)
    
    if not review_content:
        print("❌ AI 调用失败")
        pr.create_issue_comment("""⚠️ **AI 审查服务暂时不可用**

请检查以下配置：
1. `OPENAI_API_KEY` - API Key 是否正确
2. `OPENAI_BASE_URL` - Base URL 是否正确
3. `OPENAI_MODEL` - 模型名称是否正确

查看 workflow 日志获取详细错误信息。""")
        sys.exit(1)
    
    print("\n📋 解析 AI 返回结果...")
    review_data = parse_ai_response(review_content)
    
    if not review_data:
        print("❌ 无法解析 AI 返回的 JSON")
        pr.create_issue_comment(f"⚠️ AI 审查完成，但返回格式无法解析。\n\n原始返回：\n```\n{review_content[:1000]}...```")
        sys.exit(1)
    
    print("\n📝 发布审查意见...")
    post_review(pr, review_data)
    
    print("\n" + "=" * 60)
    print("✅ 审查完成！")
    print("=" * 60)

if __name__ == '__main__':
    main()
