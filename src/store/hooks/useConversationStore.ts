import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { ChatContentPart, ChatMessage } from '@/components/MarkdownPreview/models'
import type { LayoutResult } from '@/views/card/index.vue'
import { store } from '@/store'

const LOCAL_STORAGE_KEY = 'chat-conversation-store-v1'

export interface ConversationMessage extends Omit<ChatMessage, 'content'> {
  id: string
  content: string | ChatContentPart[]
  createdAt: string
  // 排版会话需要把结构化结果一起持久化，刷新后仍可恢复卡片展示。
  layout?: LayoutResult | null
}

export interface ConversationRecord {
  id: string
  title: string
  model: string
  summary: string
  createdAt: string
  updatedAt: string
  lastMessageAt: string
  messages: ConversationMessage[]
}

type ConversationStoreState = {
  conversations: ConversationRecord[]
  activeConversationId: string
}

type CreateConversationInput = {
  title?: string
  model?: string
}

type AppendConversationMessageInput = {
  conversationId: string
  role: ConversationMessage['role']
  content: ConversationMessage['content']
  layout?: LayoutResult | null
}

const createId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${ Date.now() }-${ Math.random().toString(36).slice(2, 10) }`
}

const extractMessageText = (content: ConversationMessage['content']) => {
  if (typeof content === 'string') return content.trim()
  return content
    .filter((part): part is {
      type: 'text'
      text: string
    } => part.type === 'text')
    .map(part => part.text.trim())
    .filter(Boolean)
    .join('\n')
}

const sanitizeConversationPreviewText = (text: string) => {
  // 左侧会话摘要只保留面向用户的可见内容，过滤模型内部思考标签与常见 Markdown 噪声。
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
    .replace(/<\/?think>/gi, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/^\s{0,3}[>#*-]\s?/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const buildConversationTitle = (messages: ConversationMessage[]) => {
  const firstUserText = messages
    .find(item => item.role === 'user')
  const titleText = firstUserText ? extractMessageText(firstUserText.content) : ''
  if (!titleText) return '新对话'

  return titleText
    .replace(/\s+/g, ' ')
    .slice(0, 18)
}

const buildConversationSummary = (messages: ConversationMessage[]) => {
  const latestMessage = [...messages]
    .reverse()
    .find(item => item.role === 'assistant' || item.role === 'user')
  if (!latestMessage) return ''

  return sanitizeConversationPreviewText(extractMessageText(latestMessage.content))
    .slice(0, 48)
}

const createEmptyConversationRecord = (input: CreateConversationInput = {}): ConversationRecord => {
  const now = new Date().toISOString()
  return {
    id: createId(),
    title: input.title || '新对话',
    model: input.model || '',
    summary: '',
    createdAt: now,
    updatedAt: now,
    lastMessageAt: now,
    messages: []
  }
}

const normalizeConversationRecord = (item: ConversationRecord): ConversationRecord => {
  const messages = Array.isArray(item.messages) ? item.messages : []
  const title = buildConversationTitle(messages) || item.title || '新对话'
  const summary = buildConversationSummary(messages) || item.summary || ''
  const lastMessageAt = messages.at(-1)?.createdAt || item.lastMessageAt || item.updatedAt || item.createdAt

  return {
    ...item,
    title,
    summary,
    updatedAt: item.updatedAt || item.createdAt,
    lastMessageAt: lastMessageAt || item.createdAt,
    messages
  }
}

const readConversationState = (): ConversationStoreState | null => {
  if (typeof window === 'undefined') return null

  try {
    const rawValue = window.localStorage.getItem(LOCAL_STORAGE_KEY)
    if (!rawValue) return null

    const parsedValue = JSON.parse(rawValue) as Partial<ConversationStoreState>
    const conversations = Array.isArray(parsedValue.conversations)
      ? parsedValue.conversations.map(item => normalizeConversationRecord(item as ConversationRecord))
      : []
    const activeConversationId = typeof parsedValue.activeConversationId === 'string'
      ? parsedValue.activeConversationId
      : conversations[0]?.id || ''

    return {
      conversations,
      activeConversationId
    }
  } catch {
    return null
  }
}

const writeConversationState = (state: ConversationStoreState) => {
  if (typeof window === 'undefined') return

  window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(state))
}

export const useConversationStore = defineStore('conversation-store', () => {
  const conversations = ref<ConversationRecord[]>([])
  const activeConversationId = ref('')
  const initialized = ref(false)

  const sortedConversations = computed(() => {
    return [...conversations.value]
      .sort((prev, next) => new Date(next.updatedAt).getTime() - new Date(prev.updatedAt).getTime())
  })

  const activeConversation = computed(() => {
    return conversations.value.find(item => item.id === activeConversationId.value) || null
  })

  const persistState = () => {
    writeConversationState({
      conversations: conversations.value,
      activeConversationId: activeConversationId.value
    })
  }

  const ensureActiveConversation = (defaultModel = '') => {
    if (activeConversation.value) return activeConversation.value

    const nextConversation = createEmptyConversationRecord({
      model: defaultModel
    })
    conversations.value = [nextConversation]
    activeConversationId.value = nextConversation.id
    persistState()
    return nextConversation
  }

  const hydrate = (defaultModel = '') => {
    if (initialized.value) return

    const localState = readConversationState()
    conversations.value = localState?.conversations || []
    activeConversationId.value = localState?.activeConversationId || ''
    ensureActiveConversation(defaultModel)
    initialized.value = true
  }

  const createConversation = (input: CreateConversationInput = {}) => {
    const conversation = createEmptyConversationRecord(input)
    conversations.value.unshift(conversation)
    activeConversationId.value = conversation.id
    persistState()
    return conversation
  }

  const switchConversation = (conversationId: string) => {
    const targetConversation = conversations.value.find(item => item.id === conversationId)
    if (!targetConversation) return null

    activeConversationId.value = targetConversation.id
    persistState()
    return targetConversation
  }

  const renameConversation = (conversationId: string, title: string) => {
    const nextTitle = title.trim()
    if (!nextTitle) return

    conversations.value = conversations.value.map(item => {
      if (item.id !== conversationId) return item
      return {
        ...item,
        title: nextTitle,
        updatedAt: new Date().toISOString()
      }
    })
    persistState()
  }

  const removeConversation = (conversationId: string, defaultModel = '') => {
    conversations.value = conversations.value.filter(item => item.id !== conversationId)

    if (!conversations.value.length) {
      const nextConversation = createEmptyConversationRecord({
        model: defaultModel
      })
      conversations.value = [nextConversation]
      activeConversationId.value = nextConversation.id
      persistState()
      return nextConversation
    }

    if (activeConversationId.value === conversationId) {
      activeConversationId.value = sortedConversations.value[0]?.id || conversations.value[0]?.id || ''
    }

    persistState()
    return activeConversation.value
  }

  const updateConversationModel = (conversationId: string, model: string) => {
    conversations.value = conversations.value.map(item => {
      if (item.id !== conversationId) return item
      return {
        ...item,
        model,
        updatedAt: new Date().toISOString()
      }
    })
    persistState()
  }

  const appendMessage = (input: AppendConversationMessageInput) => {
    const now = new Date().toISOString()

    conversations.value = conversations.value.map(item => {
      if (item.id !== input.conversationId) return item

      const nextMessages = [...item.messages, {
        id: createId(),
        role: input.role,
        content: input.content,
        createdAt: now,
        layout: input.layout
      }]
      return {
        ...item,
        title: buildConversationTitle(nextMessages),
        summary: buildConversationSummary(nextMessages),
        updatedAt: now,
        lastMessageAt: now,
        messages: nextMessages
      }
    })
    persistState()
  }

  const getConversationMessagesForRequest = (conversationId: string): ChatMessage[] => {
    const targetConversation = conversations.value.find(item => item.id === conversationId)
    if (!targetConversation) return []

    return targetConversation.messages.map((message) => {
      return {
        role: message.role,
        content: message.content,
        tool_call_id: message.tool_call_id,
        name: message.name
      }
    })
  }

  return {
    activeConversation,
    activeConversationId,
    conversations: sortedConversations,
    hydrate,
    createConversation,
    switchConversation,
    renameConversation,
    removeConversation,
    updateConversationModel,
    appendMessage,
    getConversationMessagesForRequest,
    ensureActiveConversation
  }
})

export function useConversationStoreWithOut() {
  return useConversationStore(store)
}
