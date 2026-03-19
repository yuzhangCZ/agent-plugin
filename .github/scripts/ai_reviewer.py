#!/usr/bin/env python3
"""
AI PR Reviewer - 自动代码审查脚本
支持 OpenAI / Anthropic / 本地模型
"""

import os
import sys
import json
import requests
from github import Github

# ============== 配置 ==============
MODEL = os.getenv('REVIEW_MODEL', 'claude-3.5-sonnet')
STYLE = os.getenv('REVIEW_STYLE', 'concise')
IGNORE_PATTERNS = ['*.md', '*.txt', 'vendor/**', 'node_modules/**', '*.lock']
MAX_FILES = 10  # 单次审查最多文件数
MAX_LINES_PER_FILE = 200  # 单文件最大行数

# ============== GitHub API ==============
def get_pr_diff(github_token, repo, pr_number):
    """获取 PR 变更 diff"""
    g = Github(github_token)
    pr = g.get_repo(repo).get_pull(pr_number)
    
    files = []
    for f in pr.get_files():
        # 跳过忽略的文件
        if any(f.filename.endswith(p.replace('*', '')) for p in IGNORE_PATTERNS):
            continue
        if 'vendor/' in f.filename or 'node_modules/' in f.filename:
            continue
            
        files.append({
            'filename': f.filename,
            'status': f.status,
            'additions': f.additions,
            'deletions': f.deletions,
            'patch': f.patch[:3000] if f.patch else ''  # 限制 patch 大小
        })
    
    return files[:MAX_FILES], pr

# ============== AI 审查 ==============
def build_prompt(files, pr_title, pr_body):
    """构建审查提示词"""
    style_instructions = {
        'concise': '只指出关键问题，每条意见不超过 2 句话',
        'detailed': '详细分析每个问题，给出修复建议和示例代码',
        'strict': '严格审查，包括代码风格、潜在 bug、安全漏洞'
    }
    
    file_context = "\n\n".join([
        f"文件：{f['filename']}\n状态：{f['status']}\n变更:\n{f['patch']}"
        for f in files
    ])
    
    return f"""你是一个资深代码审查员。请审查以下 PR 变更。

PR 标题：{pr_title}
PR 描述：{pr_body[:500]}

审查要求：
- 风格：{style_instructions.get(STYLE, style_instructions['concise'])}
- 关注：安全漏洞、逻辑错误、性能问题、代码规范
- 忽略：格式问题（假设有 linter）、纯文档变更

变更内容：
{file_context}

请按以下 JSON 格式输出审查意见（只输出 JSON，不要其他内容）：
{{
  "summary": "PR 整体评价（1-2 句话）",
  "score": 1-10 的分数，
  "comments": [
    {{
      "file": "文件名",
      "line": 行号（如果知道）,
      "type": "bug|security|performance|style|question",
      "message": "审查意见"
    }}
  ],
  "approved": true/false（是否建议批准）
}}
"""

def call_ai(prompt):
    """调用 AI 模型"""
    if MODEL.startswith('claude'):
        return call_anthropic(prompt)
    elif MODEL.startswith('gpt'):
        return call_openai(prompt)
    elif MODEL.startswith('deepseek'):
        return call_deepseek(prompt)
    elif MODEL.startswith('qwen'):
        return call_qwen(prompt)
    elif MODEL.startswith('kimi') or MODEL.startswith('moonshot'):
        return call_moonshot(prompt)
    elif MODEL.startswith('glm'):
        return call_zhipu(prompt)
    else:
        return call_generic(prompt)

def call_anthropic(prompt):
    """调用 Anthropic Claude"""
    api_key = os.getenv('ANTHROPIC_API_KEY')
    if not api_key:
        return None
        
    response = requests.post(
        'https://api.anthropic.com/v1/messages',
        headers={
            'x-api-key': api_key,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json'
        },
        json={
            'model': MODEL,
            'max_tokens': 2000,
            'messages': [{'role': 'user', 'content': prompt}]
        }
    )
    
    if response.ok:
        return response.json()['content'][0]['text']
    return None

