<script lang="tsx" setup>
import { renderMarkdownText, renderMermaidProcess } from '@/components/MarkdownPreview/plugins/markdown'
import { type ChatContentPart, type ChatMessage, defaultMockModelName, modelMappingList, triggerModelTermination } from '@/components/MarkdownPreview/models'
import { type InputInst } from 'naive-ui'
import type { SelectBaseOption } from 'naive-ui/es/select/src/interface'
import { isGithubDeployed } from '@/config'
import { imageFileToDataUrl } from '@/utils/files-tool'
import { layoutGenerateQuestionTemplate } from '@/questionTemplate/layoutGenerate'
import LayoutCard, { type LayoutResult } from '@/views/card/index.vue'


const route = useRoute()
const router = useRouter()
const businessStore = useBusinessStore()


const modelListSelections = computed(() => {
  return modelMappingList.map<SelectBaseOption>((modelItem) => {
    let disabled = false
    if (isGithubDeployed && modelItem.modelName !== defaultMockModelName) {
      disabled = true
    }

    return {
      label: modelItem.label,
      value: modelItem.modelName,
      // Github 演示环境禁用模型切换，拉取代码后可按自己需求修改
      disabled
    }
  })
})


const loading = ref(true)

setTimeout(() => {
  loading.value = false
}, 700)


const stylizingLoading = ref(false)


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
const conversationList = ref<ChatMessage[]>([])
const pendingLayout = ref<LayoutResult | null>(null)
const refConversationContent = ref<HTMLElement | null>()

/**
 * 输出字符串 Reader 流（风格化的）
 */
const outputTextReader = ref<ReadableStreamDefaultReader | null>()

const refReaderMarkdownPreview = ref<any>()

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

const onFailedReader = () => {
  outputTextReader.value = null
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
  if (answerText.trim() || pendingLayout.value) {
    conversationList.value.push({
      role: 'assistant',
      content: answerText,
      layout: pendingLayout.value
    })
  }
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

  conversationList.value.push({
    role: 'user',
    content
  })

  stylizingLoading.value = true
  await nextTick()
  refReaderMarkdownPreview.value?.resetStatus()
  refReaderMarkdownPreview.value?.initializeStart()
  scrollConversationToBottom()

  const { error, reader } = await businessStore.createAssistantWriterStylized({
    messages: conversationList.value.map(({ layout, ...message }) => ({
      ...message
    }))
  })

  if (error) {
    onFailedReader()
    return
  }

  if (reader) {
    outputTextReader.value = reader
  }
}

const placeholder = computed(() => {
  if (stylizingLoading.value) {
    return `输入任意问题...`
  }
  return '输入任意问题，按 Enter 发送，Shift/Ctrl + Enter 换行...'
})

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

const handleRemoveAttachment = (index: number) => {
  pendingAttachments.value.splice(index, 1)
}


const handleResetState = () => {
  inputTextString.value = ''
  conversationList.value = []
  pendingAttachments.value = []
  outputTextReader.value = null
  pendingLayout.value = null
  stylizingLoading.value = false
  nextTick(() => {
    refInputTextString.value?.focus()
  })
  refReaderMarkdownPreview.value?.abortReader()
  refReaderMarkdownPreview.value?.resetStatus()
}
handleResetState()


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
        b="~ solid transparent"
        hover="shadow-[--shadow] b-primary bg-#e8e8e8"
        class={[
          'px-10 py-2 rounded-7 text-12',
          'max-w-230 transition-all-300 select-none cursor-pointer',
          'c-#525252 bg-#ededed'
        ]}
        style={{
          '--shadow': '3px 3px 3px -1px rgba(0,0,0,0.1)'
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
  layoutGenerateQuestionTemplate
])


</script>

