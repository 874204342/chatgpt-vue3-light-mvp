import type { ChatMessage } from '../types/chat.js'

type ToolResolutionResult = {
  messages: ChatMessage[]
  toolCalls: string[]
}

const shouldCallMcp = (messages: ChatMessage[]) => {
  const lastUserMessage = [...messages].reverse().find(message => message.role === 'user')
  if (!lastUserMessage?.content) return false

  // 这里只做最小骨架预留，后续接入真正 MCP 时可以替换成 tool_calls 或 Agent loop。
  return /apifox|接口|api|字段|请求参数|响应参数/i.test(lastUserMessage.content)
}

export const resolveMcpMessages = async (messages: ChatMessage[], enableMcp = true): Promise<ToolResolutionResult> => {
  if (!enableMcp || !shouldCallMcp(messages)) {
    return {
      messages,
      toolCalls: []
    }
  }

  const toolHintMessage: ChatMessage = {
    role: 'system',
    content: [
      '检测到当前问题可能需要查询 MCP 工具。',
      '当前后端已预留 MCP 接入点，但尚未绑定具体工具执行逻辑。',
      '后续接入 Apifox MCP 后，可在这里先查询接口定义，再把工具结果继续拼回 messages。'
    ].join('\n')
  }

  return {
    messages: [...messages, toolHintMessage],
    toolCalls: ['mcp-placeholder']
  }
}
