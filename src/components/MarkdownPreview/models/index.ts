import { mockEventStreamText } from '@/data'
import { sleep } from '@/utils/request'
import { glassAssistantSystemPrompt } from './prompts'

/**
 * 转义处理响应值为 data: 的 json 字符串
 * 如: 科大讯飞星火、Kimi Moonshot 等大模型的 response
 */
export const createParser = () => {
  // 避免服务端持续返回 keep-alive 时，页面重复展示“排队中”提示。
  // 这里用闭包变量记录本轮请求是否已经提示过一次。
  let keepAliveShown = false

  const resetKeepAliveParser = () => {
    keepAliveShown = false
  }

  const parseJsonLikeData = (content) => {
    // 统一兼容几类常见流式数据：
    // 1. SSE 格式：data: {...}
    // 2. 终止信号：[DONE]
    // 3. 直接返回的 JSON 字符串
    // 4. keep-alive 心跳文本

    // 若是终止信号，则直接结束
    if (content === '[DONE]') {
      // 重置 keepAlive 标志
      keepAliveShown = false
      return {
        done: true
      }
    }

    if (content.startsWith('data: ')) {
      // 进入真正的数据片段后，说明当前已不再处于纯排队心跳阶段。
      keepAliveShown = false
      const dataString = content.substring(6).trim()
      if (dataString === '[DONE]') {
        return {
          done: true
        }
      }
      try {
        return JSON.parse(dataString)
      } catch (error) {
        console.error('JSON 解析错误：', error)
      }
    }

    // 尝试直接解析 JSON 字符串
    try {
      const trimmedContent = content.trim()

      if (trimmedContent === ': keep-alive') {
        // 如果还没有显示过 keep-alive 提示，则显示
        if (!keepAliveShown) {
          keepAliveShown = true
          return {
            isWaitQueuing: true
          }
        } else {
          return null
        }
      }

      if (!trimmedContent) {
        return null
      }

      if (trimmedContent.startsWith('{') && trimmedContent.endsWith('}')) {
        return JSON.parse(trimmedContent)
      }
      if (trimmedContent.startsWith('[') && trimmedContent.endsWith(']')) {
        return JSON.parse(trimmedContent)
      }
    } catch (error) {
      console.error('尝试直接解析 JSON 失败：', error)
    }

    return null
  }
  return {
    resetKeepAliveParser,
    parseJsonLikeData
  }
}

export const createStreamThinkTransformer = () => {
  // 标记当前是否正在处理“思考过程”流。
  // 用于在 reasoning_content 与正式回答之间插入 <think> 包裹。
  let isThinking = false

  const resetThinkTransformer = () => {
    isThinking = false
  }

  const transformStreamThinkData = (content) => {
    // 先把原始响应片段统一解析成结构化数据，再做推理模型专属转换。
    const stream = parseJsonLikeData(content)

    if (stream && stream.done) {
      return {
        done: true
      }
    }

    // DeepSeek 存在限速问题，这里做一个简单处理
    // https://api-docs.deepseek.com/zh-cn/quick_start/rate_limit
    if (stream && stream.isWaitQueuing) {
      return {
        isWaitQueuing: stream.isWaitQueuing
      }
    }

    if (!stream || !stream.choices || stream.choices.length === 0) {
      return {
        content: ''
      }
    }

    const delta = stream.choices[0].delta
    // 正式回答文本。
    const contentText = delta.content || ''
    // 推理模型的思考内容。
    const reasoningText = delta.reasoning_content || ''

    let transformedContent = ''

    // 开始处理推理过程
    if (delta.content === null && delta.reasoning_content !== null) {
      if (!isThinking) {
        transformedContent += '<think>'
        isThinking = true
      }
      transformedContent += reasoningText
    }
    // 当 content 出现时，说明推理结束
    else if (delta.content !== null && delta.reasoning_content === null) {
      if (isThinking) {
        transformedContent += '</think>\n\n'
        isThinking = false
      }
      transformedContent += contentText
    }
    // 当为普通模型，即不包含推理字段时，直接追加 content
    else if (delta.content !== null && delta.reasoning_content === undefined) {
      isThinking = false
      transformedContent += contentText
    }

    // 返回统一的增量文本结果，供上层持续追加到打字缓冲区。
    return {
      content: transformedContent
    }
  }

  return {
    resetThinkTransformer,
    transformStreamThinkData
  }
}

