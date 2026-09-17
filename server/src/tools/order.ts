import path from 'node:path'
import { readFile } from 'node:fs/promises'
import type { FastifyRequest } from 'fastify'
import { serverConfig } from '../config.js'
import { type ChatMessage, extractTextContent } from '../types/chat.js'

type OrderResolutionResult = {
  messages: ChatMessage[]
  toolCalls: string[]
}

type OrderImportRecord = {
  orderNumber?: string
  customerName?: string
  projectName?: string
  floorNumber?: string
  productName?: string
  glassName?: string
  categoryName?: string
  thickness?: string | number
  width?: string | number
  height?: string | number
  unPlateQuantity?: string | number
  area?: string | number
  createTime?: string
  sendDate?: string
}

type OrderImportMockFile = {
  records?: OrderImportRecord[]
}

let orderImportCache: OrderImportRecord[] | null = null
const orderImportMockPath = path.resolve(serverConfig.workspaceRoot, 'server', 'src', 'mockData', 'order_import.json')

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

const toText = (value: unknown) => value === null || value === undefined || value === '' ? '-' : String(value)

const toTableCell = (value: unknown) => toText(value).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ')

const loadOrderImportRecords = async () => {
  if (orderImportCache) return orderImportCache

  const content = await readFile(orderImportMockPath, 'utf-8')
  const parsed = JSON.parse(content) as OrderImportMockFile
  orderImportCache = Array.isArray(parsed.records) ? parsed.records : []
  return orderImportCache
}

const getOrderKeywords = (text: string) => {
  return Array.from(new Set(
    text
      .split(/[\s,，。；;、]+/)
      .map(item => item.trim())
      .filter(item => item.length >= 2)
      .filter(item => !/^(查询|查|订单|信息|列表|情况|近一个月|近一月|最近|显示|返回|前\d+条|全部|所有)$/.test(item))
  ))
}

const filterOrderRecords = (records: OrderImportRecord[], text: string) => {
  const keywords = getOrderKeywords(text)
  if (!keywords.length) return records

  return records.filter(record => keywords.every(keyword => {
    const normalizedKeyword = keyword.toLowerCase()
    return [
      record.orderNumber,
      record.customerName,
      record.projectName,
      record.floorNumber,
      record.productName,
      record.glassName,
      record.categoryName,
      record.thickness,
      record.width,
      record.height
    ].some(item => String(item ?? '').toLowerCase().includes(normalizedKeyword))
  }))
}

const formatOrders = (records: OrderImportRecord[], total: number) => {
  const header = '| 序号 | 订单号 | 客户 | 项目 | 楼层 | 产品 | 单片名称 | 品类 | 厚度(mm) | 规格 | 数量 | 面积 | 制单时间 | 交付日期 |'
  const separator = '| ---: | --- | --- | --- | --- | --- | --- | --- | ---: | --- | ---: | ---: | --- | --- |'
  const rows = records.map((item, index) => (
    `| ${ index + 1 } | ${ toTableCell(item.orderNumber) } | ${ toTableCell(item.customerName) } | ${ toTableCell(item.projectName) } | ${ toTableCell(item.floorNumber) } | ${ toTableCell(item.productName) } | ${ toTableCell(item.glassName) } | ${ toTableCell(item.categoryName) } | ${ toTableCell(item.thickness) } | ${ toTableCell(`${ toText(item.width) }×${ toText(item.height) }`) } | ${ toTableCell(item.unPlateQuantity) } | ${ toTableCell(item.area) } | ${ toTableCell(item.createTime) } | ${ toTableCell(item.sendDate) } |`
  ))
  const emptyRow = '| - | 当前无数据 | - | - | - | - | - | - | - | - | - | - | - | - |'
  return [`订单明细（当前页 ${ rows.length } 条，总计 ${ total } 条）`, '', header, separator, ...(rows.length ? rows : [emptyRow])].join('\n')
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

const queryOrders = async (text: string) => {
  const pageSize = getPageSize(text)
  const records = await loadOrderImportRecords()
  const filteredRecords = filterOrderRecords(records, text)
  const pageRecords = filteredRecords.slice(0, pageSize)

  return {
    content: [
      '当前项目的订单查询已切换为本地 mock 数据源，不再依赖 SaaS 登录态。',
      `本轮命中 ${ filteredRecords.length } 条本地订单记录，当前返回前 ${ pageRecords.length } 条。`,
      '如果表格为空，请直接告知用户当前没有符合条件的本地订单数据，不要编造。',
      '输出要求：先给出不超过 5 条的简短摘要，再输出“订单明细”Markdown 表格，并保留下面提供的全部记录。',
      '',
      formatOrders(pageRecords, filteredRecords.length)
    ].join('\n'),
    toolCall: 'mock-order-list'
  }
}

export const resolveOrderMessages = async (_request: FastifyRequest, messages: ChatMessage[]): Promise<OrderResolutionResult> => {
  const userText = getLastUserText(messages)
  if (!isOrderQuery(userText)) {
    return {
      messages,
      toolCalls: []
    }
  }

  try {
    const result = await queryOrders(userText)
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
        content: '读取本地 mock 订单数据失败。请如实告知用户当前无法获取订单数据，不要编造。'
      }),
      toolCalls: ['order-error']
    }
  }
}
