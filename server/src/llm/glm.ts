import { type ChatMessage, extractTextContent } from '../types/chat.js'
import { serverConfig } from '../config.js'

type StreamChatParams = {
  messages: ChatMessage[]
  stream?: boolean
}

// 读取并打印 GLM 流式响应内容，便于在控制台观察出参。
// 这里消费的是 tee 分流出来的一份副本，不影响转发给前端的原始流。
const logGlmResponse = async (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) buffer += decoder.decode(value, {
        stream: true
      })
    }
    buffer += decoder.decode()
    console.log('[GLM] 响应内容:', buffer)
  } catch (error) {
    console.log('[GLM] 响应读取中断:', error)
  }
}

export const createGlmStream = async ({ messages, stream = true }: StreamChatParams) => {
  const requestBody = {
    // 统一使用智谱视觉模型，无论是否携带图片。
    model: 'glm-4-flash',
    stream,
    messages
  }

  // 打印请求参数（不含 Authorization 鉴权信息）。
  console.log('[GLM] 请求参数:', JSON.stringify(requestBody, null, 2))

  const upstreamResponse = await fetch(`${ serverConfig.glmBaseUrl }/v4/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ serverConfig.glmApiKey }`
    },
    body: JSON.stringify(requestBody),
    // 90s 超时，避免上游无响应时请求永久挂起。
    signal: AbortSignal.timeout(600000)
  })

  if (!upstreamResponse.ok) {
    const errorText = await upstreamResponse.text()
    // 尽量从上游错误 JSON 中提取可读的 message，便于前端直接弹窗展示。
    let detail = errorText
    try {
      const parsed = JSON.parse(errorText)
      if (parsed?.error?.message) detail = parsed.error.message
    } catch {}
    throw new Error(`GLM 上游请求失败 (${ upstreamResponse.status })：${ detail }`)
  }

  if (!upstreamResponse.body) {
    throw new Error('GLM upstream returned empty body.')
  }

  // 分流响应体：一份打印出参，一份继续返回给上层转发，两者互不影响。
  const [logStream, forwardStream] = upstreamResponse.body.tee()
  void logGlmResponse(logStream)

  return new Response(forwardStream)
}

// 智谱独立 Web Search API 返回的单个搜索结果。
type GlmWebSearchResult = {
  title?: string
  content?: string
  link?: string
  media?: string
  icon?: string
  refer?: string
  publish_date?: string
}

// 智谱独立 Web Search API 响应结构（仅保留本项目需要的字段）。
type GlmWebSearchResponse = {
  search_intent?: Array<{
    intent?: 'SEARCH_ALL' | 'SEARCH_NONE' | 'SEARCH_ALWAYS'
    keywords?: string
    query?: string
  }>
  search_result?: GlmWebSearchResult[]
}

// 调用智谱独立搜索接口，获取结构化的网页结果。
// 与「对话中的 web_search 工具」不同，该接口按次计费、与模型无关。
export const createGlmWebSearch = async (query: string) => {
  const response = await fetch(`${ serverConfig.glmBaseUrl }/v4/web_search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ serverConfig.glmApiKey }`
    },
    body: JSON.stringify({
      search_query: query.slice(0, 70),
      search_engine: 'search_std',
      search_intent: false
    }),
    signal: AbortSignal.timeout(600000)
  })

  if (!response.ok) {
    const errorText = await response.text()
    let detail = errorText
    try {
      const parsed = JSON.parse(errorText)
      if (parsed?.error?.message) detail = parsed.error.message
    } catch {}
    throw new Error(`GLM 搜索上游请求失败 (${ response.status })：${ detail }`)
  }

  return await response.json() as GlmWebSearchResponse
}

// 把搜索结果整理成便于模型阅读的纯文本。
const formatWebSearchResults = (results: GlmWebSearchResult[]) => {
  return results.map((item, index) => {
    const title = item.title || '无标题'
    const media = item.media ? `（${ item.media }）` : ''
    const content = item.content || ''
    const link = item.link || ''
    return [
      `${ index + 1 }. ${ title }${ media }`,
      content,
      link ? `来源：${ link }` : ''
    ].filter(Boolean).join('\n')
  }).join('\n\n')
}

// 根据最后一条用户消息联网搜索，并把结果作为 system message 注入。
// search_intent=false 表示跳过意图识别、强制搜索，每次 GLM 请求都会执行搜索。
export const resolveGlmWebSearchMessages = async (messages: ChatMessage[]) => {
  const query = extractTextContent([...messages].reverse().find(message => message.role === 'user')?.content ?? '').trim()
  console.log('[GLM] 原始查询:', query)
  if (!query) {
    return {
      messages,
      toolCalls: []
    }
  }

  try {
    console.log('[GLM] 搜索查询:', query)
    const result = await createGlmWebSearch(query)
    console.log('[GLM] 搜索结果:', result)
    const intents = result.search_intent || []
    const hasNoIntent = intents.length > 0 && intents.every(item => item.intent === 'SEARCH_NONE')
    if (hasNoIntent || !result.search_result?.length) {
      return {
        messages,
        toolCalls: []
      }
    }

    const searchMessage: ChatMessage = {
      role: 'system',
      content: [
        '本轮已调用联网搜索，请优先基于下面的搜索结果回答，并在回答中标注信息来源。',
        '如果搜索结果不足以回答，请明确指出。',
        '',
        '搜索结果：',
        formatWebSearchResults(result.search_result)
      ].join('\n')
    }

    return {
      messages: [...messages, searchMessage],
      toolCalls: ['glm-web-search']
    }
  } catch (error) {
    // 搜索失败时不阻断主链路，只提醒模型如实说明，不要编造实时信息。
    const fallbackMessage: ChatMessage = {
      role: 'system',
      content: '本轮尝试调用联网搜索但失败了。请如实告知用户暂时无法获取实时信息，不要编造。'
    }
    return {
      messages: [...messages, fallbackMessage],
      toolCalls: ['glm-web-search-error']
    }
  }
}
