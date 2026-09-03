import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { createDeepSeekStream } from '../llm/deepseek.js'
import { resolveMcpMessages } from '../mcp/client.js'
import type { ChatRequestBody } from '../types/chat.js'

const writeWebStreamToResponse = async (stream: ReadableStream<Uint8Array>, target: NodeJS.WritableStream) => {
  const reader = stream.getReader()

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue

      const canContinue = target.write(Buffer.from(value))
      if (!canContinue) {
        await new Promise<void>((resolve) => target.once('drain', resolve))
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export const registerChatRoutes = async (app: FastifyInstance) => {
  app.get('/api/health', async () => {
    return {
      ok: true
    }
  })

  app.post<{ Body: ChatRequestBody }>('/api/chat', async (
    request: FastifyRequest<{ Body: ChatRequestBody }>,
    reply: FastifyReply
  ) => {
    const {
      model,
      messages,
      stream = true,
      enableMcp = true
    } = request.body || {}

    if (!model || !Array.isArray(messages) || !messages.length) {
      reply.code(400)
      return {
        error: 'model and messages are required.'
      }
    }

    const resolved = await resolveMcpMessages(messages, enableMcp)
    const upstreamResponse = await createDeepSeekStream({
      model,
      messages: resolved.messages,
      stream
    })

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive'
    })

    if (!upstreamResponse.body) {
      throw new Error('DeepSeek upstream returned empty stream body.')
    }

    await writeWebStreamToResponse(upstreamResponse.body, reply.raw)
    reply.raw.end()

    return reply
  })
}
