---
name: "deepseek-sse-helper"
description: "Helps analyze DeepSeek SSE streaming flow in this repo. Invoke when user asks about stream parsing, env config, or MarkdownPreview request flow."
---

# DeepSeek SSE Helper

## Purpose
帮助分析当前项目里 DeepSeek 的流式响应链路，重点包括：
- fetch 请求发起
- SSE 流式数据解析
- reader/read() 消费过程
- MarkdownPreview 渐进渲染
- env.local 中的 key 配置读取

## When to Use
- 用户提到 DeepSeek
- 用户提到 SSE、流式输出、ReadableStream、getReader、pipeThrough
- 用户询问 env.local、VITE_DEEPSEEK_KEY、前端如何读取 key
- 用户要求排查当前项目里的流式请求问题

## Required Context
优先阅读这些文件：
- `src/components/MarkdownPreview/models/index.ts`
- `src/components/MarkdownPreview/transform/index.ts`
- `src/components/MarkdownPreview/index.vue`
- `src/store/business/index.ts`

## Instructions
- 默认使用中文回答
- 先给结论，再解释调用链
- 优先结合本项目真实代码回答，不泛泛而谈
- 引用代码时提供具体文件路径和行号
- 如果用户当前只用 DeepSeek，优先按单一 SSE 协议分析
- 不输出任何真实 key、token 或隐私信息
- 若发现 `.env.template` 中包含真实 key，明确提醒替换并轮换密钥

## Output Style
- 简洁
- 结构化
- 以“当前项目里实际怎么走”为主