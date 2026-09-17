import path from 'node:path'
import { readFile } from 'node:fs/promises'
import type { FastifyRequest } from 'fastify'
import { serverConfig } from '../config.js'
import { type ChatMessage, extractTextContent } from '../types/chat.js'

type InventoryResolutionResult = {
  messages: ChatMessage[]
  toolCalls: string[]
}

type RawInventoryRecord = {
  name?: string
  factoryName?: string | null
  category?: string | null
  thickness?: number
  location?: string | null
  width?: number
  height?: number
  stockQuantity?: number
  lastInboundAt?: string
}

type OffcutInventoryRecord = {
  tagId?: string
  factoryName?: string | null
  category?: string | null
  thickness?: number
  location?: string | null
  width?: number
  height?: number
  stockQuantity?: number
  inboundAt?: string
}

type MockInventoryFile<T> = {
  records?: T[]
}

let rawInventoryCache: RawInventoryRecord[] | null = null
let offcutInventoryCache: OffcutInventoryRecord[] | null = null

const rawInventoryPath = path.resolve(serverConfig.workspaceRoot, 'server', 'src', 'mockData', 'raw_inventory.json')
const offcutInventoryPath = path.resolve(serverConfig.workspaceRoot, 'server', 'src', 'mockData', 'offcut_inventory.json')

const getLastUserText = (messages: ChatMessage[]) => {
  const lastUserMessage = [...messages].reverse().find(message => message.role === 'user')
  return extractTextContent(lastUserMessage?.content ?? '')
}

const isInventoryQuery = (text: string) => /原片库存|余料库存|仓库库存|查询库存|查库存|库存多少|库存量|可用库存|原片仓|余料|边角料|库位/.test(text)

const isOddmentsQuery = (text: string) => /余料|边角料/.test(text)

// 默认返回前 50 条，和当前业务约定保持一致，避免原片筛选时因默认截断过早造成遗漏。
const DEFAULT_INVENTORY_PAGE_SIZE = 50

const getPageSize = (text: string) => {
  if (/全部|所有/.test(text)) return 200

  const match = text.match(/(?:前|查|查询|显示|返回)?\s*(\d{1,3})\s*条/)
  if (!match) return DEFAULT_INVENTORY_PAGE_SIZE

  return Math.min(Math.max(Number(match[1]), 1), 200)
}

const toText = (value: unknown) => value === null || value === undefined || value === '' ? '-' : String(value)

// 防止数据文本破坏 Markdown 表格结构。
const toTableCell = (value: unknown) => toText(value).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ')

const loadMockRecords = async <T>(filePath: string): Promise<T[]> => {
  const content = await readFile(filePath, 'utf-8')
  const parsed = JSON.parse(content) as MockInventoryFile<T>
  return Array.isArray(parsed.records) ? parsed.records : []
}

const getRawInventoryRecords = async () => {
  if (!rawInventoryCache) {
    rawInventoryCache = await loadMockRecords<RawInventoryRecord>(rawInventoryPath)
  }
  return rawInventoryCache
}

const getOffcutInventoryRecords = async () => {
  if (!offcutInventoryCache) {
    offcutInventoryCache = await loadMockRecords<OffcutInventoryRecord>(offcutInventoryPath)
  }
  return offcutInventoryCache
}

const extractThickness = (text: string) => {
  const match = text.match(/(\d+(?:\.\d+)?)\s*mm/i)
  return match ? Number(match[1]) : null
}

const extractSize = (text: string) => {
  const match = text.match(/(\d{1,8})\s*[xX*×]\s*(\d{1,8})/)
  if (!match) return null
  return {
    width: Number(match[1]),
    height: Number(match[2])
  }
}

const matchesSize = (
  recordWidth: number | undefined,
  recordHeight: number | undefined,
  size: {
    width: number
    height: number
  } | null
) => {
  if (!size) return true
  return (
    (recordWidth === size.width && recordHeight === size.height)
    || (recordWidth === size.height && recordHeight === size.width)
  )
}

const includesKeyword = (source: unknown, keyword: string) => {
  const text = String(source || '').trim().toLowerCase()
  return text ? text.includes(keyword.toLowerCase()) : false
}

const normalizeInventorySearchText = (text: string) => {
  return text
    // 去掉常见的自然语言口头词，避免“帮我查一下原片库存”被整体当成业务关键词。
    .replace(/帮我|麻烦你|麻烦|请问|请|看一下|看下|查一下|查一查|查下|查找|查|看|给我|我想看|我想查|一下/g, ' ')
    // 去掉库存查询场景的通用词，只保留真正用于筛选的业务词。
    .replace(/原片库存|余料库存|仓库库存|查询库存|查库存|库存多少|库存量|可用库存|原片仓|余料|边角料|库位|明细|信息/g, ' ')
    // 规格和厚度会走独立解析逻辑，这里先剔除，避免重复进入关键词匹配。
    .replace(/\d+(?:\.\d+)?\s*mm/gi, ' ')
    .replace(/\d{1,8}\s*[xX*×]\s*\d{1,8}/g, ' ')
}

