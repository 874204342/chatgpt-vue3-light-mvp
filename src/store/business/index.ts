import { defineStore } from 'pinia'

import { sleep } from '@/utils/request'
import * as GlobalAPI from '@/api'


import * as TransformUtils from '@/components/MarkdownPreview/transform'

import { defaultModelName, modelMappingList } from '@/components/MarkdownPreview/models'

export interface BusinessState {
  systemModelName: string
}

export const useBusinessStore = defineStore('business-store', {
  state: (): BusinessState => {
    return {
      systemModelName: defaultModelName
    }
  },
  getters: {
    currentModelItem (state) {
      return modelMappingList.find(v => v.modelName === state.systemModelName)
    }
  },
  actions: {
    /**
     * Event Stream 调用大模型接口
     */
    async createAssistantWriterStylized(data): Promise<{error: number
      reader: ReadableStreamDefaultReader<string> | null}> {

      // 调用当前模型的接口
      return new Promise((resolve) => {
        if (!this.currentModelItem?.chatFetch) {
          return {
            error: 1,
            reader: null
          }
        }
        this.currentModelItem.chatFetch(data.text)
          .then((res) => {
            if (res.body) {
              const reader = res.body
                // 第 1 步：把接口返回的二进制流解码成 UTF-8 文本流。
                .pipeThrough(new TextDecoderStream())
                // 第 2 步：按换行符拆分流式片段，适配 SSE / JSON 分段返回的数据格式。
                .pipeThrough(TransformUtils.splitStream('\n'))
                // 第 3 步：拿到可手动 read() 的 reader，交给 MarkdownPreview 组件继续消费。
                // 后续组件会先把内容写入缓冲区，再按帧逐步渲染，形成打字机效果。
                .getReader()

              resolve({
                error: 0,
                reader
              })
            } else {
              resolve({
                error: 1,
                reader: null
              })
            }
          })
          .catch((err) => {
            resolve({
              error: 1,
              reader: null
            })
          })
      })
    }
  }
})
