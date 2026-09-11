<script lang="tsx" setup>
import { renderMarkdownText, renderMermaidProcess } from './plugins/markdown'

import type { CrossTransformFunction, TransformFunction } from './models'
import { defaultMockModelName } from './models'

interface Props {
  // 上层传入的流式 reader。
  // 该 reader 会持续吐出模型返回的分段文本，组件内部负责消费它并做渐进渲染。
  reader?: ReadableStreamDefaultReader<Uint8Array> | null | undefined
  // 当前选中的模型标识，只用于空状态文案判断等 UI 展示逻辑。
  model: string | null| undefined
  // 针对不同模型的流式片段转换函数。
  // 各模型返回格式不同，这里由上层传入统一的转换器做适配。
  transformStreamFn: TransformFunction | null | undefined
  // 在消息列表中作为“当前回答”渲染时，不再展示默认空状态占位。
  showEmptyPlaceholder?: boolean
}

const props = withDefaults(
  defineProps<Props>(),
  {
    reader: null,
    showEmptyPlaceholder: true
  }
)


// 定义响应式变量
// 已经显示到页面上的文本内容。
// 该值会被实时转成 Markdown HTML，用户当前看到的就是这一份文本。
const displayText = ref('')
// 从流里读取到、但还没真正渲染到页面上的缓冲区。
// 打字机效果的核心就是先写入这里，再按帧搬运到 displayText。
const textBuffer = ref('')
// 当前 reader 是否仍处于工作中。
// 它主要用于控制底部 loading 图标，以及生成完毕时机判断。
const readerLoading = ref(false)

// 是否已主动终止当前读取流程。
const isAbort = ref(false)

// 当前一次回答是否已经完整结束。
const isCompleted = ref(false)

const emit = defineEmits([
  'failed',
  'completed',
  'update:reader'
])


const refWrapperContent = ref<HTMLElement>()

// 记录 requestAnimationFrame 的句柄，避免重复开启多个打字动画循环。
let typingAnimationFrame: number | null = null

const renderedMarkdown = computed(() => {
  return renderMarkdownText(displayText.value)
})

// 接口响应是否正在排队等待
const waitingForQueue = ref(false)

const WaitTextRender = defineComponent({
  render() {
    return (
      <n-empty
        size="large"
        class="font-bold [&_.n-empty\_\_icon]:flex [&_.n-empty\_\_icon]:justify-center"
      >
        {{
          default: () => (
            <div
              whitespace-break-spaces
              text-center
            >请求排队处理中，请耐心等待...</div>
          ),
          icon: () => (
            <n-icon class="text-30">
              <div class="i-svg-spinners:clock"></div>
            </n-icon>
          )
        }}
      </n-empty>
    )
  }
})

const abortReader = () => {
  // 主动中断当前流式读取。
  // 这里除了 cancel reader，还要同步重置内部状态，避免旧的动画继续消费旧缓冲区。
  if (props.reader) {
    props.reader.cancel()
  }

  isAbort.value = true
  readIsOver.value = false
  emit('update:reader', null)
  initializeEnd()
  isCompleted.value = true
}

const resetStatus = () => {
  // 将组件恢复到“尚未开始生成”的初始状态。
  // 每次新提问前，都会先走这一轮清理，防止上一次输出残留。
  isAbort.value = false
  isCompleted.value = false
  readIsOver.value = false

  emit('update:reader', null)

  initializeEnd()
  displayText.value = ''
  textBuffer.value = ''
  readerLoading.value = false
  if (typingAnimationFrame) {
    cancelAnimationFrame(typingAnimationFrame)
    typingAnimationFrame = null
  }
}

/**
 * 检查是否有实际内容
 */
function hasActualContent(html) {
  const text = html.replace(/<[^>]*>/g, '')
  return /\S/.test(text)
}

const showCopy = computed(() => {
  if (!isCompleted.value) return false

  if (hasActualContent(displayText.value)) {
    return true
  }
  return false
})