<template>
  <LayoutCenterPanel
    :loading="loading"
  >
    <input
      ref="refFileInput"
      type="file"
      accept="image/*"
      multiple
      hidden
      @change="handleUploadFile"
    >
    <!-- 内容区域 -->
    <div
      flex="~ col"
      h-full
    >
      <div
        flex="~ justify-between items-center"
      >
        <NavigationNavBar>
          <template #right>
            <div
              flex="~ justify-center items-center wrap"
              class="text-16 line-height-16"
            >
              <span class="lt-xs:hidden">当前模型：</span>
              <div
                flex="~ justify-center items-center"
              >
                <n-select
                  v-model:value="businessStore.systemModelName"
                  class="w-280 lt-xs:w-260 pr-10 font-italic font-bold"
                  placeholder="请选择模型"
                  :disabled="stylizingLoading"
                  :options="modelListSelections"
                />
                <CustomTooltip
                  :disabled="false"
                >
                  <div>注意：</div>
                  <div>
                    演示环境仅支持 “模拟数据模型”
                  </div>
                  <div>
                    如需测试其他模型请克隆<a
                      href="https://github.com/pdsuwwz/chatgpt-vue3-light-mvp"
                      target="_blank"
                      class="px-2 underline c-warning font-bold"
                    >本仓库</a>到本地运行
                  </div>
                  <template #trigger>
                    <span
                      class="cursor-help font-bold c-primary text-17 i-ic:sharp-help"
                      ml-10
                      mr-24
                    ></span>
                  </template>
                </CustomTooltip>
              </div>
            </div>
          </template>
        </NavigationNavBar>
      </div>

      <div
        flex="1 ~ col"
        min-h-0
        pb-20
      >
        <MarkdownPreview
          v-if="!conversationList.length && !stylizingLoading"
          ref="refReaderMarkdownPreview"
          v-model:reader="outputTextReader"
          :model="businessStore.currentModelItem?.modelName"
          :transform-stream-fn="businessStore.currentModelItem?.transformStreamValue"
          @failed="onFailedReader"
          @completed="onCompletedReader"
        />
        <div
          v-else
          ref="refConversationContent"
          flex="1 ~ col"
          min-h-0
          class="overflow-y-auto px-12"
        >
          <div
            flex="~ col"
            gap-16
            class="py-10"
          >
            <div
              v-for="(messageItem, idx) in conversationList"
              :key="`${ messageItem.role }-${ idx }`"
              class="w-full flex"
              :class="[
                messageItem.role === 'user' ? 'justify-end' : 'justify-start'
              ]"
            >
              <div
                v-if="messageItem.role === 'user'"
                class="max-w-[85%] rounded-16 bg-primary/8 px-16 py-12 text-15 line-height-24"
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
                class="w-full rounded-16 bg-#fff/75 px-16 py-12"
              >
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
              class="w-full rounded-16 bg-#fff/75 px-16 py-12"
            >
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

      <div
        flex="~ col items-center"
        flex-basis="10%"
        p="14px"
        py="0"
      >
        <div
          w-full
          flex="~ justify-start"
          class="px-1em pb-10"
        >
          <n-space>
            <PromptTag
              v-for="(textItem, idx) in promptTextList"
              :key="idx"
              :text="textItem"
            />
          </n-space>
        </div>
        <div
          v-if="pendingAttachments.length"
          w-full
          flex="~ wrap items-center"
          gap-8
          class="px-1em pb-8"
        >
          <div
            v-for="(attachment, attachmentIdx) in pendingAttachments"
            :key="attachmentIdx"
            relative
          >
            <n-image
              :src="attachment.dataUrl"
              width="48"
              height="48"
              object-fit="cover"
              class="rounded-8"
            />
            <span
              absolute
              right="-6"
              top="-6"
              class="flex h-16 w-16 items-center justify-center rounded-full bg-#00000080 c-#fff text-12 cursor-pointer select-none"
              @click="handleRemoveAttachment(attachmentIdx)"
            >×</span>
          </div>
        </div>
        <div
          relative
          flex="1"
          w-full
          px-1em
        >
          <n-input
            ref="refInputTextString"
            v-model:value="inputTextString"
            type="textarea"
            autofocus
            :autosize="{
              minRows: 6, // 默认初始高度（6行，你想要默认调大就加大这个值，比如4/5/6）
              maxRows: 12,
            }"
            class="textarea-resize-none text-15"
            :style="{
              '--n-border-radius': '20px',
              '--n-padding-left': '20px',
              '--n-padding-right': '20px',
              '--n-padding-vertical': '10px',
            }"
            :placeholder="placeholder"
            @keydown.enter="handleInputEnter"
          />
          <button
            v-if="false"
            type="button"
            class="absolute flex items-center justify-center rounded-full b-none cursor-pointer c-#303133/70 hover:bg-#0000000a disabled:cursor-not-allowed disabled:opacity-40"
            style="left: 40px; bottom: 50%; transform: translateY(50%); width: 120px; height: 40px;"
            :disabled="stylizingLoading"
            title="上传图片"
            @click="refFileInput?.click()"
          >
            上传图片
            <!-- <span class="text-20 i-ic:sharp-image"></span> -->
          </button>
          <n-float-button
            position="absolute"
            :right="35"
            :bottom="35"
            :type="stylizingLoading ? 'primary' : 'default'"
            color
            :class="[
              stylizingLoading && 'opacity-90',
              'translate-y-50%'
            ]"
            @click.stop="handleCreateStylized()"
          >
            <div
              v-if="stylizingLoading"
              class="i-svg-spinners:pulse-2 c-#fff"
            ></div>
            <div
              v-else
              class="transform-rotate-z--90 text-22 c-#303133/70 i-hugeicons:start-up-02"
            ></div>
          </n-float-button>
        </div>
      </div>
    </div>
  </LayoutCenterPanel>
</template>

<style lang="scss" scoped>

</style>
