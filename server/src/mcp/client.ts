import fs from 'node:fs/promises'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { ChatMessage } from '../types/chat.js'

// mcp.config.json 中单个 MCP 服务的配置结构。
// 当前项目主要关注 apifox 服务，因此这里只抽象出启动子进程所需的最小字段。
type McpServerConfig = {
  command: string
  args?: string[]
  env?: Record<string, string>
}

// MCP 配置文件整体结构。
type McpConfigFile = {
  mcpServers?: Record<string, McpServerConfig>
}

// MCP 处理完成后返回给路由层的结果。
// messages 是可能被增强过的消息列表；
// toolCalls 主要用于记录本轮是否真的触发过工具。
type ToolResolutionResult = {
  messages: ChatMessage[]
  toolCalls: string[]
}

// 缓存中的 MCP 客户端对象。
// transport 一并缓存，便于客户端和底层进程生命周期保持一致。
type CachedMcpClient = {
  client: Client
  transport: StdioClientTransport
}

// MCP 配置文件路径，默认从服务端项目根目录读取。
const mcpConfigPath = path.resolve(process.cwd(), 'mcp.config.json')
// 简单的内存缓存，避免每轮对话都重复启动同一个 MCP 子进程。
const clientCache = new Map<string, CachedMcpClient>()

// 根据最后一条用户消息做一个轻量判断，决定本轮是否值得尝试调用 MCP。
// 当前规则偏向“接口/API 文档问答”场景，目的是在成本和收益之间做一个简单平衡。
const shouldCallMcp = (messages: ChatMessage[]) => {
  const lastUserMessage = [...messages].reverse().find(message => message.role === 'user')
  if (!lastUserMessage?.content) return false

  return /apifox|接口|api|字段|请求参数|响应参数|接口文档|schema/i.test(lastUserMessage.content)
}

// 读取本地 mcp.config.json。
// 这里故意在异常时返回 null，而不是直接抛错：
// 因为 MCP 对当前项目来说是增强能力，不应该因为配置缺失导致聊天主流程中断。
const readMcpConfig = async (): Promise<McpConfigFile | null> => {
  try {
    const rawText = await fs.readFile(mcpConfigPath, 'utf-8')
    return JSON.parse(rawText) as McpConfigFile
  } catch (error) {
    return null
  }
}

// 读取 Apifox MCP 的配置。
// 当前项目只接入了 apifox，因此这里直接做定向提取。
const getApifoxConfig = async () => {
  const mcpConfig = await readMcpConfig()
  return mcpConfig?.mcpServers?.apifox || null
}

// 获取 Apifox MCP 客户端。
// 如果缓存里已经存在，就直接复用；否则按配置启动新的 stdio transport 并建立连接。
const getApifoxClient = async () => {
  const cached = clientCache.get('apifox')
  if (cached) {
    return cached.client
  }

  const apifoxConfig = await getApifoxConfig()
  // 没有配置时直接跳过 MCP，不影响主流程。
  if (!apifoxConfig) {
    return null
  }

  const client = new Client(
    {
      name: 'chatgpt-vue3-light-mvp-server',
      version: '0.0.1'
    },
    {
      capabilities: {}
    }
  )

  // 通过 stdio 方式启动 MCP 服务进程。
  // 这种方式适合本地开发环境，不需要额外的网络端口管理。
  const transport = new StdioClientTransport({
    command: apifoxConfig.command,
    args: apifoxConfig.args || [],
    env: {
      // 继承当前进程环境变量，并允许 mcp.config.json 追加覆盖。
      ...process.env,
      ...(apifoxConfig.env || {})
    } as Record<string, string>
  })

  // 90s 超时，避免 MCP 进程启动失败或握手挂起时永久等待。
  await client.connect(transport, { timeout: 90000 })

  // 连接建立后立即缓存，后续会话可直接复用。
  clientCache.set('apifox', {
    client,
    transport
  })

  return client
}

// 取最后一条 user 消息，作为 MCP 查询的主要输入。
const extractLastUserMessage = (messages: ChatMessage[]) => {
  return [...messages].reverse().find(message => message.role === 'user')?.content || ''
}