const renderedContent = computed(() => {
  // 这里当前直接返回渲染结果。
  // 如果后续要做“闪烁光标”之类的扩展，可以在这里统一拼接额外标记。
  return `${ renderedMarkdown.value }`
})


const initialized = ref(false)

const initializeStart = () => {
  // 通知外层“请求已发出，但首段内容可能还没回来”。
  // 这个状态和 readerLoading 不完全相同，主要用于首屏 loading 过渡。
  initialized.value = true
}

const initializeEnd = () => {
  // 一旦真正拿到内容、失败或结束，都应当退出初始化态。
  initialized.value = false
}

/**
 * 标记 reader 是否已经读取结束。
 * 注意：reader 结束不代表页面已经渲染完，textBuffer 里可能还有待消费内容。
 */
const readIsOver = ref(false)
const readTextStream = async () => {
  // 持续从流式 reader 中读取服务端返回的数据。
  // 这里负责“读流并写入缓冲区”，不直接控制页面逐字展示节奏。
  if (!props.reader) return


  const textDecoder = new TextDecoder('utf-8')
  readerLoading.value = true

  while (true) {
    if (isAbort.value) {
      break
    }
    try {
      if (!props.reader) {
        readIsOver.value = true
        break
      }
      const { value, done } = await props.reader.read()
      if (!props.reader) {
        readIsOver.value = true
        break
      }
      if (done) {
        readIsOver.value = true
        break
      }

      const transformer = props.transformStreamFn as CrossTransformFunction
      if (!transformer) {
        break
      }

      // 不同模型的分段协议不一样，这里统一转换成 content / done / isWaitQueuing 三类结果。
      const stream = transformer(value, textDecoder)
      if (stream.done) {
        readIsOver.value = true
        break
      }

      if (stream.isWaitQueuing) {
        waitingForQueue.value = stream.isWaitQueuing
      }
      if (stream.content) {
        waitingForQueue.value = false
        // 接口一旦返回真实内容，先进入缓冲区，后续再由 showText 按帧吐到页面。
        textBuffer.value += stream.content
      }

      if (typingAnimationFrame === null) {
        // 只有当前没有动画循环时才启动，避免重复开启多个 requestAnimationFrame。
        showText()
      }
    } catch (error) {
      readIsOver.value = true
      emit('failed', error)
      resetStatus()
      break
    } finally {
      initializeEnd()
    }
  }
}

const scrollToBottom = async () => {
  // DOM 更新后再滚动，避免读取到旧的 scrollHeight。
  await nextTick()
  if (!refWrapperContent.value) return

  refWrapperContent.value.scrollTop = refWrapperContent.value.scrollHeight
}
const scrollToBottomByThreshold = async () => {
  if (!refWrapperContent.value) return

  // 仅当用户当前接近底部时，才自动跟随新内容滚动。
  // 这样可以减少强制回到底部带来的阅读打断。
  const threshold = 100
  const distanceToBottom = refWrapperContent.value.scrollHeight - refWrapperContent.value.scrollTop - refWrapperContent.value.clientHeight
  if (distanceToBottom <= threshold) {
    scrollToBottom()
  }
}

const scrollToBottomIfAtBottom = async () => {
  // TODO: 需要同时支持手动向上滚动
  scrollToBottomByThreshold()
}

/**
 * 从缓冲区读取内容，按固定步长逐步追加到 displayText。
 * 这里每帧最多追加 10 个字符，用来制造“打字机”渐进输出的视觉效果。
 */
const runReadBuffer = (readCallback = () => {}, endCallback = () => {}) => {
  if (textBuffer.value.length > 0) {
    // 这里取的是分块追加，而不是一次性全量追加。
    // 如果直接把整个 textBuffer 写入 displayText，页面就会瞬间整段出现。
    const nextChunk = textBuffer.value.substring(0, 10)
    displayText.value += nextChunk
    textBuffer.value = textBuffer.value.substring(10)
    readCallback()
  } else {
    endCallback()
  }
}

