import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { createDeepSeekStream } from '../llm/deepseek.js'
import { createNewApiStream } from '../llm/newapi.js'
import { createGlmStream, resolveGlmWebSearchMessages } from '../llm/glm.js'
import { resolveMcpMessages } from '../mcp/client.js'
import { resolveLayoutMessages, shouldGenerateLayout } from '../tools/layoutGenerate.js'
import { resolveInventoryMessages } from '../tools/inventory.js'
import { resolveOrderMessages } from '../tools/order.js'
import { resolveWeatherMessages } from '../tools/weather.js'
import { type ChatMessage, type ChatRequestBody, extractTextContent } from '../types/chat.js'

const withBusinessDataContext = (messages: ChatMessage[]) => {
  const authContent = [
    '当前项目的业务数据查询默认优先使用本地 mock 数据，不再依赖 SaaS 登录态。',
    '如果本轮消息中已经提供库存、订单等业务明细，必须直接基于这些数据回答。',
    '业务查询结果必须同时包含简短摘要和 Markdown 明细表，不得只返回摘要；必须保留工具提供的全部明细行，不得合并、省略或虚构记录。',
    '如果工具明确说明当前没有本地数据，请直接如实告知用户，不要提示登录。'
  ].join('\n')

  const firstSystemIndex = messages.findIndex(message => message.role === 'system')
  if (firstSystemIndex < 0) {
    return [{
      role: 'system' as const,
      content: authContent
    }, ...messages]
  }

  return messages.map((message, index) => {
    if (index !== firstSystemIndex) return message
    const original = extractTextContent(message.content)
    return {
      ...message,
      content: original ? `${ original }\n${ authContent }` : authContent
    }
  })
}

// 将 fetch 返回的 Web ReadableStream 写入 Node.js 的响应流。
// Fastify 的 reply.raw 本质上是 Node 的原始响应对象，而上游 fetch 返回的是 Web Stream，
// 因此这里做一层桥接，把上游流式内容持续转发给前端。
const writeWebStreamToResponse = async (stream: ReadableStream<Uint8Array>, target: NodeJS.WritableStream) => {
  const reader = stream.getReader()

  try {
    while (true) {
      const { done, value } = await reader.read()
      // done 为 true 说明上游流已经结束，可以退出循环。
      if (done) break
      // 某些实现里可能读到空块，直接跳过即可。
      if (!value) continue

      const canContinue = target.write(Buffer.from(value))
      // 当底层缓冲区已满时，write 会返回 false。
      // 这里等待 drain 事件，避免持续写入导致内存压力或数据堆积。
      if (!canContinue) {
        await new Promise<void>((resolve) => target.once('drain', resolve))
      }
    }
  } finally {
    // 释放 reader 锁，避免流资源长期占用。
    reader.releaseLock()
  }
}

export const registerChatRoutes = async (app: FastifyInstance) => {
  // 健康检查接口，便于本地开发或部署后快速确认服务是否启动成功。
  app.get('/api/health', async () => {
    return {
      ok: true
    }
  })

  // 聊天主接口：
  // 1. 接收前端发来的模型名称和消息列表
  // 2. 按需调用 MCP 工具增强上下文
  // 3. 将整理后的消息发送给 DeepSeek 上游
  // 4. 把上游流式响应原样转发给前端
  app.post<{ Body: ChatRequestBody; }>('/api/chat', async (
    request: FastifyRequest<{ Body: ChatRequestBody; }>,
    reply: FastifyReply
  ) => {
    // 从请求体里解构出本轮对话所需参数。
    // stream 和 enableMcp 提供默认值，确保前端不传时也有稳定行为。
    const {
      model,
      messages,
      stream = true,
      enableMcp = true
    } = request.body || {}

    // 最基础的参数校验：
    // - model 必须存在
    // - messages 必须是非空数组
    // 当前这里做的是轻量校验，更细的消息内容约束暂未展开。
    if (!model || !Array.isArray(messages) || !messages.length) {
      reply.code(400)
      return {
        error: 'model and messages are required.'
      }
    }
    const isLayoutRequest = await shouldGenerateLayout(messages)
    const writeLayoutProgress = (message: string) => {
      reply.raw.write(`data: ${ JSON.stringify({
        type: 'layout-progress',
        message
      }) }\n\n`)
    }

    if (isLayoutRequest) {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive'
      })
    }

    // 识别为套料意图后，先推送真实处理进度，再将摘要交给模型生成解读。
    const layoutResolved = await resolveLayoutMessages(
      request,
      messages,
      isLayoutRequest,
      isLayoutRequest ? writeLayoutProgress : undefined
    )

    // 未命中排版时，再判断是否命中天气类问题。
    const weatherResolved = layoutResolved.toolCalls.length
      ? layoutResolved
      : await resolveWeatherMessages(messages)
    // 未命中排版和天气时，再按当前用户登录会话查询库存。
    const inventoryResolved = weatherResolved.toolCalls.length
      ? weatherResolved
      : await resolveInventoryMessages(request, messages)
    // 未命中排版、天气和库存时，再按当前用户登录会话查询订单。
    const orderResolved = inventoryResolved.toolCalls.length
      ? inventoryResolved
      : await resolveOrderMessages(request, messages)
    // 未命中业务工具时，再根据问题内容判断是否走 MCP 增强。
    const resolved = orderResolved.toolCalls.length
      ? orderResolved
      : await resolveMcpMessages(messages, enableMcp)
    const messagesWithAuth = withBusinessDataContext(resolved.messages)
    // 根据模型名称选择上游：glm 开头走智谱 GLM，其余走 DeepSeek。
    // 上游异常时返回 502 + 可读错误信息，便于前端弹窗提示。
    let upstreamResponse: Response
    try {
      const isGlmModel = /^glm/i.test(model)
      const isNewApiModel = model === 'new-api'
      // GLM 走独立搜索接口增强上下文；无搜索意图时 resolver 原样返回消息，不产生额外开销。
      const messagesForModel = isGlmModel && !layoutResolved.layout
        ? (await resolveGlmWebSearchMessages(messagesWithAuth)).messages
        : messagesWithAuth
      upstreamResponse = isGlmModel
        ? await createGlmStream({
          messages: messagesForModel,
          stream
        })
        : isNewApiModel
          ? await createNewApiStream({
            model,
            messages: messagesForModel,
            stream
          })
          : await createDeepSeekStream({
            model,
            messages: messagesForModel,
            stream
          })
    } catch (error) {
      reply.code(502)
      return {
        error: error instanceof Error ? error.message : '上游模型请求失败'
      }
    }

    // 非排版请求在上游连接建立后写入 SSE 响应头；排版请求已提前建立连接以展示进度。
    if (!isLayoutRequest) {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive'
      })
    }

    // 正常情况下上游应该提供 body 供我们持续转发。
    // 如果 body 为空，说明上游返回结果不符合预期。
    if (!upstreamResponse.body) {
      throw new Error('DeepSeek upstream returned empty stream body.')
    }

    // 排版算法完成后先推送结果卡片，再继续流式输出 AI 解读。
    if (layoutResolved.layout) {
      reply.raw.write(`data: ${ JSON.stringify({
        type: 'layout',
        data: layoutResolved.layout
      }) }\n\n`)
      writeLayoutProgress('排版完成，正在生成方案解读…')
    }

    // 持续把上游流写给前端，直到上游结束。
    await writeWebStreamToResponse(upstreamResponse.body, reply.raw)
    // 主动结束响应，通知前端本轮流式输出完成。
    reply.raw.end()

    // 返回 reply 供 Fastify 完成本次请求生命周期。
    return reply
  })
}