const { resetKeepAliveParser, parseJsonLikeData } = createParser()
const { resetThinkTransformer, transformStreamThinkData } = createStreamThinkTransformer()


/**
 * 处理大模型调用暂停、异常或结束后触发的操作。
 * 主要用于清理解析器和推理转换器中的闭包状态，避免下一轮请求串状态。
 */
export const triggerModelTermination = () => {
  resetKeepAliveParser()
  resetThinkTransformer()
}

type ContentResult = {
  content: any
} | {
  done: boolean
}

type DoneResult = {
  content: any
  isWaitQueuing?: any
} & {
  done: boolean
}

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type CrossTransformFunction = (readValue: Uint8Array | string, textDecoder: TextDecoder) => DoneResult

export type TransformFunction = (readValue: Uint8Array | string, textDecoder: TextDecoder) => ContentResult

const normalizeConversationMessages = (messages: ChatMessage[]) => {
  return messages.filter(item => item.content?.trim())
}

const prependSystemMessage = (messages: ChatMessage[], systemPrompt?: string) => {
  const normalizedMessages = normalizeConversationMessages(messages)
  if (!systemPrompt) {
    return normalizedMessages
  }
  return [
    {
      role: 'system',
      content: systemPrompt
    },
    ...normalizedMessages
  ]
}

interface TypesModelLLM {
  // 模型昵称，仅用于前端选择器展示。
  label: string
  // 模型标识符，作为项目内部切换模型的唯一 key。
  modelName: string
  // 流式结果转换器，用来抹平不同模型厂商的返回结构差异。
  transformStreamValue: TransformFunction
  // 发起大模型请求的方法。
  // 多轮会话时，这里直接接收完整对话消息列表。
  chatFetch: (messages: ChatMessage[]) => Promise<Response>
}


/** ---------------- 大模型映射列表 & Response Transform 用于处理不同类型流的值转换器 ---------------- */

/**
 * Mock 模拟模型的 name。
 * 这个值也会影响页面空态文案和默认模型选择。
 */
// export const defaultMockModelName = 'standard'
export const defaultMockModelName = 'deepseek-v4-pro'

/**
 * 项目默认使用模型，按需修改此字段即可。
 * 当前直接复用了 defaultMockModelName。
 */

// export const defaultModelName = 'spark'
export const defaultModelName = defaultMockModelName

