export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string
  name?: string
}

export type ChatRequestBody = {
  model: string
  messages: ChatMessage[]
  stream?: boolean
  enableMcp?: boolean
}