def call_openai(prompt):
    """调用 OpenAI GPT"""
    api_key = os.getenv('OPENAI_API_KEY')
    if not api_key:
        return None
        
    response = requests.post(
        'https://api.openai.com/v1/chat/completions',
        headers={
            'Authorization': f'Bearer {api_key}',
            'content-type': 'application/json'
        },
        json={
            'model': MODEL,
            'messages': [{'role': 'user', 'content': prompt}],
            'max_tokens': 2000
        }
    )
    
    if response.ok:
        return response.json()['choices'][0]['message']['content']
    return None

def call_deepseek(prompt):
    """调用 DeepSeek (深度求索)"""
    api_key = os.getenv('DEEPSEEK_API_KEY')
    if not api_key:
        return None
    
    response = requests.post(
        'https://api.deepseek.com/chat/completions',
        headers={
            'Authorization': f'Bearer {api_key}',
            'content-type': 'application/json'
        },
        json={
            'model': MODEL,
            'messages': [{'role': 'user', 'content': prompt}],
            'max_tokens': 2000
        }
    )
    
    if response.ok:
        return response.json()['choices'][0]['message']['content']
    print(f"DeepSeek API 错误：{response.status_code} - {response.text}")
    return None

def call_qwen(prompt):
    """调用通义千问 (阿里云)"""
    api_key = os.getenv('DASHSCOPE_API_KEY')
    if not api_key:
        print("❌ 缺少 DASHSCOPE_API_KEY")
        return None
    
    print(f"🔑 使用模型：{MODEL}")
    print(f"📡 调用 DashScope API...")
    
    # 通义千问 API 格式 (兼容 OpenAI 格式)
    response = requests.post(
        'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
        headers={
            'Authorization': f'Bearer {api_key}',
            'content-type': 'application/json'
        },
        json={
            'model': MODEL,
            'messages': [
                {'role': 'system', 'content': '你是一个专业的代码审查员。请用中文输出 JSON 格式的审查结果。'},
                {'role': 'user', 'content': prompt}
            ],
            'max_tokens': 2000,
            'temperature': 0.3
        }
    )
    
    print(f"📡 API 响应状态码：{response.status_code}")
    
    if response.ok:
        result = response.json()
        content = result['choices'][0]['message']['content']
        print(f"✅ AI 返回内容长度：{len(content)}")
        return content
    
    print(f"❌ Qwen API 错误：{response.status_code}")
    print(f"响应内容：{response.text[:500]}")
    return None

def call_moonshot(prompt):
    """调用 Kimi (月之暗面)"""
    api_key = os.getenv('MOONSHOT_API_KEY')
    if not api_key:
        return None
    
    response = requests.post(
        'https://api.moonshot.cn/v1/chat/completions',
        headers={
            'Authorization': f'Bearer {api_key}',
            'content-type': 'application/json'
        },
        json={
            'model': MODEL,
            'messages': [{'role': 'user', 'content': prompt}],
            'max_tokens': 2000
        }
    )
    
    if response.ok:
        return response.json()['choices'][0]['message']['content']
    print(f"Moonshot API 错误：{response.status_code} - {response.text}")
    return None

def call_zhipu(prompt):
    """调用智谱 GLM"""
    api_key = os.getenv('ZHIPU_API_KEY')
    if not api_key:
        return None
    
    response = requests.post(
        'https://open.bigmodel.cn/api/paas/v4/chat/completions',
        headers={
            'Authorization': f'Bearer {api_key}',
            'content-type': 'application/json'
        },
        json={
            'model': MODEL,
            'messages': [{'role': 'user', 'content': prompt}],
            'max_tokens': 2000
        }
    )
    
    if response.ok:
        return response.json()['choices'][0]['message']['content']
    print(f"Zhipu API 错误：{response.status_code} - {response.text}")
    return None

