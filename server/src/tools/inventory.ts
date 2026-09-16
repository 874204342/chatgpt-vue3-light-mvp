import type { FastifyRequest } from 'fastify'
import { serverConfig } from '../config.js'
import { getSaasToken } from '../routes/saas.js'
import { type ChatMessage, extractTextContent } from '../types/chat.js'

type InventoryResolutionResult = {
  messages: ChatMessage[]
  toolCalls: string[]
}

type SaasResult = {
  code?: number
  message?: string
  data?: {
    records?: unknown[]
    list?: unknown[]
  }
}

const getLastUserText = (messages: ChatMessage[]) => {
  const lastUserMessage = [...messages].reverse().find(message => message.role === 'user')
  return extractTextContent(lastUserMessage?.content ?? '')
}

const isInventoryQuery = (text: string) => /原片库存|余料库存|仓库库存|查询库存|查库存|库存多少|库存量|可用库存|原片仓|余料|边角料|库位/.test(text)

const isOddmentsQuery = (text: string) => /余料|边角料/.test(text)

const getPageSize = (text: string) => {
  if (/全部|所有/.test(text)) return 200

  const match = text.match(/(?:前|查|查询|显示|返回)?\s*(\d{1,3})\s*条/)
  if (!match) return 20

  return Math.min(Math.max(Number(match[1]), 1), 200)
}

const getRecords = (result: SaasResult) => result.data?.records || result.data?.list || []

const toText = (value: unknown) => value === null || value === undefined || value === '' ? '-' : String(value)

// 防止接口文本破坏 Markdown 表格结构。
const toTableCell = (value: unknown) => toText(value).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ')

const formatGlassInventory = (records: unknown[]) => {
  const header = '| 序号 | 原片名称 | 编号 | 厚度(mm) | 宽度 | 高度 | 可用库存(张) | 总库存(张) | 库位 |'
  const separator = '| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |'
  const rows = records.map((item, index) => {
    const value = item as Record<string, unknown>
    return `| ${ index + 1 } | ${ toTableCell(value.glassName) } | ${ toTableCell(value.glassNo) } | ${ toTableCell(value.thickness) } | ${ toTableCell(value.width) } | ${ toTableCell(value.height) } | ${ toTableCell(value.num) } | ${ toTableCell(value.totalNum) } | ${ toTableCell(value.stockLocationNames) } |`
  })
  const emptyRow = '| - | 暂无数据 | - | - | - | - | - | - | - |'
  return ['原片库存明细', '', header, separator, ...(rows.length ? rows : [emptyRow])].join('\n')
}

const formatOddmentsInventory = (records: unknown[]) => {
  const header = '| 序号 | 标签号 | 厚度(mm) | 宽度 | 高度 | 库存(张) | 库位 |'
  const separator = '| ---: | --- | ---: | ---: | ---: | ---: | --- |'
  const rows = records.map((item, index) => {
    const value = item as Record<string, unknown>
    return `| ${ index + 1 } | ${ toTableCell(value.codeNo) } | ${ toTableCell(value.thickness) } | ${ toTableCell(value.width) } | ${ toTableCell(value.height) } | ${ toTableCell(value.quantity) } | ${ toTableCell(value.wareHouseLocation) } |`
  })
  const emptyRow = '| - | 暂无数据 | - | - | - | - | - |'
  return ['余料库存明细', '', header, separator, ...(rows.length ? rows : [emptyRow])].join('\n')
}

const insertBeforeLastUserMessage = (messages: ChatMessage[], message: ChatMessage) => {
  let lastUserIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role !== 'user') continue
    lastUserIndex = index
    break
  }
  if (lastUserIndex < 0) return [...messages, message]
  return [
    ...messages.slice(0, lastUserIndex),
    message,
    ...messages.slice(lastUserIndex)
  ]
}

const queryInventory = async (request: FastifyRequest, text: string) => {
  const token = getSaasToken(request)
  if (!token) {
    return {
      content: '用户正在查询库存，但当前未登录 SaaS。不要调用或猜测库存数据；请提示用户先在页面右上角登录 SaaS 后再查询。',
      toolCall: 'inventory-auth-required'
    }
  }

  const oddments = isOddmentsQuery(text)
  const pageSize = getPageSize(text)
  const path = oddments
    ? `/warehouse/oddmentsWareHouse/pageList?pageNum=1&pageSize=${ pageSize }`
    : `/optimGlassInfo/otherList?pageNum=1&pageSize=${ pageSize }`
  const body = oddments
    ? {}
    : {
      excludeZeroStock: 1
    }

  const response = await fetch(`${ serverConfig.saasBaseUrl }${ path }`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': token
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  })
  const result = await response.json().catch(() => ({})) as SaasResult
  if (!response.ok || result.code !== 200) {
    throw new Error(result.message || '库存服务请求失败')
  }

  const records = getRecords(result)
  return {
    content: [
      '当前用户已登录 SaaS，本轮库存查询已成功完成。',
      '请直接基于下面的实时库存数据回答用户，不要再说未登录、无法查询或请先登录。',
      `本轮已调用 SaaS 库存查询工具（第 1 页，最多 ${ pageSize } 条）。请严格基于以下实时数据回答，不要编造未返回的库存数据。`,
      `输出要求：先给出不超过 5 条的简短摘要，再输出“${ oddments ? '余料库存明细' : '原片库存明细' }”Markdown 表格。表格必须逐行保留下面提供的当前页全部记录和字段，不得改成列表，不得聚合、合并或省略。`,
      '',
      oddments ? formatOddmentsInventory(records) : formatGlassInventory(records)
    ].join('\n'),
    toolCall: oddments ? 'saas-oddments-inventory' : 'saas-glass-inventory'
  }
}

export const resolveInventoryMessages = async (request: FastifyRequest, messages: ChatMessage[]): Promise<InventoryResolutionResult> => {
  const userText = getLastUserText(messages)
  if (!isInventoryQuery(userText)) {
    return {
      messages,
      toolCalls: []
    }
  }

  try {
    const result = await queryInventory(request, userText)
    return {
      messages: insertBeforeLastUserMessage(messages, {
        role: 'system',
        content: result.content
      }),
      toolCalls: [result.toolCall]
    }
  } catch {
    return {
      messages: insertBeforeLastUserMessage(messages, {
        role: 'system',
        content: '本轮尝试查询 SaaS 库存但失败了。请如实告知用户暂时无法获取库存数据，不要编造。'
      }),
      toolCalls: ['inventory-error']
    }
  }
}
