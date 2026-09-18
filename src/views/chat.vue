<script lang="tsx" setup>
import { renderMarkdownText, renderMermaidProcess } from '@/components/MarkdownPreview/plugins/markdown'
import { type ChatContentPart, type ChatMessage, triggerModelTermination } from '@/components/MarkdownPreview/models'
import { type OrderImportRow, downloadOrderImportTemplate, uploadOrderImportExcelPreview } from '@/api/order-import'
import { type InputInst } from 'naive-ui'
import { useConversationStore } from '@/store/hooks/useConversationStore'
import { fileToBase64, imageFileToDataUrl } from '@/utils/files-tool'
import InventoryDialog from '@/views/chat/components/InventoryDialog.vue'
import OrderImportDialog from '@/views/chat/components/OrderImportDialog.vue'
import {
  buildLayoutGenerateQuestionTemplate,
  inventoryQuestionTemplate,
  layoutGenerateQuestionTemplate,
  mapCloudOptimizationOrdersToLayoutPromptItems,
  remainderQuestionTemplate
} from '@/questionTemplate/layoutGenerate'
import LayoutCard, { type LayoutResult } from '@/views/card/index.vue'


const route = useRoute()
const router = useRouter()
const businessStore = useBusinessStore()
const conversationStore = useConversationStore()

const AUTO_PROMPT_QUERY_KEY = 'prompt'
const AUTO_PROMPT_BASE64_QUERY_KEY = 'promptBase64'
const AUTO_SEND_QUERY_KEY = 'autoSend'


const loading = ref(true)

setTimeout(() => {
  loading.value = false
}, 700)


const stylizingLoading = ref(false)
const excelQuickImportLoading = ref(false)
const message = useMessage()
const inventoryDialogVisible = ref(false)
const orderImportDialogVisible = ref(false)
const composerActionVisible = ref(false)
const renameDialogVisible = ref(false)
const renamingConversationId = ref('')
const renameConversationValue = ref('')


/**
 * 输入字符串
 */
const inputTextString = ref('')
const refInputTextString = ref<InputInst | null>()
type PendingAttachment = {
  dataUrl: string
  name: string
}

const pendingAttachments = ref<PendingAttachment[]>([])
const refFileInput = ref<HTMLInputElement | null>()
const refExcelImportInput = ref<HTMLInputElement | null>()
const pendingLayout = ref<LayoutResult | null>(null)
const refConversationContent = ref<HTMLElement | null>()
const respondingConversationId = ref('')

/**
 * 输出字符串 Reader 流（风格化的）
 */
const outputTextReader = ref<ReadableStreamDefaultReader | null>()

const refReaderMarkdownPreview = ref<any>()
const activeConversation = computed(() => conversationStore.activeConversation)
const conversationList = computed(() => activeConversation.value?.messages || [])
const conversationPreviewList = computed(() => conversationStore.conversations)
const activeConversationTitle = computed(() => activeConversation.value?.title || '新对话')
const isPristineConversation = computed(() => {
  return Boolean(
    activeConversation.value
    && activeConversation.value.title === '新对话'
    && !activeConversation.value.messages.length
  )
})

const scrollConversationToBottom = async () => {
  await nextTick()
  if (!refConversationContent.value) return

  refConversationContent.value.scrollTop = refConversationContent.value.scrollHeight
}

const renderConversationMermaid = async () => {
  await nextTick()
  renderMermaidProcess(scrollConversationToBottom)
}

const renderMessageContent = (content: string) => {
  return renderMarkdownText(content)
}

