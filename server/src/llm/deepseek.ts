import type { ChatMessage } from '../types/chat.js'
import { serverConfig } from '../config.js'

type StreamChatParams = {
  model: string
  messages: ChatMessage[]
  stream?: boolean
}

export const createDeepSeekStream = async ({ model, messages, stream = true }: StreamChatParams) => {
  const upstreamResponse = await fetch(`${ serverConfig.deepseekBaseUrl }/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ serverConfig.deepseekApiKey }`
    },
    body: JSON.stringify({
      model,
      stream,
      messages
    }),
    // 90s 超时，避免上游无响应时请求永久挂起。
    signal: AbortSignal.timeout(90000)
  })

  if (!upstreamResponse.ok) {
    const errorText = await upstreamResponse.text()
    // 尽量从上游错误 JSON 中提取可读的 message，便于前端直接弹窗展示。
    let detail = errorText
    try {
      const parsed = JSON.parse(errorText)
      if (parsed?.error?.message) detail = parsed.error.message
    } catch {}
    throw new Error(`DeepSeek 上游请求失败 (${ upstreamResponse.status })：${ detail }`)
  }

  if (!upstreamResponse.body) {
    throw new Error('DeepSeek upstream returned empty body.')
  }

  return upstreamResponse
}