export const modelMappingList: TypesModelLLM[] = [
  {
    label: '🧪 模拟数据模型',
    modelName: 'standard',
    transformStreamValue(readValue, textDecoder) {
      // 模拟模型直接把流片段按原样输出，不需要 JSON 结构解析。
      let content = ''
      if (readValue instanceof Uint8Array) {
        content = textDecoder.decode(readValue, {
          stream: true
        })
      } else {
        content = readValue
      }
      return {
        content
      }
    },
    // Mock Event Stream 用于模拟读取大模型接口 Mock 数据
    async chatFetch(messages): Promise<Response> {
      // 模拟 res.body 的数据
      // 将 mockData 转换为 ReadableStream

      const mockReadableStream = new ReadableStream({
        start(controller) {
          // 将每一行数据作为单独的 chunk
          // 这样更接近真实 SSE 分段返回的效果。
          mockEventStreamText.split('\n').forEach(line => {
            controller.enqueue(new TextEncoder().encode(`${ line }\n`))
          })
          controller.close()
        }
      })
      await sleep(500)

      return new Promise((resolve) => {
        resolve({
          body: mockReadableStream
        } as Response)
      })
    }
  },
  {
    label: '🐋 deepseek-v4-pro',
    modelName: 'deepseek-v4-pro',
    transformStreamValue(readValue) {
      // DeepSeek v4-pro 可能返回推理片段、正文片段和等待状态，
      // 因此统一走推理模型转换器。
      const stream = transformStreamThinkData(readValue)
      if (stream.done) {
        return {
          done: true
        }
      }
      if (stream.isWaitQueuing) {
        return {
          isWaitQueuing: stream.isWaitQueuing
        }
      }
      return {
        content: stream.content
      }
    },
    // Event Stream 调用大模型接口 DeepSeek 深度求索 (Fetch 调用)。
    // 当前先统一走本地后端，由后端代管密钥、MCP 和后续 tool calling。
    chatFetch(messages) {
      const url = new URL(`${ location.origin }/local-ai/api/chat`)
      const params = {
      }
      Object.keys(params).forEach(key => {
        url.searchParams.append(key, params[key])
      })
      const req = new Request(url, {
        method: 'post',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          // 普通模型 V4 pro。
          model: 'deepseek-v4-pro',
          stream: true,
          enableMcp: true,
          // 当前项目先以固定行业 skill 约束模型回答风格，
          // 在此基础上把已完成的历史对话一并传给模型，形成多轮上下文。
          messages: prependSystemMessage(messages, glassAssistantSystemPrompt)
        })
      })
      return fetch(req)
    }
  },
  {
    label: '🐋 DeepSeek-R1 (推理模型)',
    modelName: 'deepseek-deep',
    transformStreamValue(readValue) {
      // DeepSeek-R1 会拆分返回 reasoning_content 和 content，
      // 因此也需要走推理模型转换器。
      const stream = transformStreamThinkData(readValue)
      if (stream.done) {
        return {
          done: true
        }
      }
      if (stream.isWaitQueuing) {
        return {
          isWaitQueuing: stream.isWaitQueuing
        }
      }
      return {
        content: stream.content
      }
    },
    // Event Stream 调用大模型接口 DeepSeek 深度求索 (Fetch 调用)。
    // 这里也统一走本地后端，后续如需给推理模型接 MCP，可在服务端继续扩展。
    chatFetch(messages) {
      const url = new URL(`${ location.origin }/local-ai/api/chat`)
      const params = {
      }
      Object.keys(params).forEach(key => {
        url.searchParams.append(key, params[key])
      })

      const req = new Request(url, {
        method: 'post',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          // DeepSeek 推理模型。
          model: 'deepseek-reasoner',
          stream: true,
          enableMcp: true,
          messages: prependSystemMessage(messages, glassAssistantSystemPrompt)
        })
      })
      return fetch(req)
    }
  },
  {
    label: '🦙 Ollama 3 大模型',
    modelName: 'ollama3',
    transformStreamValue(readValue) {
      // Ollama 的正文位于 message.content 中，不是 OpenAI 风格的 delta.content。
      const stream = parseJsonLikeData(readValue)
      if (stream.done) {
        return {
          done: true
        }
      }
      return {
        content: stream.message.content
      }
    },
    // Event Stream 调用大模型接口 Ollama3 (Fetch 调用)。
    // 该模型走本地 Ollama 服务，不依赖远端 API Key。
    chatFetch(messages) {
      const url = new URL(`http://localhost:11434/api/chat`)
      const params = {
      }
      Object.keys(params).forEach(key => {
        url.searchParams.append(key, params[key])
      })

      const req = new Request(url, {
        mode: 'cors',
        method: 'post',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          // 这里可以按需切换成本地 Ollama 已下载的其他模型。
          'model': 'llama3',
          stream: true,
          // Ollama 支持附带 system 提示词，这里预置了一个简单人设。
          messages: prependSystemMessage(messages, '你的名字叫做小O, 全程使用中文回答我的问题。')
        })
      })
      return fetch(req)
    }
  },
  {
    label: '⚡ Spark 星火大模型',
    modelName: 'spark',
    transformStreamValue(readValue) {
      // Spark 的增量正文位于 choices[0].delta.content 中。
      const stream = parseJsonLikeData(readValue)
      if (stream.done) {
        return {
          done: true
        }
      }
      return {
        content: stream.choices[0].delta.content || ''
      }
    },
    // Event Stream 调用大模型接口 Spark 星火认知大模型 (Fetch 调用)。
    // 通过本地代理把 /spark 前缀请求转发到真实服务。
    chatFetch(messages) {
      const url = new URL(`${ location.origin }/spark/v1/chat/completions`)
      const params = {
      }
      Object.keys(params).forEach(key => {
        url.searchParams.append(key, params[key])
      })

      const req = new Request(url, {
        method: 'post',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ import.meta.env.VITE_SPARK_KEY }`
        },
        body: JSON.stringify({
          'model': '4.0Ultra',
          stream: true,
          messages: prependSystemMessage(messages, '你叫小明同学，喜欢探索新的前端知识，目前正在学习 AI 大模型。你可以解决任何前端方面的问题。')
        })
      })
      return fetch(req)
    }
  },
  {
    label: '⚡ SiliconFlow 硅基流动大模型',
    modelName: 'siliconflow',
    transformStreamValue(readValue) {
      // SiliconFlow 兼容 OpenAI 风格流式输出，因此直接解析 delta.content 即可。
      const stream = parseJsonLikeData(readValue)
      if (stream.done) {
        return {
          done: true
        }
      }
      return {
        content: stream.choices[0].delta.content || ''
      }
    },
    // Event Stream 调用大模型接口 SiliconFlow 硅基流动大模型 (Fetch 调用)。
    chatFetch(messages) {
      const url = new URL(`${ location.origin }/siliconflow/v1/chat/completions`)
      const params = {
      }
      Object.keys(params).forEach(key => {
        url.searchParams.append(key, params[key])
      })

      const req = new Request(url, {
        method: 'post',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ import.meta.env.VITE_SILICONFLOW_KEY }`
        },
        body: JSON.stringify({
          // SiliconFlow 平台内的具体模型名，可按账号权限和需求切换。
          'model': 'THUDM/glm-4-9b-chat',
          stream: true,
          messages: normalizeConversationMessages(messages)
        })
      })
      return fetch(req)
    }
  },
  {
    label: '⚡ Kimi Moonshot 月之暗面大模型',
    modelName: 'moonshot',
    transformStreamValue(readValue) {
      // Moonshot 也采用 choices[0].delta.content 作为增量正文。
      const stream = parseJsonLikeData(readValue)
      if (stream.done) {
        return {
          done: true
        }
      }
      return {
        content: stream.choices[0].delta.content || ''
      }
    },
    // Event Stream 调用大模型接口 Kimi Moonshot 月之暗面大模型 (Fetch 调用)。
    chatFetch (messages) {
      const url = new URL(`${ location.origin }/moonshot/v1/chat/completions`)
      const params = {
      }
      Object.keys(params).forEach(key => {
        url.searchParams.append(key, params[key])
      })

      const req = new Request(url, {
        method: 'post',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ import.meta.env.VITE_MOONSHOT_KEY }`
        },
        body: JSON.stringify({
          'model': 'moonshot-v1-8k',
          stream: true,
          messages: prependSystemMessage(messages, '你是 Kimi，由 Moonshot AI 提供的人工智能助手，你更擅长中文和英文的对话。你会为用户提供安全，有帮助，准确的回答。同时，你会拒绝一切涉及恐怖主义，种族歧视，黄色暴力等问题的回答。Moonshot AI 为专有名词，不可翻译成其他语言。')
        })
      })
      return fetch(req)
    }
  }
]