const stripThinkContent = (content: string) => {
  // 最终落库与展示时只保留正式回答，隐藏模型推理过程，减少页面噪声。
  return content
    .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
    .replace(/<think>[\s\S]*$/gi, ' ')
    .replace(/<\/?think>/gi, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const onFailedReader = () => {
  outputTextReader.value = null
  respondingConversationId.value = ''
  if (refReaderMarkdownPreview.value) {
    refReaderMarkdownPreview.value.initializeEnd()
  }
  stylizingLoading.value = false
  // window.$ModalMessage.error('转换失败，请重试')
  setTimeout(() => {
    if (refInputTextString.value) {
      refInputTextString.value.focus()
    }
  })
  triggerModelTermination()
}

const handleLayout = (layout: unknown) => {
  pendingLayout.value = layout as LayoutResult
}

const onCompletedReader = (answerText = '') => {
  outputTextReader.value = null
  const targetConversationId = respondingConversationId.value || activeConversation.value?.id || ''
  const finalAnswerText = stripThinkContent(answerText)
  if (finalAnswerText.trim() || pendingLayout.value) {
    conversationStore.appendMessage({
      conversationId: targetConversationId,
      role: 'assistant',
      content: finalAnswerText,
      layout: pendingLayout.value
    })
  }
  respondingConversationId.value = ''
  pendingLayout.value = null
  stylizingLoading.value = false
  nextTick(() => {
    scrollConversationToBottom()
    renderConversationMermaid()
  })
  setTimeout(() => {
    if (refInputTextString.value) {
      refInputTextString.value.focus()
    }
  })
  triggerModelTermination()
}

const handleCreateStylized = async () => {
  // 若正在加载，则点击后恢复初始状态
  if (stylizingLoading.value) {
    const partialAnswerText = refReaderMarkdownPreview.value?.getDisplayText?.() || ''
    refReaderMarkdownPreview.value.abortReader()
    onCompletedReader(partialAnswerText)
    message.info('已中断当前回答')
    return
  }


  if (refInputTextString.value && !inputTextString.value.trim()) {
    inputTextString.value = ''
    refInputTextString.value.focus()
    return
  }

  const textContent = inputTextString.value
  const textPart: ChatContentPart = {
    type: 'text',
    text: textContent
  }
  const imageParts: ChatContentPart[] = pendingAttachments.value.map(item => ({
    type: 'image_url',
    image_url: {
      url: item.dataUrl
    }
  }))
  pendingAttachments.value = []
  inputTextString.value = ''

  const content: ChatMessage['content'] = imageParts.length
    ? [textPart, ...imageParts]
    : textContent

  const currentConversation = conversationStore.ensureActiveConversation(businessStore.systemModelName)
  const currentConversationId = currentConversation.id

  conversationStore.updateConversationModel(currentConversationId, businessStore.systemModelName)
  conversationStore.appendMessage({
    conversationId: currentConversationId,
    role: 'user',
    content
  })
  respondingConversationId.value = currentConversationId

  stylizingLoading.value = true
  await nextTick()
  refReaderMarkdownPreview.value?.resetStatus()
  refReaderMarkdownPreview.value?.initializeStart()
  scrollConversationToBottom()

  const { error, reader } = await businessStore.createAssistantWriterStylized({
    messages: conversationStore.getConversationMessagesForRequest(currentConversationId)
  })

  if (error) {
    onFailedReader()
    return
  }

  if (reader) {
    outputTextReader.value = reader
  }
}

const openOrderImportDialog = () => {
  if (stylizingLoading.value) {
    message.warning('请等待当前对话完成后再导入订单')
    return
  }
  orderImportDialogVisible.value = true
}

const openInventoryDialog = () => {
  if (stylizingLoading.value) {
    message.warning('请等待当前对话完成后再查看库存')
    return
  }
  inventoryDialogVisible.value = true
}

const handleOpenImageUpload = () => {
  if (stylizingLoading.value) {
    message.warning('请等待当前对话完成后再上传文件')
    return
  }
  composerActionVisible.value = false
  refFileInput.value?.click()
}

const handleOpenExcelQuickImport = () => {
  if (stylizingLoading.value) {
    message.warning('请等待当前对话完成后再导入 Excel')
    return
  }
  composerActionVisible.value = false
  refExcelImportInput.value?.click()
}

const handleDownloadExcelTemplate = async () => {
  composerActionVisible.value = false
  try {
    await downloadOrderImportTemplate()
    message.success('Excel 模板已开始下载')
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Excel 模板下载失败'
    message.warning(errorMessage)
  }
}

const handleImportOrders = async (payload: {
  rows: OrderImportRow[]
  autoGenerate?: boolean
  source: 'local' | 'excel'
}) => {
  const orders = mapCloudOptimizationOrdersToLayoutPromptItems(payload?.rows || [])
    .filter(item => String(item.name || '').trim())
  if (!orders.length) {
    message.warning('未识别到可分析的订单数据')
    return
  }
  inputTextString.value = buildLayoutGenerateQuestionTemplate({
    orders
  })
  await nextTick()
  refInputTextString.value?.focus()
  if (payload?.autoGenerate) {
    await handleCreateStylized()
  }
}

const getQueryValue = (value: unknown) => {
  if (Array.isArray(value)) return String(value[0] || '')
  return typeof value === 'string' ? value : ''
}

const decodeBase64Utf8 = (value: string) => {
  try {
    const normalizedValue = value.replace(/-/g, '+').replace(/_/g, '/')
    const binary = window.atob(normalizedValue)
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return ''
  }
}

const isAutoSendEnabled = (value: string) => {
  const normalizedValue = value.trim().toLowerCase()
  return normalizedValue === '1' || normalizedValue === 'true' || normalizedValue === 'yes'
}

const consumeRoutePrompt = async () => {
  const promptText = getQueryValue(route.query[AUTO_PROMPT_QUERY_KEY])
  const promptBase64 = getQueryValue(route.query[AUTO_PROMPT_BASE64_QUERY_KEY])
  const nextPrompt = promptText || decodeBase64Utf8(promptBase64)
  if (!nextPrompt.trim()) return

  inputTextString.value = nextPrompt
  await nextTick()

  const nextQuery = {
    ...route.query
  }
  delete nextQuery[AUTO_PROMPT_QUERY_KEY]
  delete nextQuery[AUTO_PROMPT_BASE64_QUERY_KEY]
  delete nextQuery[AUTO_SEND_QUERY_KEY]
  void router.replace({
    query: nextQuery
  })

  if (!isAutoSendEnabled(getQueryValue(route.query[AUTO_SEND_QUERY_KEY]))) {
    refInputTextString.value?.focus()
    return
  }

  await handleCreateStylized()
}

const placeholder = computed(() => {
  if (stylizingLoading.value) {
    return '正在生成中，可点击右下角按钮中断当前回答...'
  }
  return '输入排版、库存或订单需求，Enter 发送，Shift + Enter 换行...'
})

// 对话区统一使用固定的助手身份文案，避免暴露底层模型细节，保持产品表达更高级克制。
const assistantIdentityLabel = '智能分析中枢'

const workspaceHighlightList = [
  '多轮追问',
  '业务问答',
  '排版分析',
  '结构化输出'
]

const handleInputEnter = (event: KeyboardEvent) => {
  if (event.shiftKey || event.ctrlKey) return

  event.preventDefault()
  handleCreateStylized()
}

const getUserMessageText = (content: ChatMessage['content']) => {
  if (typeof content === 'string') return content
  return content
    .filter((part): part is {
      type: 'text'
      text: string
    } => part.type === 'text')
    .map(part => part.text)
    .join('\n')
}

const getUserMessageImages = (content: ChatMessage['content']) => {
  if (typeof content === 'string') return []
  return content
    .filter((part): part is {
      type: 'image_url'
      image_url: {
        url: string
      }
    } => part.type === 'image_url')
    .map(part => part.image_url.url)
}

const handleUploadFile = (event: Event) => {
  const input = event.target as HTMLInputElement
  const files = input.files
  if (!files) return

  Array.from(files).forEach(async (file) => {
    if (!file.type.startsWith('image/')) return
    const dataUrl = await imageFileToDataUrl(file)
    pendingAttachments.value.push({
      dataUrl,
      name: file.name
    })
  })

  input.value = ''
}

const handleExcelQuickImport = async (event: Event) => {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return

  const isExcelFile = /\.xlsx?$/i.test(file.name)
  if (!isExcelFile) {
    message.warning('请上传 Excel 文件（.xlsx 或 .xls）')
    input.value = ''
    return
  }

  excelQuickImportLoading.value = true
  try {
    const fileContent = await fileToBase64(file)
    const response = await uploadOrderImportExcelPreview({
      fileName: file.name,
      fileContent,
      mergeDuplicates: true
    })
    if (response?.code !== 200) {
      message.warning(response?.message || 'Excel 解析失败')
      return
    }

    const rows = response?.data?.rows || []
    const orders = mapCloudOptimizationOrdersToLayoutPromptItems(rows)
      .filter(item => String(item.name || '').trim())
    if (!orders.length) {
      message.warning('未识别到可分析的有效订单')
      return
    }

    inputTextString.value = buildLayoutGenerateQuestionTemplate({
      orders
    })
    await nextTick()
    refInputTextString.value?.focus()
    message.success(response?.message || '已根据 Excel 生成排版模板文字')
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Excel 解析失败'
    message.warning(errorMessage)
  } finally {
    excelQuickImportLoading.value = false
    input.value = ''
  }
}

const handleRemoveAttachment = (index: number) => {
  pendingAttachments.value.splice(index, 1)
}

const formatConversationTime = (value: string) => {
  if (!value) return ''

  const date = new Date(value)
  const month = `${ date.getMonth() + 1 }`.padStart(2, '0')
  const day = `${ date.getDate() }`.padStart(2, '0')
  const hour = `${ date.getHours() }`.padStart(2, '0')
  const minute = `${ date.getMinutes() }`.padStart(2, '0')

  return `${ month }-${ day } ${ hour }:${ minute }`
}

const ensureConversationActionAllowed = () => {
  if (!stylizingLoading.value) return true

  message.warning('请等待当前对话完成后再操作会话')
  return false
}

const handleCreateConversation = () => {
  if (!ensureConversationActionAllowed()) return
  // 已处于空白新对话时不再重复创建，避免产生无意义的占位会话。
  if (isPristineConversation.value) {
    nextTick(() => {
      refInputTextString.value?.focus()
    })
    return
  }

  conversationStore.createConversation({
    model: businessStore.systemModelName
  })
  inputTextString.value = ''
  pendingAttachments.value = []
  nextTick(() => {
    refInputTextString.value?.focus()
  })
}

const handleSwitchConversation = (conversationId: string) => {
  if (!ensureConversationActionAllowed()) return

  conversationStore.switchConversation(conversationId)
  inputTextString.value = ''
  pendingAttachments.value = []
  nextTick(() => {
    refInputTextString.value?.focus()
    scrollConversationToBottom()
    renderConversationMermaid()
  })
}

const handleRenameConversation = (conversationId: string) => {
  if (!ensureConversationActionAllowed()) return

  const targetConversation = conversationPreviewList.value.find(item => item.id === conversationId)
  if (!targetConversation) return

  renamingConversationId.value = conversationId
  renameConversationValue.value = targetConversation.title || ''
  renameDialogVisible.value = true
}

const handleConfirmRenameConversation = () => {
  const nextTitle = renameConversationValue.value.trim()
  if (!nextTitle) {
    message.warning('请输入会话名称')
    return
  }

  conversationStore.renameConversation(renamingConversationId.value, nextTitle)
  renameDialogVisible.value = false
  renamingConversationId.value = ''
}

const handleCancelRenameConversation = () => {
  renameDialogVisible.value = false
  renamingConversationId.value = ''
  renameConversationValue.value = ''
}

const handleRemoveConversation = (conversationId: string) => {
  if (!ensureConversationActionAllowed()) return

  conversationStore.removeConversation(conversationId, businessStore.systemModelName)
  inputTextString.value = ''
  pendingAttachments.value = []
  nextTick(() => {
    refInputTextString.value?.focus()
    scrollConversationToBottom()
    renderConversationMermaid()
  })
}


const handleResetState = () => {
  conversationStore.ensureActiveConversation(businessStore.systemModelName)
  inputTextString.value = ''
  pendingAttachments.value = []
  outputTextReader.value = null
  pendingLayout.value = null
  stylizingLoading.value = false
  respondingConversationId.value = ''
  nextTick(() => {
    refInputTextString.value?.focus()
  })
  refReaderMarkdownPreview.value?.abortReader()
  refReaderMarkdownPreview.value?.resetStatus()
}

onMounted(() => {
  conversationStore.hydrate(businessStore.systemModelName)
  const currentConversation = conversationStore.ensureActiveConversation(businessStore.systemModelName)
  if (currentConversation.model) {
    businessStore.systemModelName = currentConversation.model
  }
  handleResetState()
  consumeRoutePrompt()
})

watch(
  () => route.query,
  () => {
    consumeRoutePrompt()
  }
)

watch(
  () => activeConversation.value?.id,
  () => {
    if (!activeConversation.value?.model) return
    businessStore.systemModelName = activeConversation.value.model
  }
)


const PromptTag = defineComponent({
  props: {
    text: {
      type: String,
      default: ''
    }
  },
  setup(props) {
    const handleClick = () => {
      inputTextString.value = props.text
      nextTick(() => {
        refInputTextString.value?.focus()
      })
    }
    return {
      handleClick
    }
  },
  render() {
    return (
      <div
        b="~ solid #d7def5"
        hover="shadow-[--shadow] b-#8aa4ff bg-#ffffff"
        class={[
          'px-12 py-7 rounded-999 text-12 shrink-0',
          'max-w-240 transition-all-300 select-none cursor-pointer',
          'c-#31456a bg-#f7f9ff backdrop-blur-sm'
        ]}
        style={{
          '--shadow': '0 10px 24px rgba(88, 114, 255, 0.14)'
        }}
        onClick={this.handleClick}
      >
        <n-ellipsis
          tooltip={{
            contentClass: 'wrapper-tooltip-scroller',
            keepAliveOnHover: true
          }}
        >
          {{
            tooltip: () => this.text,
            default: () => this.text
          }}
        </n-ellipsis>
      </div>
    )
  }
})

const promptTextList = ref([
  '打个招呼吧，并告诉我你的名字',
  layoutGenerateQuestionTemplate,
  // inventoryQuestionTemplate,
  // remainderQuestionTemplate
  // orderQuestionTemplate
])


</script>

<template>
  <LayoutCenterPanel
    :loading="loading"
  >
    <template #sidebar-header>
      <div class="chat-sidebar__header">
        <!-- <div class="chat-sidebar__eyebrow">会话管理</div> -->
        <div class="chat-sidebar__title">会话管理</div>
        <div class="chat-sidebar__actions">
          <n-button
            type="primary"
            class="chat-sidebar__create-button"
            @click="handleCreateConversation"
          >
            新对话
          </n-button>
          <n-button
            secondary
            type="primary"
            class="chat-sidebar__import-button"
            @click="openOrderImportDialog"
          >
            导入订单
          </n-button>
          <n-button
            secondary
            type="primary"
            class="chat-sidebar__inventory-button"
            @click="openInventoryDialog"
          >
            仓库库存
          </n-button>
        </div>
      </div>
    </template>
    <template #sidebar>
      <div class="chat-sidebar">
        <div class="chat-sidebar__list">
          <SideBarItem
            v-for="conversationItem in conversationPreviewList"
            :key="conversationItem.id"
            :active="conversationItem.id === activeConversation?.id"
            @click="handleSwitchConversation(conversationItem.id)"
            @edit="handleRenameConversation(conversationItem.id)"
            @remove="handleRemoveConversation(conversationItem.id)"
          >
            <div class="chat-sidebar__item">
              <div class="chat-sidebar__item-title">
                {{ conversationItem.title }}
              </div>
              <div class="chat-sidebar__item-meta">
                {{ formatConversationTime(conversationItem.updatedAt) }}
              </div>
            </div>
          </SideBarItem>
        </div>
      </div>
    </template>
    <input
      ref="refFileInput"
      type="file"
      accept="image/*"
      multiple
      hidden
      @change="handleUploadFile"
    >
    <input
      ref="refExcelImportInput"
      type="file"
      accept=".xlsx,.xls"
      hidden
      @change="handleExcelQuickImport"
    >
    <!-- 内容区域 -->
    <div
      flex="~ col"
      h-full
      class="chat-page"
    >
      <div class="chat-workspace">
        <div class="chat-workspace__header">
          <NavigationNavBar
            :transparent="false"
            :has-border="false"
          >
            <template #bottom>
              <div class="chat-page__header-status">
                <span class="chat-page__header-dot"></span>
                <span>{{ activeConversationTitle }}</span>
              </div>
            </template>
            <template #right>
              <div
                flex="~ justify-center items-center wrap"
                class="text-16 line-height-16"
              >
                <NavigationNavUser />
              </div>
            </template>
          </NavigationNavBar>
        </div>

        <div
          flex="1 ~ col"
          min-h-0
          class="chat-workspace__body"
        >
          <div
            v-if="!conversationList.length && !stylizingLoading"
            class="chat-empty-state"
          >
            <div class="chat-empty-state__title">
              面向玻璃行业的AI助手
            </div>
            <div class="chat-empty-state__description">
              支持快捷提问、多轮追问与结构化分析，让业务处理过程更聚焦、更专业。
            </div>
            <div class="chat-empty-state__highlights">
              <div
                v-for="item in workspaceHighlightList"
                :key="item"
                class="chat-empty-state__highlight"
              >
                {{ item }}
              </div>
            </div>
          </div>
          <div
            v-else
            ref="refConversationContent"
            flex="1 ~ col"
            min-h-0
            class="chat-conversation overflow-y-auto"
          >
            <div
              flex="~ col"
              gap-14
              class="chat-conversation__inner"
            >
              <div
                v-for="(messageItem, idx) in conversationList"
                :key="messageItem.id || `${ messageItem.role }-${ idx }`"
                class="chat-message-row w-full flex"
                :class="[
                  messageItem.role === 'user' ? 'justify-end' : 'justify-start'
                ]"
              >
                <div
                  v-if="messageItem.role === 'user'"
                  class="chat-message-card chat-message-card--user"
                >
                  <div
                    v-if="getUserMessageText(messageItem.content)"
                    class="whitespace-break-spaces"
                  >
                    {{ getUserMessageText(messageItem.content) }}
                  </div>
                  <div
                    v-if="getUserMessageImages(messageItem.content).length"
                    flex="~ wrap"
                    gap-8
                    class="mt-8"
                  >
                    <n-image
                      v-for="(img, imgIdx) in getUserMessageImages(messageItem.content)"
                      :key="imgIdx"
                      :src="img"
                      width="80"
                      height="80"
                      object-fit="cover"
                      class="rounded-8"
                    />
                  </div>
                </div>
                <div
                  v-else
                  class="chat-message-card chat-message-card--assistant"
                >
                  <div class="chat-message-card__label chat-message-card__label--assistant">
                    {{ assistantIdentityLabel }}
                  </div>
                  <div
                    v-if="typeof messageItem.content === 'string' && messageItem.content.trim()"
                    class="markdown-wrapper"
                    v-html="renderMessageContent(messageItem.content)"
                  ></div>
                  <LayoutCard
                    v-if="messageItem.layout"
                    :data="messageItem.layout as LayoutResult"
                    :use-mock="false"
                    class="mt-16"
                  />
                </div>
              </div>

              <div
                v-if="stylizingLoading"
                class="chat-message-card chat-message-card--assistant"
              >
                <div class="chat-message-card__label chat-message-card__label--assistant">
                  {{ assistantIdentityLabel }}
                </div>
                <MarkdownPreview
                  ref="refReaderMarkdownPreview"
                  v-model:reader="outputTextReader"
                  :model="businessStore.currentModelItem?.modelName"
                  :show-empty-placeholder="false"
                  :transform-stream-fn="businessStore.currentModelItem?.transformStreamValue"
                  @failed="onFailedReader"
                  @layout="handleLayout"
                  @completed="onCompletedReader"
                />
              </div>
            </div>
          </div>
        </div>

        <div class="chat-workspace__footer">
          <div class="chat-composer">
            <div class="chat-composer__prompt-list">
              <PromptTag
                v-for="(textItem, idx) in promptTextList"
                :key="idx"
                :text="textItem"
              />
            </div>

            <div
              v-if="pendingAttachments.length"
              class="chat-composer__attachments"
            >
              <div
                v-for="(attachment, attachmentIdx) in pendingAttachments"
                :key="attachmentIdx"
                class="chat-composer__attachment"
              >
                <n-image
                  :src="attachment.dataUrl"
                  width="48"
                  height="48"
                  object-fit="cover"
                  class="rounded-10"
                />
                <span
                  class="chat-composer__attachment-remove"
                  @click="handleRemoveAttachment(attachmentIdx)"
                >×</span>
              </div>
            </div>

            <div class="chat-composer__input-wrapper">
              <n-popover
                v-model:show="composerActionVisible"
                trigger="click"
                placement="top-start"
                :show-arrow="false"
                :theme-overrides="{
                  boxShadow: 'none'
                }"
                content-class="chat-composer-action-popover"
                raw
              >
                <template #trigger>
                  <button
                    type="button"
                    class="chat-plus-button"
                    :title="excelQuickImportLoading ? '正在解析 Excel...' : '添加内容'"
                    :aria-label="excelQuickImportLoading ? '正在解析 Excel...' : '添加内容'"
                    :disabled="excelQuickImportLoading"
                  >
                    <div
                      v-if="excelQuickImportLoading"
                      class="chat-plus-button__loading"
                    ></div>
                    <div v-else>+</div>
                  </button>
                </template>
                <div class="chat-composer-action-panel">
                  <button
                    type="button"
                    class="chat-composer-action-panel__item"
                    :disabled="excelQuickImportLoading"
                    @click="handleOpenExcelQuickImport"
                  >
                    <span class="chat-composer-action-panel__icon chat-composer-action-panel__icon--import">
                      <svg
                        viewBox="0 0 1024 1024"
                        aria-hidden="true"
                        class="chat-composer-action-panel__icon-svg"
                      >
                        <use xlink:href="#iconImport" />
                      </svg>
                    </span>
                    <span>导入订单 Excel</span>
                  </button>
                  <button
                    type="button"
                    class="chat-composer-action-panel__item"
                    :disabled="excelQuickImportLoading"
                    @click="handleDownloadExcelTemplate"
                  >
                    <span class="chat-composer-action-panel__icon chat-composer-action-panel__icon--template">
                      <svg
                        viewBox="0 0 1024 1024"
                        aria-hidden="true"
                        class="chat-composer-action-panel__icon-svg"
                      >
                        <use xlink:href="#iconexcel" />
                      </svg>
                    </span>
                    <span>下载 Excel 模板</span>
                  </button>
                  <!-- <button
                    type="button"
                    class="chat-composer-action-panel__item"
                    :disabled="excelQuickImportLoading"
                    @click="handleOpenImageUpload"
                  >
                    <span class="chat-composer-action-panel__icon chat-composer-action-panel__icon--image">
                      <svg
                        viewBox="0 0 1024 1024"
                        aria-hidden="true"
                        class="chat-composer-action-panel__icon-svg"
                      >
                        <use xlink:href="#iconupload" />
                      </svg>
                    </span>
                    <span>上传订单图片</span>
                  </button> -->
                </div>
              </n-popover>
              <n-input
                ref="refInputTextString"
                v-model:value="inputTextString"
                type="textarea"
                autofocus
                :autosize="{
                  minRows: 3,
                  maxRows: 10
                }"
                class="chat-textarea textarea-resize-none text-15"
                :style="{
                  '--n-border-radius': '24px',
                  '--n-padding-left': '76px',
                  '--n-padding-right': '84px',
                  '--n-padding-vertical': '14px',
                }"
                :placeholder="placeholder"
                @keydown.enter="handleInputEnter"
              />
              <button
                type="button"
                :class="[
                  'chat-send-button',
                  {
                    'chat-send-button--stop': stylizingLoading
                  }
                ]"
                :title="stylizingLoading ? '中断当前回答' : '发送问题'"
                :aria-label="stylizingLoading ? '中断当前回答' : '发送问题'"
                @click.stop="handleCreateStylized()"
              >
                <div
                  v-if="stylizingLoading"
                  class="chat-send-button__stop-icon"
                ></div>
                <div
                  v-else
                  class="transform-rotate-z--90 text-20 i-hugeicons:start-up-02"
                ></div>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
    <n-modal
      v-model:show="renameDialogVisible"
      preset="card"
      title="重命名会话"
      class="w-420"
      :bordered="false"
      size="small"
      :segmented="{
        content: true,
        footer: 'soft'
      }"
      @after-leave="handleCancelRenameConversation"
    >
      <n-input
        v-model:value="renameConversationValue"
        placeholder="请输入会话名称"
        maxlength="30"
        show-count
      />
      <template #footer>
        <div class="chat-rename-dialog__footer">
          <n-space justify="end">
            <n-button @click="handleCancelRenameConversation">
              取消
            </n-button>
            <n-button
              type="primary"
              @click="handleConfirmRenameConversation"
            >
              保存
            </n-button>
          </n-space>
        </div>
      </template>
    </n-modal>
    <OrderImportDialog
      v-model:show="orderImportDialogVisible"
      @import="handleImportOrders"
    />
    <InventoryDialog v-model:show="inventoryDialogVisible" />
  </LayoutCenterPanel>
