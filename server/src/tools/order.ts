import type { FastifyRequest } from 'fastify'
import { serverConfig } from '../config.js'
import { getSaasToken } from '../routes/saas.js'
import { type ChatMessage, extractTextContent } from '../types/chat.js'

type OrderResolutionResult = {
  messages: ChatMessage[]
  toolCalls: string[]
}

type SaasOrderResult = {
  code?: number
  message?: string
  data?: {
    list?: unknown[]
    total?: number
  }
}

const getLastUserText = (messages: ChatMessage[]) => {
  const lastUserMessage = [...messages].reverse().find(message => message.role === 'user')
  return extractTextContent(lastUserMessage?.content ?? '')
}

const isOrderQuery = (text: string) => /查询订单|查订单|订单信息|订单列表|订单情况|近.+订单/.test(text)

const getPageSize = (text: string) => {
  if (/全部|所有/.test(text)) return 200

  const match = text.match(/(?:前|查|查询|显示|返回)?\s*(\d{1,3})\s*条/)
  if (!match) return 20

  return Math.min(Math.max(Number(match[1]), 1), 200)
}

const formatDate = (date: Date) => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${ year }-${ month }-${ day }`
}

const getRecentMonthRange = () => {
  const end = new Date()
  const start = new Date(end)
  start.setDate(start.getDate() - 29)
  return {
    createTime: formatDate(start),
    endTime: formatDate(end)
  }
}

const toText = (value: unknown) => value === null || value === undefined || value === '' ? '-' : String(value)

// 防止接口文本破坏 Markdown 表格结构。
const toTableCell = (value: unknown) => toText(value).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ')

const formatOrders = (records: unknown[], total?: number) => {
  const header = '| 序号 | 订单号 | 客户 | 项目 | 产品 | 订单类型 | 下单日期 | 制单日期 | 交货日期 | 总数量 | 审核状态 | 生产状态 | 发货状态 | 业务员 |'
  const separator = '| ---: | --- | --- | --- | --- | --- | --- | --- | --- | ---: | --- | --- | --- | --- |'
  const rows = records.map((item, index) => {
    const value = item as Record<string, unknown>
    return `| ${ index + 1 } | ${ toTableCell(value.orderNumber) } | ${ toTableCell(value.customer) } | ${ toTableCell(value.projectName) } | ${ toTableCell(value.productName) } | ${ toTableCell(value.orderTypeName) } | ${ toTableCell(value.orderDate) } | ${ toTableCell(value.createTime) } | ${ toTableCell(value.sendDate) } | ${ toTableCell(value.totalQuantity) } | ${ toTableCell(value.auditState) } | ${ toTableCell(value.produceSchedule) } | ${ toTableCell(value.deliverSchedule) } | ${ toTableCell(value.salesmanName) } |`
  })
  const totalText = typeof total === 'number' ? `，总计 ${ total } 条` : ''
  const emptyRow = '| - | 暂无数据 | - | - | - | - | - | - | - | - | - | - | - | - |'
  return [`订单明细（当前页 ${ rows.length } 条${ totalText }）`, '', header, separator, ...(rows.length ? rows : [emptyRow])].join('\n')
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

const queryOrders = async (request: FastifyRequest, text: string) => {
  const token = getSaasToken(request)
  if (!token) {
    return {
      content: '用户正在查询订单，但当前未登录 SaaS。不要调用或猜测订单数据；请提示用户先在页面右上角登录 SaaS 后再查询。',
      toolCall: 'order-auth-required'
    }
  }

  const pageSize = getPageSize(text)
  const dateRange = getRecentMonthRange()
  const response = await fetch(`${ serverConfig.saasBaseUrl }/sale/order/list?pageNum=1&pageSize=${ pageSize }`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': token
    },
    body: JSON.stringify(dateRange),
    signal: AbortSignal.timeout(30000)
  })
  const result = await response.json().catch(() => ({})) as SaasOrderResult
  if (!response.ok || result.code !== 200) {
    throw new Error(result.message || '订单服务请求失败')
  }

  const records = result.data?.list || []
  return {
    content: [
      '当前用户已登录 SaaS，本轮订单查询已成功完成。',
      '请直接基于下面的实时订单数据回答用户，不要再说未登录、无法查询或请先登录。',
      `本轮已调用 SaaS 订单查询工具，查询制单日期 ${ dateRange.createTime } 至 ${ dateRange.endTime } 的第 1 页，最多 ${ pageSize } 条。请严格基于以下实时数据回答，不要编造未返回的订单数据。`,
      '输出要求：先给出不超过 5 条的简短摘要，再输出“订单明细”Markdown 表格。表格必须逐行保留下面提供的当前页全部记录和字段，不得改成列表，不得聚合、合并或省略。',
      '',
      formatOrders(records, result.data?.total)
    ].join('\n'),
    toolCall: 'saas-order-list'
  }
}

export const resolveOrderMessages = async (request: FastifyRequest, messages: ChatMessage[]): Promise<OrderResolutionResult> => {
  const userText = getLastUserText(messages)
  if (!isOrderQuery(userText)) {
    return {
      messages,
      toolCalls: []
    }
  }

  try {
    const result = await queryOrders(request, userText)
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
        content: '本轮尝试查询 SaaS 订单但失败了。请如实告知用户暂时无法获取订单数据，不要编造。'
      }),
      toolCalls: ['order-error']
    }
  }
}