const getBusinessKeywords = (text: string) => {
  return Array.from(new Set(
    normalizeInventorySearchText(text)
      .split(/[\s,，。；;、]+/)
      .map(item => item.trim())
      .filter(item => item.length >= 2)
      .filter(item => !/^(查询|查|库存|原片|余料|边角料|仓库|多少|显示|返回|前\d+条|全部|所有)$/.test(item))
  ))
}

const filterRawInventory = (records: RawInventoryRecord[], text: string) => {
  const thickness = extractThickness(text)
  const size = extractSize(text)
  const keywords = getBusinessKeywords(text)

  return records.filter((record) => {
    if (thickness !== null && Number(record.thickness) !== thickness) return false
    if (!matchesSize(record.width, record.height, size)) return false
    if (!keywords.length) return true

    return keywords.every(keyword => (
      includesKeyword(record.name, keyword)
      || includesKeyword(record.factoryName, keyword)
      || includesKeyword(record.category, keyword)
      || includesKeyword(record.location, keyword)
    ))
  })
}

const filterOffcutInventory = (records: OffcutInventoryRecord[], text: string) => {
  const thickness = extractThickness(text)
  const size = extractSize(text)
  const keywords = getBusinessKeywords(text)

  return records.filter((record) => {
    if (thickness !== null && Number(record.thickness) !== thickness) return false
    if (!matchesSize(record.width, record.height, size)) return false
    if (!keywords.length) return true

    return keywords.every(keyword => (
      includesKeyword(record.tagId, keyword)
      || includesKeyword(record.factoryName, keyword)
      || includesKeyword(record.category, keyword)
      || includesKeyword(record.location, keyword)
    ))
  })
}

const formatGlassInventory = (records: RawInventoryRecord[]) => {
  const header = '| 序号 | 名称 | 厂家 | 品类 | 厚度(mm) | 宽度 | 高度 | 库存(张) | 库位 | 最近入库时间 |'
  const separator = '| ---: | --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- |'
  const rows = records.map((item, index) => (
    `| ${ index + 1 } | ${ toTableCell(item.name) } | ${ toTableCell(item.factoryName) } | ${ toTableCell(item.category) } | ${ toTableCell(item.thickness) } | ${ toTableCell(item.width) } | ${ toTableCell(item.height) } | ${ toTableCell(item.stockQuantity) } | ${ toTableCell(item.location) } | ${ toTableCell(item.lastInboundAt) } |`
  ))
  const emptyRow = '| - | 当前无数据 | - | - | - | - | - | - | - | - |'
  return ['原片库存明细', '', header, separator, ...(rows.length ? rows : [emptyRow])].join('\n')
}

const formatOddmentsInventory = (records: OffcutInventoryRecord[]) => {
  const header = '| 序号 | 标签号 | 厂家 | 品类 | 厚度(mm) | 宽度 | 高度 | 库存(张) | 库位 | 入库时间 |'
  const separator = '| ---: | --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- |'
  const rows = records.map((item, index) => (
    `| ${ index + 1 } | ${ toTableCell(item.tagId) } | ${ toTableCell(item.factoryName) } | ${ toTableCell(item.category) } | ${ toTableCell(item.thickness) } | ${ toTableCell(item.width) } | ${ toTableCell(item.height) } | ${ toTableCell(item.stockQuantity) } | ${ toTableCell(item.location) } | ${ toTableCell(item.inboundAt) } |`
  ))
  const emptyRow = '| - | 当前无数据 | - | - | - | - | - | - | - | - |'
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

const queryInventory = async (_request: FastifyRequest, text: string) => {
  const oddments = isOddmentsQuery(text)
  const pageSize = getPageSize(text)
  const allRecords = oddments
    ? await getOffcutInventoryRecords()
    : await getRawInventoryRecords()
  const filteredRecords = oddments
    ? filterOffcutInventory(allRecords as OffcutInventoryRecord[], text)
    : filterRawInventory(allRecords as RawInventoryRecord[], text)
  const records = filteredRecords.slice(0, pageSize)
  const total = filteredRecords.length
  const tableTitle = oddments ? '余料库存明细' : '原片库存明细'

  return {
    content: [
      '当前业务查询已切换为本地 mock 数据源，系统不会再尝试连接 SaaS 或要求用户登录。',
      `本轮命中 ${ total } 条本地库存记录，当前返回前 ${ records.length } 条。`,
      `如果表格为空，请直接说明“当前没有符合条件的本地${ oddments ? '余料' : '原片' }库存数据”，不要编造。`,
      `输出要求：先给出不超过 5 条的简短摘要，再输出“${ tableTitle }”Markdown 表格，并保留下面提供的全部记录。`,
      '',
      oddments ? formatOddmentsInventory(records as OffcutInventoryRecord[]) : formatGlassInventory(records as RawInventoryRecord[])
    ].join('\n'),
    toolCall: oddments ? 'mock-oddments-inventory' : 'mock-glass-inventory'
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
        content: '读取本地 mock 库存数据失败。请如实告知用户当前无法获取库存数据，不要编造。'
      }),
      toolCalls: ['inventory-error']
    }
  }
}
