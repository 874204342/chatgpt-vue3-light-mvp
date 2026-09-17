import path from 'node:path'
import { readFile } from 'node:fs/promises'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { serverConfig } from '../config.js'

type InventoryListBody = {
  inventoryType?: 'raw' | 'offcut'
  pageParam?: {
    pageNum?: number
    pageSize?: number
    total?: number
  }
  keyword?: string
  factoryName?: string
  categoryName?: string
  thickness?: string | number
  location?: string
}

type RawInventoryRecord = {
  id?: string
  name?: string
  factoryName?: string | null
  category?: string | null
  grade?: string | null
  colorFilm?: string | null
  thickness?: number
  location?: string | null
  specification?: string | null
  width?: number
  height?: number
  stockQuantity?: number
  stockArea?: number
  lastInboundAt?: string
}

type OffcutInventoryRecord = {
  id?: string
  tagId?: string
  factoryName?: string | null
  category?: string | null
  grade?: string | null
  colorFilm?: string | null
  thickness?: number
  location?: string | null
  width?: number
  height?: number
  stockQuantity?: number
  stockArea?: number
  inboundAt?: string
}

type MockInventoryFile<T> = {
  records?: T[]
}

const rawInventoryPath = path.resolve(serverConfig.workspaceRoot, 'server', 'src', 'mockData', 'raw_inventory.json')
const offcutInventoryPath = path.resolve(serverConfig.workspaceRoot, 'server', 'src', 'mockData', 'offcut_inventory.json')
let rawInventoryCache: RawInventoryRecord[] | null = null
let offcutInventoryCache: OffcutInventoryRecord[] | null = null

const toText = (value: unknown) => String(value ?? '').trim()

const includesText = (source: unknown, keyword: string) => {
  const target = toText(source).toLowerCase()
  const query = keyword.trim().toLowerCase()
  if (!query) return true
  return target.includes(query)
}

const equalsNumberLike = (source: unknown, keyword: string | number | undefined) => {
  const query = toText(keyword)
  if (!query) return true
  return toText(source) === query
}

const roundNumber = (value: number, digits = 2) => {
  if (!Number.isFinite(value)) return 0
  const multiplier = 10 ** digits
  return Math.round(value * multiplier) / multiplier
}

const loadInventoryRecords = async <T>(filePath: string): Promise<T[]> => {
  const content = await readFile(filePath, 'utf-8')
  const parsed = JSON.parse(content) as MockInventoryFile<T>
  return Array.isArray(parsed.records) ? parsed.records : []
}

const getRawInventoryRecords = async () => {
  if (!rawInventoryCache) {
    rawInventoryCache = await loadInventoryRecords<RawInventoryRecord>(rawInventoryPath)
  }
  return rawInventoryCache
}

const getOffcutInventoryRecords = async () => {
  if (!offcutInventoryCache) {
    offcutInventoryCache = await loadInventoryRecords<OffcutInventoryRecord>(offcutInventoryPath)
  }
  return offcutInventoryCache
}

const matchesKeyword = (fields: unknown[], keyword: string) => {
  if (!keyword.trim()) return true
  return fields.some(field => includesText(field, keyword))
}

const filterRawInventoryRecords = (records: RawInventoryRecord[], body: InventoryListBody) => {
  return records.filter((record) => {
    if (!includesText(record.factoryName, body.factoryName || '')) return false
    if (!includesText(record.category, body.categoryName || '')) return false
    if (!equalsNumberLike(record.thickness, body.thickness)) return false
    if (!includesText(record.location, body.location || '')) return false
    if (!matchesKeyword([
      record.name,
      record.factoryName,
      record.category,
      record.grade,
      record.colorFilm,
      record.location,
      record.specification,
      `${ record.width || '' }x${ record.height || '' }`
    ], body.keyword || '')) return false

    return true
  })
}

const filterOffcutInventoryRecords = (records: OffcutInventoryRecord[], body: InventoryListBody) => {
  return records.filter((record) => {
    if (!includesText(record.factoryName, body.factoryName || '')) return false
    if (!includesText(record.category, body.categoryName || '')) return false
    if (!equalsNumberLike(record.thickness, body.thickness)) return false
    if (!includesText(record.location, body.location || '')) return false
    if (!matchesKeyword([
      record.tagId,
      record.factoryName,
      record.category,
      record.grade,
      record.colorFilm,
      record.location,
      `${ record.width || '' }x${ record.height || '' }`
    ], body.keyword || '')) return false

    return true
  })
}

const getPagedList = <T>(records: T[], body: InventoryListBody) => {
  const pageNum = Math.max(Number(body.pageParam?.pageNum || 1), 1)
  const pageSize = Math.max(Number(body.pageParam?.pageSize || 50), 1)
  const start = (pageNum - 1) * pageSize
  const end = start + pageSize

  return {
    list: records.slice(start, end),
    total: records.length,
    pageNum,
    pageSize
  }
}

const buildInventorySummary = (records: Array<RawInventoryRecord | OffcutInventoryRecord>) => {
  const totalStockQuantity = records.reduce((sum, item) => sum + Number(item.stockQuantity || 0), 0)
  const totalStockArea = records.reduce((sum, item) => sum + Number(item.stockArea || 0), 0)

  return {
    totalRecords: records.length,
    totalStockQuantity,
    totalStockArea: roundNumber(totalStockArea)
  }
}

const handleRouteError = (reply: FastifyReply, message = '获取库存列表失败') => {
  reply.code(500)
  return {
    code: 500,
    message
  }
}

export const registerInventoryRoutes = async (app: FastifyInstance) => {
  app.post<{ Body: InventoryListBody; }>('/api/inventory/list', async (request, reply) => {
    try {
      const body = request.body || {}
      const inventoryType = body.inventoryType === 'offcut' ? 'offcut' : 'raw'
      const allRecords = inventoryType === 'offcut'
        ? await getOffcutInventoryRecords()
        : await getRawInventoryRecords()
      const filteredRecords = inventoryType === 'offcut'
        ? filterOffcutInventoryRecords(allRecords as OffcutInventoryRecord[], body)
        : filterRawInventoryRecords(allRecords as RawInventoryRecord[], body)
      const pagedData = getPagedList(filteredRecords, body)
      const inventoryLabel = inventoryType === 'offcut' ? '余料库存' : '原片库存'

      return {
        code: 200,
        message: filteredRecords.length ? `已匹配 ${ filteredRecords.length } 条本地 mock ${ inventoryLabel }数据` : `未匹配到符合条件的本地 mock ${ inventoryLabel }数据`,
        data: {
          list: pagedData.list,
          total: pagedData.total,
          pageNum: pagedData.pageNum,
          pageSize: pagedData.pageSize,
          summary: buildInventorySummary(filteredRecords)
        }
      }
    } catch {
      return handleRouteError(reply)
    }
  })
}