</template>

<style lang="scss" scoped>
.chat-sidebar {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  padding: 4px 4px 0;
  border-radius: 24px;
  border: 1px solid rgb(157 176 225 / 12%);
  background:
    linear-gradient(180deg, rgb(255 255 255 / 62%), rgb(248 250 255 / 42%)),
    radial-gradient(circle at top left, rgb(255 255 255 / 56%), transparent 38%);
  box-shadow:
    0 16px 34px rgb(44 64 116 / 5%),
    inset 0 1px 0 rgb(255 255 255 / 68%);
  backdrop-filter: blur(18px);
}

.chat-sidebar__header {
  padding: 14px 14px 8px;
  margin-bottom: 6px;
  border-bottom: 1px solid rgb(157 176 225 / 10%);
}

.chat-sidebar__actions {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
  margin-top: 12px;
}

.chat-sidebar__eyebrow {
  color: #7c8aa6;
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.chat-sidebar__title {
  margin-top: 4px;
  color: #18253d;
  font-size: 18px;
  font-weight: 700;
}

.chat-sidebar__list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-right: 4px;
}

.chat-sidebar__item {
  min-width: 0;
}

.chat-sidebar__item-title {
  display: -webkit-box;
  overflow: hidden;
  color: #223550;
  font-size: 14px;
  font-weight: 700;
  line-height: 1.45;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.chat-sidebar__item-meta {
  margin-top: 8px;
  color: #94a2b8;
  font-size: 11px;
}

.chat-sidebar__create-button {
  --n-border-radius: 16px;
  --n-height: 44px;

  box-shadow: 0 10px 22px rgb(67 88 143 / 10%);
}

.chat-sidebar__import-button {
  --n-border-radius: 16px;
  --n-height: 42px;

  border-color: rgb(154 174 232 / 20%);
  background: rgb(255 255 255 / 80%);
  box-shadow: 0 8px 18px rgb(67 88 143 / 6%);
}

.chat-sidebar__inventory-button {
  --n-border-radius: 16px;
  --n-height: 42px;

  border-color: rgb(154 174 232 / 20%);
  background: linear-gradient(180deg, rgb(246 250 255 / 88%), rgb(255 255 255 / 78%));
  box-shadow:
    0 8px 18px rgb(67 88 143 / 6%),
    inset 0 1px 0 rgb(255 255 255 / 66%);
}

.chat-rename-dialog__footer {
  width: 100%;
}

.chat-page {
  position: relative;
  padding: 8px 14px 12px;
  background:
    radial-gradient(circle at top left, rgb(117 149 255 / 12%), transparent 24%),
    radial-gradient(circle at top right, rgb(67 211 255 / 10%), transparent 20%),
    linear-gradient(180deg, #f7f9ff 0%, #f3f6fc 54%, #eef3f9 100%);
}

/* 右侧工作区收拢为单一容器，顶部、内容和输入区仅通过内部分隔保持层次。 */
.chat-workspace {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  margin: 0;
  overflow: hidden;
  border: 1px solid rgb(157 176 225 / 18%);
  border-radius: 30px;
  background:
    radial-gradient(circle at top, rgb(115 146 255 / 10%), transparent 34%),
    linear-gradient(180deg, rgb(255 255 255 / 88%), rgb(245 249 255 / 84%));
  box-shadow:
    0 24px 58px rgb(44 64 116 / 8%),
    inset 0 1px 0 rgb(255 255 255 / 78%);
  backdrop-filter: blur(20px);
}

.chat-workspace::before {
  position: absolute;
  inset: 0;
  background:
    linear-gradient(90deg, rgb(118 144 255 / 0%), rgb(118 144 255 / 8%) 52%, rgb(72 205 255 / 0%) 100%);
  opacity: 0.8;
  pointer-events: none;
  content: '';
}

.chat-workspace__header {
  position: relative;
  z-index: 1;
  padding: 5px 14px 0;
  border-bottom: 1px solid rgb(157 176 225 / 14%);
  background: linear-gradient(180deg, rgb(255 255 255 / 52%), rgb(255 255 255 / 18%));
}

.chat-workspace__body {
  position: relative;
  z-index: 1;
  // padding: 12px 18px 10px;
  padding: 0;
}

.chat-workspace__footer {
  position: relative;
  z-index: 1;
  padding: 10px 18px 16px;
  border-top: 1px solid rgb(157 176 225 / 14%);
  background: linear-gradient(180deg, rgb(255 255 255 / 14%), rgb(252 253 255 / 54%));
}

.chat-page__header-status {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  border: 1px solid rgb(154 174 232 / 16%);
  border-radius: 999px;
  background: rgb(255 255 255 / 68%);
  box-shadow: 0 10px 24px rgb(55 73 124 / 4%);
  color: #5a6d8c;
  font-size: 12px;
  backdrop-filter: blur(12px);
}

.chat-page__header-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: linear-gradient(135deg, #60a5fa 0%, #7c3aed 100%);
  box-shadow: 0 0 0 5px rgb(123 92 255 / 10%);
}

.chat-empty-state {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 14px;
  min-height: 100%;
  padding: 20px 12px 10px;
}

.chat-empty-state__title {
  max-width: 680px;
  color: #18253d;
  font-size: 36px;
  font-weight: 700;
  line-height: 1.24;
  letter-spacing: 0.01em;
}

.chat-empty-state__description {
  max-width: 700px;
  color: #667791;
  font-size: 15px;
  line-height: 1.75;
}

.chat-empty-state__highlights {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.chat-empty-state__highlight {
  padding: 8px 12px;
  border: 1px solid rgb(154 174 232 / 20%);
  border-radius: 14px;
  background: rgb(255 255 255 / 76%);
  color: #455774;
  font-size: 12px;
}

.chat-conversation {
  min-height: 100%;
  padding: 4px 6px 0;
  scrollbar-width: thin;
  scrollbar-color: rgb(153 170 209 / 55%) transparent;
}

.chat-conversation__inner {
  padding: 2px 2px 10px;
}

.chat-conversation::-webkit-scrollbar,
.chat-sidebar__list::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

.chat-conversation::-webkit-scrollbar-thumb,
.chat-sidebar__list::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: linear-gradient(180deg, rgb(171 186 223 / 70%), rgb(140 158 202 / 78%));
}

.chat-conversation::-webkit-scrollbar-track,
.chat-sidebar__list::-webkit-scrollbar-track {
  border-radius: 999px;
  background: rgb(255 255 255 / 18%);
}

.chat-message-row {
  padding: 0 2px;
}

.chat-message-card {
  border: 1px solid rgb(154 174 232 / 20%);
  border-radius: 20px;
  box-shadow: 0 12px 30px rgb(38 57 102 / 6%);
  backdrop-filter: blur(12px);
}

.chat-message-card--user {
  max-width: 76%;
  padding: 12px 16px;
  background: linear-gradient(180deg, rgb(241 246 255 / 94%), rgb(235 242 255 / 90%));
  color: #24344f;
}

.chat-message-card--assistant {
  width: 100%;
  padding: 16px 18px;
  background:
    linear-gradient(180deg, rgb(255 255 255 / 92%), rgb(248 251 255 / 90%));
  box-shadow:
    0 14px 32px rgb(38 57 102 / 5%),
    inset 0 1px 0 rgb(255 255 255 / 82%);
}

.chat-message-card__label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
  padding: 4px 10px;
  border: 1px solid rgb(157 176 225 / 18%);
  border-radius: 999px;
  background: rgb(255 255 255 / 68%);
  color: #6f819f;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.chat-message-card__label::before {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: currentcolor;
  opacity: 0.75;
  content: '';
}

.chat-message-card__label--user {
  border-color: rgb(120 149 219 / 22%);
  background: rgb(244 248 255 / 76%);
  color: #5572b6;
}

.chat-message-card__label--assistant {
  color: #5f7291;
}

.chat-message-card__label--assistant::before {
  /* 助手标签使用冷蓝发光点，和当前产品的轻科技玻璃风更一致。 */
  background: radial-gradient(circle at 35% 35%, #dff2ff 0%, #7fb4ff 38%, #4e7ff2 100%);
  box-shadow:
    0 0 0 3px rgb(123 173 255 / 14%),
    0 0 12px rgb(92 136 245 / 28%);
  opacity: 1;
}

.chat-composer {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.chat-composer__prompt-list {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 2px 6px;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: thin;
  scrollbar-color: rgb(153 170 209 / 55%) transparent;
}

.chat-composer__prompt-list::-webkit-scrollbar {
  width: 5px;
  height: 5px;
}

.chat-composer__prompt-list::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: linear-gradient(180deg, rgb(171 186 223 / 70%), rgb(140 158 202 / 78%));
}

.chat-composer__prompt-list::-webkit-scrollbar-track {
  border-radius: 999px;
  background: rgb(255 255 255 / 18%);
}

.chat-composer__attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.chat-composer__attachment {
  position: relative;
}

.chat-composer__attachment-remove {
  position: absolute;
  top: -6px;
  right: -6px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: rgb(16 24 40 / 72%);
  color: #fff;
  font-size: 12px;
  cursor: pointer;
  user-select: none;
}

.chat-composer__input-wrapper {
  position: relative;
}

:deep(.chat-composer-action-popover) {
  padding: 0 !important;
  border: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
  backdrop-filter: none !important;
}

:deep(.n-popover:has(.chat-composer-action-panel)) {
  background: transparent !important;
  box-shadow: none !important;
  border-radius: 18px !important;
}

:deep(.n-popover-shared:has(.chat-composer-action-panel)) {
  box-shadow: none !important;
  border-radius: 18px !important;
}

.chat-composer-action-panel {
  display: flex;
  min-width: 168px;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  border: 1px solid rgb(157 176 225 / 16%);
  border-radius: 18px;
  background:
    linear-gradient(180deg, rgb(255 255 255 / 94%), rgb(247 250 255 / 92%)),
    radial-gradient(circle at top left, rgb(255 255 255 / 82%), transparent 42%);
  box-shadow:
    0 18px 38px rgb(44 64 116 / 10%),
    inset 0 1px 0 rgb(255 255 255 / 84%);
  backdrop-filter: blur(18px);
}

.chat-composer-action-panel__item {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 40px;
  padding: 0 12px;
  border: 0;
  border-radius: 12px;
  background: transparent;
  color: #29405f;
  font-size: 13px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
  transition: background 0.2s ease, color 0.2s ease;

  &:hover:not(:disabled) {
    background: rgb(94 123 221 / 8%);
    color: #243756;
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.58;
  }
}

.chat-composer-action-panel__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 12px;
  background:
    linear-gradient(180deg, rgb(255 255 255 / 80%), rgb(242 246 255 / 88%)),
    radial-gradient(circle at top left, rgb(255 255 255 / 82%), transparent 46%);
  box-shadow:
    inset 0 1px 0 rgb(255 255 255 / 88%),
    0 6px 14px rgb(86 108 168 / 8%);
  color: #5470ba;
}

.chat-composer-action-panel__icon-svg {
  width: 16px;
  height: 16px;
  fill: currentcolor;
}

.chat-composer-action-panel__icon--import {
  color: #5d74c8;
}

.chat-composer-action-panel__icon--template {
  color: #3f9d7a;
}

.chat-composer-action-panel__icon--image {
  color: #6682c7;
}

.chat-textarea {

  :deep(.n-input-wrapper) {
    border: 0;
    background: linear-gradient(180deg, rgb(252 253 255 / 96%), rgb(247 249 253 / 94%));
    box-shadow:
      inset 0 1px 0 rgb(255 255 255 / 95%),
      0 10px 24px rgb(94 109 160 / 5%);
    transition: box-shadow 0.25s ease, background 0.25s ease;
  }

  :deep(.n-input-wrapper:hover),
  :deep(.n-input-wrapper.n-input-wrapper--focus) {
    box-shadow:
      inset 0 1px 0 rgb(255 255 255 / 95%),
      0 14px 28px rgb(88 108 178 / 8%);
  }

  :deep(.n-input__textarea-el) {
    color: #24334d;
    line-height: 1.9;
  }
}

.chat-plus-button {
  position: absolute;
  left: 18px;
  bottom: 18px;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  border: 1px solid rgb(154 174 232 / 18%);
  border-radius: 14px;
  background:
    linear-gradient(180deg, rgb(255 255 255 / 88%), rgb(245 248 255 / 84%)),
    radial-gradient(circle at top left, rgb(255 255 255 / 76%), transparent 42%);
  box-shadow:
    0 12px 24px rgb(67 88 143 / 9%),
    inset 0 1px 0 rgb(255 255 255 / 82%);
  color: #5c73b8;
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
  transition: transform 0.2s ease, box-shadow 0.2s ease, opacity 0.2s ease;

  &:hover:not(:disabled) {
    transform: translateY(-1px);
    box-shadow:
      0 14px 26px rgb(67 88 143 / 12%),
      inset 0 1px 0 rgb(255 255 255 / 86%);
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.72;
  }
}

.chat-plus-button__loading {
  width: 16px;
  height: 16px;
  border: 2px solid rgb(92 115 184 / 16%);
  border-top-color: currentcolor;
  border-radius: 999px;
  animation: chat-plus-button-spin 0.8s linear infinite;
}

.chat-send-button {
  position: absolute;
  right: 18px;
  bottom: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  border: 0;
  border-radius: 14px;
  background: linear-gradient(135deg, #5d79f6 0%, #4caff0 100%);
  box-shadow: 0 10px 20px rgb(88 114 255 / 22%);
  color: #fff;
  cursor: pointer;
  transition: transform 0.2s ease, box-shadow 0.2s ease, opacity 0.2s ease;

  &:hover {
    transform: translateY(-1px);
    box-shadow: 0 14px 24px rgb(88 114 255 / 26%);
  }

  &:active {
    transform: translateY(0);
  }
}

.chat-send-button--stop {
  background: linear-gradient(135deg, #4f607f 0%, #7486a8 100%);
  box-shadow: 0 10px 20px rgb(79 96 127 / 22%);

  &:hover {
    box-shadow: 0 14px 24px rgb(79 96 127 / 28%);
  }
}

.chat-send-button__stop-icon {
  width: 14px;
  height: 14px;
  border-radius: 4px;
  background: currentcolor;
  box-shadow: 0 0 0 4px rgb(255 255 255 / 10%);
}

@keyframes chat-plus-button-spin {
  from {
    transform: rotate(0deg);
  }

  to {
    transform: rotate(360deg);
  }
}

@media (width <= 960px) {

  .chat-empty-state__title {
    font-size: 30px;
  }

  .chat-message-card--user {
    max-width: 88%;
  }

  .chat-workspace__body {
    padding-inline: 14px;
  }

  .chat-workspace__footer {
    padding-inline: 14px;
  }
}
</style>
