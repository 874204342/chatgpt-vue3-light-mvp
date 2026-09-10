// 多模态内容片段。
// 当前只支持文本与图片（base64 data URL），后续可扩展文件类片段。
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

// 单条聊天消息的数据结构。
// 这个类型既用于前端传给服务端的历史消息，也用于服务端在调用模型前
// 追加 system/tool 等上下文消息，因此这里的字段需要兼容多种消息来源。
export type ChatMessage = {
  // 消息角色：
  // - system: 系统提示词，用于约束模型行为
  // - user: 用户输入
  // - assistant: 模型回复
  // - tool: 工具调用结果或工具返回内容
  role: 'system' | 'user' | 'assistant' | 'tool'
  // 当前消息的内容，兼容纯文本与多模态（文本 + 图片）两种结构。
  content: string | ChatContentPart[]
  // 当消息和某次工具调用关联时，使用该字段标记对应的调用 ID。
  // 当前服务端没有主动构造该字段，但保留这个定义有利于后续接入标准工具调用协议。
  tool_call_id?: string
  // 可选的名称字段。
  // 常见用途包括标记 tool 名称，或为某些特殊 system/tool 消息附加来源信息。
  name?: string
}

// 从消息内容中提取纯文本，供关键词判断、搜索等逻辑复用。
export const extractTextContent = (content: ChatMessage['content']): string => {
  if (typeof content === 'string') return content
  return content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map(part => part.text)
    .join('\n')
}

// 聊天接口请求体。
// 服务端会读取这里的参数，并决定是否先经过 MCP 增强，再转发给上游模型服务。
export type ChatRequestBody = {
  // 要调用的模型名称，例如某个具体的 DeepSeek 模型 ID。
  model: string
  // 当前会话的消息列表，通常包含历史上下文和本轮用户问题。
  messages: ChatMessage[]
  // 是否要求上游按流式方式返回。
  // 在当前项目里默认值为 true，且路由层会按流式 SSE 方式向前端输出。
  stream?: boolean
  // 是否启用 MCP 增强。
  // 开启后，服务端会根据用户问题内容判断是否尝试调用 Apifox MCP，
  // 并把工具结果整理为 system message 后再发送给模型。
  enableMcp?: boolean
}
