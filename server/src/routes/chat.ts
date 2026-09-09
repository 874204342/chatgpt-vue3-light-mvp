import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { createDeepSeekStream } from '../llm/deepseek.js'
import { createGlmStream, resolveGlmWebSearchMessages } from '../llm/glm.js'
import { resolveMcpMessages } from '../mcp/client.js'
import { resolveWeatherMessages } from '../tools/weather.js'
import type { ChatRequestBody } from '../types/chat.js'

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

    // 先判断是否命中天气类问题：命中时调用 Open-Meteo 查询实时天气，
    // 并把结果以 system message 形式注入，让模型基于真实数据回答。
    const weatherResolved = await resolveWeatherMessages(messages)
    // 未命中天气时，再根据问题内容判断是否走 MCP 增强。
    // 如果命中 Apifox 类问题，会在消息列表里追加一条 system message，
    // 把工具查询结果提供给模型作为额外依据。
    const resolved = weatherResolved.toolCalls.length
      ? weatherResolved
      : await resolveMcpMessages(messages, enableMcp)
    // 根据模型名称选择上游：glm 开头走智谱 GLM，其余走 DeepSeek。
    // 上游异常时返回 502 + 可读错误信息，便于前端弹窗提示。
    let upstreamResponse: Response
    try {
      const isGlmModel = /^glm/i.test(model)
      // GLM 走独立搜索接口增强上下文；无搜索意图时 resolver 原样返回消息，不产生额外开销。
      const messagesForModel = isGlmModel
        ? (await resolveGlmWebSearchMessages(resolved.messages)).messages
        : resolved.messages
      upstreamResponse = isGlmModel
        ? await createGlmStream({
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

    // 明确告诉前端这是一个 SSE 风格的长连接流式响应。
    // 当前实现无论 stream 参数是否为 false，最终都按流式响应头写回。
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive'
    })

    // 正常情况下上游应该提供 body 供我们持续转发。
    // 如果 body 为空，说明上游返回结果不符合预期。
    if (!upstreamResponse.body) {
      throw new Error('DeepSeek upstream returned empty stream body.')
    }

    // 持续把上游流写给前端，直到上游结束。
    await writeWebStreamToResponse(upstreamResponse.body, reply.raw)
    // 主动结束响应，通知前端本轮流式输出完成。
    reply.raw.end()

    // 返回 reply 供 Fastify 完成本次请求生命周期。
    return reply
  })
}