const showText = () => {
  // showText 由 requestAnimationFrame 驱动，是打字机效果的核心调度器。
  // 只要 reader 还没结束，或者缓冲区里还有剩余文本，它就会持续调度下一帧。
  if (isAbort.value && typingAnimationFrame) {
    cancelAnimationFrame(typingAnimationFrame)
    typingAnimationFrame = null
    readerLoading.value = false
    renderMermaidProcess(scrollToBottom)
    return
  }

  // 若 reader 还没结束，则保持打字行为
  if (!readIsOver.value) {
    runReadBuffer()
    // Mermaid 这类富文本可能会随着内容追加而生成新节点，因此每帧都补一次渲染。
    renderMermaidProcess(scrollToBottom)
    typingAnimationFrame = requestAnimationFrame(showText)
  } else {
    // 读取剩余的 buffer
    runReadBuffer(
      () => {
        renderMermaidProcess(scrollToBottom)
        typingAnimationFrame = requestAnimationFrame(showText)
      },
      () => {
        renderMermaidProcess(scrollToBottom)

        window.$ModalNotification.success({
          title: '生成完毕',
          duration: 1500
        })
        // 通知父组件本轮流式输出已结束，并清空对 reader 的引用。
        emit('update:reader', null)
        emit('completed', displayText.value)
        readerLoading.value = false
        isCompleted.value = true
        nextTick(() => {
          readIsOver.value = false
        })
        typingAnimationFrame = null
      }
    )
  }
  scrollToBottomIfAtBottom()
}

watch(
  () => props.reader,
  () => {
    if (props.reader) {
      // 一旦上层注入了新的 reader，就启动一轮新的流读取。
      readTextStream()
    }
  },
  {
    immediate: true,
    deep: true
  }
)


onUnmounted(() => {
  resetStatus()
})

defineExpose({
  // 暴露给父组件，用于发送前重置、中止当前生成、控制初始化态。
  abortReader,
  getDisplayText: () => displayText.value,
  resetStatus,
  initializeStart,
  initializeEnd
})

const showLoading = computed(() => {
  // 仅在“请求已发出，但正文还没开始显示”的阶段展示中间 loading。
  // 一旦 displayText 已有内容，就切换为正文 + 尾部小 loading 的形式。
  if (initialized.value) {
    return true
  }

  if (!props.reader) {
    return false
  }

  if (!readerLoading) {
    return false
  }
  if (displayText.value) {
    return false
  }

  return false
})

const refClipBoard = ref()
const handlePassClip = () => {
  // 复制的是当前已经展示完成的文本内容，而不是原始流片段。
  if (refClipBoard.value) {
    refClipBoard.value.copyText()
  }
}

const emptyPlaceholder = computed(() => {
  return defaultMockModelName === props.model
    ? '问一个问题，我才会消失 ~'
    : '问一个问题，我才会消失 ~'
})
</script>

