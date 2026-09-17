import path from 'node:path'
import { readFile } from 'node:fs/promises'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { serverConfig } from '../config.js'

type OrderImportBody = {
  pageParam?: {
    pageNum?: number
    pageSize?: number
    total?: number
  }
  orderNumber?: string
  customerName?: string
  projectName?: string
  floorNumber?: string
  productName?: string | null
  glassName?: string
  width?: string | number
  height?: string | number
  categoryName?: string
  thickness?: string | number
  createDateBegin?: string
  createDateEnd?: string
  sendDateBegin?: string
  sendDateEnd?: string
}

type OrderImportRecord = {
  uniqueIndex?: string
  categoryName?: string
  thickness?: string | number
  orderNumber?: string
  customerName?: string
  projectName?: string
  floorNumber?: string
  productName?: string
  glassName?: string
  unPlateQuantity?: string | number
  area?: string | number
  createTime?: string
  sendDate?: string
  width?: string | number
  height?: string | number
}

type OrderImportMockFile = {
  records?: OrderImportRecord[]
}

type CategorySummaryItem = {
  unOptimThickness: string
}

const noOrderDataMessage = '当前暂无本地 mock 订单数据'
const orderImportMockPath = path.resolve(serverConfig.workspaceRoot, 'server', 'src', 'mockData', 'order_import.json')
let orderImportCache: OrderImportRecord[] | null = null

const loadOrderImportRecords = async () => {
  if (orderImportCache) return orderImportCache

  const content = await readFile(orderImportMockPath, 'utf-8')
  const parsed = JSON.parse(content) as OrderImportMockFile
  orderImportCache = Array.isArray(parsed.records) ? parsed.records : []
  return orderImportCache
}

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

const isDateInRange = (value: unknown, begin?: string, end?: string) => {
  const target = toText(value).slice(0, 10)
  if (!target) return false
  if (begin && target < begin) return false
  if (end && target > end) return false
  return true
}

const filterOrderImportRecords = (records: OrderImportRecord[], body: OrderImportBody) => {
  return records.filter((record) => {
    if (!includesText(record.orderNumber, body.orderNumber || '')) return false
    if (!includesText(record.customerName, body.customerName || '')) return false
    if (!includesText(record.projectName, body.projectName || '')) return false
    if (!includesText(record.floorNumber, body.floorNumber || '')) return false
    if (!includesText(record.productName, toText(body.productName))) return false
    if (!includesText(record.glassName, body.glassName || '')) return false
    if (!includesText(record.categoryName, body.categoryName || '')) return false
    if (!equalsNumberLike(record.thickness, body.thickness)) return false
    if (!equalsNumberLike(record.width, body.width)) return false
    if (!equalsNumberLike(record.height, body.height)) return false
    if (body.createDateBegin || body.createDateEnd) {
      if (!isDateInRange(record.createTime, body.createDateBegin, body.createDateEnd)) return false
    }
    if (body.sendDateBegin || body.sendDateEnd) {
      if (!isDateInRange(record.sendDate, body.sendDateBegin, body.sendDateEnd)) return false
    }
    return true
  })
}

const buildCategorySummary = (records: OrderImportRecord[]) => {
  const summaryMap = new Map<string, Set<string>>()

  records.forEach((record) => {
    const categoryName = toText(record.categoryName)
    const thickness = toText(record.thickness)
    if (!categoryName || !thickness) return

    const currentSet = summaryMap.get(categoryName) || new Set<string>()
    currentSet.add(thickness)
    summaryMap.set(categoryName, currentSet)
  })

  return [...summaryMap.entries()].reduce<Record<string, CategorySummaryItem[]>>((accumulator, [categoryName, thicknessSet]) => {
    accumulator[categoryName] = [...thicknessSet]
      .sort((left, right) => Number(left) - Number(right))
      .map(item => ({
        unOptimThickness: item
      }))
    return accumulator
  }, {})
}

const getPagedList = (records: OrderImportRecord[], body: OrderImportBody) => {
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

const handleRouteError = (reply: FastifyReply, message = '读取本地订单 mock 数据失败') => {
  reply.code(500)
  return {
    code: 500,
    message
  }
}

export const registerOrderImportRoutes = async (app: FastifyInstance) => {
  app.post<{ Body: OrderImportBody; }>('/api/order-import/category-summary', async (request, reply) => {
    try {
      // 品类汇总需要跟随当前筛选条件动态变化，便于前端联动厚度选项。
      const records = await loadOrderImportRecords()
      if (!records.length) {
        return {
          code: 200,
          message: noOrderDataMessage,
          data: {}
        }
      }

      const filteredRecords = filterOrderImportRecords(records, request.body || {})
      return {
        code: 200,
        message: `已加载 ${ filteredRecords.length } 条本地 mock 订单数据`,
        data: buildCategorySummary(filteredRecords)
      }
    } catch {
      return handleRouteError(reply)
    }
  })

  app.post<{ Body: OrderImportBody; }>('/api/order-import/list', async (request, reply) => {
    try {
      const records = await loadOrderImportRecords()
      if (!records.length) {
        return {
          code: 200,
          message: noOrderDataMessage,
          data: {
            list: [],
            total: 0
          }
        }
      }

      const filteredRecords = filterOrderImportRecords(records, request.body || {})
      const pagedData = getPagedList(filteredRecords, request.body || {})
      return {
        code: 200,
        message: filteredRecords.length ? `已匹配 ${ filteredRecords.length } 条本地 mock 订单数据` : '未匹配到符合条件的本地 mock 订单数据',
        data: {
          list: pagedData.list,
          total: pagedData.total,
          pageNum: pagedData.pageNum,
          pageSize: pagedData.pageSize
        }
      }
    } catch {
      return handleRouteError(reply)
    }
  })
}