def call_generic(prompt):
    """调用其他模型（兼容接口）"""
    # 可扩展支持 Ollama、vLLM 等本地模型
    return None

# ============== 发布评论 ==============
def post_review(pr, review_data):
    """发布审查评论到 PR"""
    try:
        data = json.loads(review_data)
    except:
        # AI 返回的不是有效 JSON，直接发文本
        pr.create_issue_comment(
            f"🤖 AI 审查完成（解析失败）:\n\n```\n{review_data}\n```"
        )
        return
    
    # 发布总结评论
    emoji = '✅' if data.get('approved') else '⚠️'
    summary = f"""{emoji} **AI 代码审查完成**

**评分**: {data.get('score', 'N/A')}/10
**总结**: {data.get('summary', '无')}

"""
    
    if data.get('comments'):
        summary += "**详细意见**:\n\n"
        for c in data['comments']:
            icon = {'bug': '🐛', 'security': '🔒', 'performance': '⚡', 'style': '📖', 'question': '❓'}.get(c.get('type'), '💬')
            summary += f"- {icon} `{c.get('file', 'unknown')}`: {c.get('message', '')}\n"
    
    pr.create_issue_comment(summary)
    
    # 发布行内评论（如果有行号）
    for c in data.get('comments', []):
        if c.get('line') and c.get('file'):
            try:
                # 找到对应的 commit
                commits = pr.get_commits()
                latest_commit = commits[0] if commits.totalCount > 0 else None
                if latest_commit:
                    pr.create_review_comment(
                        body=f"{c.get('message', '')}",
                        path=c['file'],
                        position=c['line'],
                        commit=latest_commit
                    )
            except Exception as e:
                pass  # 行内评论失败不影响主评论

# ============== 主函数 ==============
def main():
    github_token = os.getenv('GITHUB_TOKEN')
    if not github_token:
        print("❌ 缺少 GITHUB_TOKEN")
        sys.exit(1)
    
    # 从 GitHub Actions 环境获取 PR 信息
    event_path = os.getenv('GITHUB_EVENT_PATH')
    if not event_path:
        print("❌ 不在 GitHub Actions 环境中")
        sys.exit(1)
    
    with open(event_path) as f:
        event = json.load(f)
    
    if 'pull_request' not in event:
        print("⏭️ 不是 PR 事件，跳过")
        return
    
    pr_number = event['pull_request']['number']
    repo = event['repository']['full_name']
    pr_title = event['pull_request']['title']
    pr_body = event['pull_request'].get('body', '')
    
    print(f"🔍 开始审查 PR #{pr_number}: {pr_title}")
    print(f"📁 仓库：{repo}")
    print(f"🔑 GITHUB_TOKEN: {'已设置' if github_token else '❌ 未设置'}")
    print(f"🔑 DASHSCOPE_API_KEY: {'已设置' if os.getenv('DASHSCOPE_API_KEY') else '❌ 未设置'}")
    print(f"🤖 模型：{MODEL}")
    
    # 获取变更
    files, pr = get_pr_diff(github_token, repo, pr_number)
    if not files:
        print("✅ 没有需要审查的代码变更")
        return
    
    print(f"📄 发现 {len(files)} 个文件变更:")
    for f in files:
        print(f"  - {f['filename']} (+{f['additions']} -{f['deletions']})")
    
    # 调用 AI
    prompt = build_prompt(files, pr_title, pr_body)
    print(f"📝 Prompt 长度：{len(prompt)} 字符")
    print("🤖 正在调用 AI...")
    
    review = call_ai(prompt)
    if not review:
        print("❌ AI 调用失败")
        pr.create_issue_comment("⚠️ AI 审查服务暂时不可用\n\n请检查:\n1. DASHSCOPE_API_KEY 是否正确配置\n2. 查看 workflow 日志获取详细错误")
        return
    
    # 发布评论
    print("📝 发布审查意见...")
    post_review(pr, review)
    print("✅ 审查完成")

if __name__ == '__main__':
    main()