<template>
  <n-spin
    relative
    flex="1 ~"
    min-h-0
    w-full
    h-full
    content-class="w-full h-full flex"
    :show="showLoading"
    :rotate="false"
    class="bg-#fff:30"
    :style="{
      '--n-opacity-spinning': '0.3'
    }"
  >
    <transition name="fade">
      <n-float-button
        v-if="showCopy"
        position="absolute"
        :top="30"
        :right="30"
        color
        class="c-warning bg-#fff/80 hover:bg-#fff/90 transition-all-200 z-2"
        @click="handlePassClip()"
      >
        <clip-board
          ref="refClipBoard"
          :auto-color="false"
          no-copy
          :text="displayText"
        />
      </n-float-button>
    </transition>
    <template #icon>
      <div class="i-svg-spinners:3-dots-rotate"></div>
    </template>
    <!-- b="~ solid #ddd" -->
    <div
      flex="1 ~"
      min-w-0
      min-h-0
      :class="[
        reader
          ? ''
          : 'justify-center items-center'
      ]"
    >
      <div
        text-16
        class="w-full h-full overflow-hidden"
        :class="[
          !displayText && 'flex items-center justify-center'
        ]"
      >
        <WaitTextRender
          v-if="waitingForQueue && !displayText"
        />
        <template v-else>
          <n-empty
            v-if="!displayText && showEmptyPlaceholder"
            size="large"
            class="font-bold"
          >
            <div
              whitespace-break-spaces
              text-center
              v-html="emptyPlaceholder"
            ></div>
            <template #icon>
              <n-icon>
                <div class="i-hugeicons:ai-chat-02"></div>
              </n-icon>
            </template>
          </n-empty>
          <div
            v-else
            ref="refWrapperContent"
            text-16
            class="w-full h-full overflow-y-auto"
            p-24px
          >
            <div
              class="markdown-wrapper"
              v-html="renderedContent"
            ></div>
            <WaitTextRender
              v-if="waitingForQueue"
            />
            <div
              v-if="readerLoading"
              size-24
              class="i-svg-spinners:pulse-3"
            ></div>
          </div>
        </template>
      </div>
    </div>
  </n-spin>
</template>

<style lang="scss">
.markdown-wrapper {

  h1 {
    font-size: 2em;
  }

  h2 {
    font-size: 1.5em;
  }

  h3 {
    font-size: 1.25em;
  }

  h4 {
    font-size: 1em;
  }

  h5 {
    font-size: 0.875em;
  }

  h6 {
    font-size: 0.85em;
  }

  h1,h2,h3,h4,h5,h6 {
    margin: 0 auto;
    line-height: 1.25;
  }

  & ul,ol {
    padding-left: 1.5em;
    line-height: 0.8;
  }

  & ul,li,ol {
    list-style-position: outside;
    white-space: normal;
  }

  li {
    line-height: 1.7;

    & > code {
      --at-apply: 'bg-#e5e5e5';
      --at-apply: whitespace-pre m-2px px-6px py-2px rounded-5px;
    }
  }

  ol ol {
    padding-left: 20px;
  }

  ul ul {
    padding-left: 20px;
  }

  hr {
    margin: 16px 0;
  }

  a {
    color: $color-default;
    font-weight: bolder;
    text-decoration: underline;
    padding: 0 3px;
  }

  p {
    line-height: 1.4;

    & > code {
      --at-apply: 'bg-#e5e5e5';
      --at-apply: whitespace-pre mx-4px px-6px py-3px rounded-5px;
    }


    img {
      display: inline-block;
    }
  }

  li > p {
    line-height: 2
  }

  blockquote {
    padding: 10px;
    margin: 20px 0;
    border-left: 5px solid #ccc;
    background-color: #f9f9f9;
    color: #555;

    & > p {
      margin: 0;
    }
  }

  .katex {
    --at-apply: c-primary;
  }

  kbd {
    --at-apply: inline-block align-middle p-0.1em p-0.3em;
    --at-apply: bg-#fcfcfc text-#555;
    --at-apply: border border-solid border-#ccc border-b-#bbb;
    --at-apply: rounded-0.2em shadow-[inset_0_-1px_0_#bbb] text-0.9em;
  }

  table {
    --at-apply: w-fit border-collapse my-16;
  }

  th, td {
    --at-apply: p-7 text-left border border-solid border-#ccc;
  }

  th {
    --at-apply: bg-#f2f2f2 font-bold;
  }

  tr:nth-child(even) {
    --at-apply: bg-#f9f9f9;
  }

  tr:hover {
    --at-apply: bg-#f1f1f1;
  }

  // Deepseek 深度思考 Wrapper

  .think-wrapper {
    --at-apply: pl-13 text-14 c-#8b8b8b;
    --at-apply: b-l-2 b-l-solid b-#e5e5e5;

    p {
      --at-apply: line-height-26;
    }
  }
}
</style>
