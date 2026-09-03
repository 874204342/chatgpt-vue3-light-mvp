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
    })
  })

  if (!upstreamResponse.ok) {
    const errorText = await upstreamResponse.text()
    throw new Error(`DeepSeek upstream failed: ${ upstreamResponse.status } ${ errorText }`)
  }

  if (!upstreamResponse.body) {
    throw new Error('DeepSeek upstream returned empty body.')
  }

  return upstreamResponse
}