// 把 MCP 工具返回值尽量归一化成纯文本，方便注入到 system message。
// 之所以统一成文本，是因为当前下游模型接口最终接收的仍是 message.content 字符串。
const normalizeToolResultText = (result: any) => {
  if (!result) return ''

  if (Array.isArray(result.content)) {
    return result.content
      .map((item: any) => {
        if (item?.type === 'text') {
          return item.text || ''
        }
        if (item?.text) {
          return item.text
        }
        return JSON.stringify(item)
      })
      .filter(Boolean)
      .join('\n')
  }

  if (result.structuredContent) {
    return JSON.stringify(result.structuredContent, null, 2)
  }

  return JSON.stringify(result, null, 2)
}

// 选择并调用一个合适的 Apifox 工具。
// 当前策略比较轻量：
// 1. 先拉取工具列表
// 2. 优先选择名称/描述里更像“查询接口文档”的工具
// 3. 把用户最后一条问题同时映射到多个常见参数名，兼容不同工具的入参习惯
const callApifoxTool = async (messages: ChatMessage[]) => {
  const client = await getApifoxClient()
  if (!client) {
    return null
  }

  const toolList = await client.listTools()
  const apifoxTools = toolList.tools || []
  // 工具列表为空时没有可调用目标，直接返回空结果。
  if (!apifoxTools.length) {
    return null
  }

  const preferredTool = apifoxTools.find(tool =>
    /api|接口|project|search|query|doc/i.test(tool.name + tool.description)
  ) || apifoxTools[0]

  const userQuestion = extractLastUserMessage(messages)
  const toolArguments = {
    query: userQuestion,
    keyword: userQuestion,
    text: userQuestion
  }

  // 这里不依赖某个固定 schema，而是用一组宽松参数名兼容不同工具实现。
  const callResult = await client.callTool({
    name: preferredTool.name,
    arguments: toolArguments
  })

  return {
    toolName: preferredTool.name,
    resultText: normalizeToolResultText(callResult),
    availableToolNames: apifoxTools.map(tool => tool.name)
  }
}

// 根据当前消息列表决定是否做 MCP 增强。
// 增强方式不是直接把工具结果返回前端，而是把结果包装成一条 system message，
// 让模型在原始上下文基础上“带着工具证据”继续作答。
export const resolveMcpMessages = async (messages: ChatMessage[], enableMcp = true): Promise<ToolResolutionResult> => {
  // 用户关闭 MCP，或当前问题明显不是接口文档类问题时，直接返回原消息。
  if (!enableMcp || !shouldCallMcp(messages)) {
    return {
      messages,
      toolCalls: []
    }
  }

  try {
    const toolResult = await callApifoxTool(messages)
    // 工具未返回有效文本时，不强行注入无意义上下文。
    if (!toolResult?.resultText) {
      return {
        messages,
        toolCalls: []
      }
    }

    // 把工具结果作为 system message 注入到消息列表末尾，
    // 明确要求模型优先依据工具内容回答，从而减少“编造接口字段”的概率。
    const mcpSystemMessage: ChatMessage = {
      role: 'system',
      content: [
        `本轮已调用 MCP 工具：${ toolResult.toolName }`,
        '请优先基于下面的 Apifox 工具结果回答，不要编造接口字段、参数或返回结构。',
        '如果工具结果不足以回答，请明确指出还缺少哪些信息。',
        '',
        'Apifox 工具结果：',
        toolResult.resultText
      ].join('\n')
    }

    return {
      messages: [...messages, mcpSystemMessage],
      toolCalls: [toolResult.toolName]
    }
  } catch (error) {
    // MCP 失败时不阻断主链路，而是追加一条兜底 system message，
    // 提醒模型在缺乏确定依据时不要编造接口信息。
    const fallbackMessage: ChatMessage = {
      role: 'system',
      content: '本轮原本尝试调用 Apifox MCP，但工具执行失败。请不要编造接口信息，若缺少确定依据，请明确说明。'
    }

    return {
      messages: [...messages, fallbackMessage],
      toolCalls: ['apifox-error']
    }
  }
}
