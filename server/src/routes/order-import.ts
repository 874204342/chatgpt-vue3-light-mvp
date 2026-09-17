import path from 'node:path'
import { readFile } from 'node:fs/promises'
import type { FastifyInstance, FastifyReply } from 'fastify'
import * as XLSX from 'xlsx'
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

type ExcelPreviewBody = {
  fileName?: string
  fileContent?: string
  mergeDuplicates?: boolean
}

type OrderImportRecord = {
  uniqueIndex?: string
  orderSpecId?: string | number
  categoryName?: string
  thickness?: string | number
  orderNumber?: string
  customerName?: string
  projectName?: string
  floorNumber?: string
  productName?: string
  glassName?: string
  pieceName?: string
  selfCode?: string
  flowCardNumber?: string
  rackNumber?: string
  unPlateQuantity?: string | number
  num?: string | number
  area?: string | number
  createTime?: string
  sendDate?: string
  width?: string | number
  height?: string | number
  productEdgingName?: string
  processingRequirements?: string
  specialCraft?: string
  remark?: string
  productEdgingConfig?: {
    leftValue: number
    rightValue: number
    topValue: number
    downValue: number
  }
}

type OrderImportMockFile = {
  records?: OrderImportRecord[]
}

type CategorySummaryItem = {
  unOptimThickness: string
}

type ParsedExcelRow = OrderImportRecord & {
  rowIndex: number
  validationStatus: 'valid' | 'invalid'
  validationMessages: string[]
  sourceRowIndexes: number[]
}

type ParsedExcelPreview = {
  sheetName: string
  rows: ParsedExcelRow[]
  invalidRows: ParsedExcelRow[]
  summary: {
    totalRows: number
    validRows: number
    invalidRows: number
    mergedRows: number
    categoryCount: number
    totalQuantity: number
    totalArea: number
  }
}

type FieldKey =
  | 'orderNumber'
  | 'customerName'
  | 'projectName'
  | 'floorNumber'
  | 'productName'
  | 'glassName'
  | 'selfCode'
  | 'flowCardNumber'
  | 'rackNumber'
  | 'categoryName'
  | 'thickness'
  | 'width'
  | 'height'
  | 'spec'
  | 'unPlateQuantity'
  | 'productEdgingName'
  | 'processingRequirements'
  | 'specialCraft'
  | 'remark'
  | 'createTime'
  | 'sendDate'

const noOrderDataMessage = '当前暂无本地 mock 订单数据'
const orderImportMockPath = path.resolve(serverConfig.workspaceRoot, 'server', 'src', 'mockData', 'order_import.json')
const orderImportTemplatePath = path.resolve(serverConfig.workspaceRoot, 'server', 'src', 'excelTemplate', '需切成品模板.xlsx')
let orderImportCache: OrderImportRecord[] | null = null

const excelHeaderAliasMap: Record<FieldKey, string[]> = {
  orderNumber: ['订单编号', '订单号', '订单编码', '单号'],
  customerName: ['客户名称', '客户', '客户名'],
  projectName: ['项目名称', '项目', '工程名称'],
  floorNumber: ['楼层编号', '楼层', '楼栋楼层', '楼层号'],
  productName: ['产品名称', '产品', '部件名称'],
  glassName: ['单片名称', '玻璃名称', '玻璃名', '成品名称', '名称', '片名'],
  selfCode: ['自编号', '自编编号', '内部编号', '片号'],
  flowCardNumber: ['流程卡号', '流程卡编号', '流程编号'],
  rackNumber: ['架号', '货架号', '架位'],
  categoryName: ['品类', '玻璃品类', '材质', '玻璃类型', '类别', '品种'],
  thickness: ['厚度', '厚度mm', '厚度毫米', '厚度(mm)', '厚度（mm）'],
  width: ['宽度', '宽', '成品宽', '净宽'],
  height: ['高度', '高', '成品高', '净高'],
  spec: ['规格', '尺寸', '成品规格', '玻璃规格'],
  unPlateQuantity: ['数量', '片数', '未优化数量', '需求数量', '下单数量', '数量pcs'],
  productEdgingName: ['磨边', '磨边值', '磨边配置', '四边磨边', '修边', '磨边等级'],
  processingRequirements: ['加工要求', '加工说明', '工艺要求'],
  specialCraft: ['特殊工艺', '特殊要求', '特殊说明'],
  remark: ['备注', '备注信息', '备注说明'],
  createTime: ['制单时间', '创建时间', '下单时间'],
  sendDate: ['交货日期', '交期', '送货日期', '交付日期']
}

const templateHeaders = [
  '产品名称（选填）',
  '单片名称（选填）',
  '*品类',
  '*宽',
  '*高',
  '*数量',
  '*厚度',
  '订单编号',
  '自编号',
  '流程卡号',
  '架号',
  '项目名称',
  '客户名称',
  '楼层编号',
  '加工要求',
  '备注',
  '特殊工艺',
  '磨边等级'
]

const templateRows = [
  ['固定窗玻璃', '超白900x1950', '超白', 900, 1950, 18, 8, 'D26092001', 'ZB-001', 'LC-20260920-001', 'A-08', '云锦中心', '华瑞建设', '8F', '四边磨边', '现场急单', '钢化', '0|0|0|0'],
  ['幕墙面板', 'Low-E950x2100', 'Low-E', 950, 2100, 20, 6, 'D26092002', 'ZB-002', 'LC-20260920-002', 'B-10', '星河幕墙项目', '锦宸幕墙', '10F', '四边精磨', '', '夹胶', '精磨']
]

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

const normalizeHeaderText = (value: unknown) => {
  return toText(value)
    .replace(/[＊*]/g, '')
    .replace(/[\s_\-]/g, '')
    .replace(/[()（）]/g, '')
    .replace(/选填|必填/g, '')
    .replace(/毫米/gi, 'mm')
    .toLowerCase()
}

const parseNumberLike = (value: unknown) => {
  const normalizedValue = toText(value)
    .replace(/，/g, ',')
    .replace(/,/g, '')
    .replace(/mm|毫米|片|pcs|㎡|m2/gi, '')
    .trim()
  if (!normalizedValue) return NaN
  return Number(normalizedValue)
}

const roundNumber = (value: number, digits = 2) => {
  if (!Number.isFinite(value)) return 0
  const multiplier = 10 ** digits
  return Math.round(value * multiplier) / multiplier
}

const isFiniteNumber = (value: unknown) => Number.isFinite(Number(value))

const parseSpecValue = (value: unknown) => {
  const normalizedValue = toText(value)
    .replace(/[×xX＊*]/g, 'x')
    .replace(/\s+/g, '')
  const match = normalizedValue.match(/(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)/)
  if (!match) return null

  return {
    width: Number(match[1]),
    height: Number(match[2])
  }
}

const parseEdgingConfig = (value: unknown) => {
  const normalizedValue = toText(value)
  if (!normalizedValue) {
    return {
      text: '',
      config: undefined
    }
  }

  // 真实模板中的“磨边等级”既可能是 0|0|0|0，也可能是“精磨”等业务文本，这里要兼容两种写法。
  const segments = normalizedValue
    .split(/[|,，/]/)
    .map(item => item.trim())
    .filter(Boolean)

  if (segments.length > 1 && segments.every(item => isFiniteNumber(item))) {
    const [leftValue = 0, rightValue = 0, topValue = 0, downValue = 0] = segments.map(Number)

    return {
      text: [leftValue, rightValue, topValue, downValue].join('|'),
      config: {
        leftValue,
        rightValue,
        topValue,
        downValue
      }
    }
  }

  return {
    text: normalizedValue,
    config: undefined
  }
}

const getColumnIndexMap = (headerRow: unknown[]) => {
  const headerMap = new Map<string, number>()

  headerRow.forEach((headerCell, index) => {
    const normalizedHeader = normalizeHeaderText(headerCell)
    if (!normalizedHeader || headerMap.has(normalizedHeader)) return
    headerMap.set(normalizedHeader, index)
  })

  return Object.entries(excelHeaderAliasMap).reduce<Record<FieldKey, number | null>>((accumulator, [field, aliases]) => {
    const matchedHeader = aliases.find(alias => headerMap.has(normalizeHeaderText(alias)))
    accumulator[field as FieldKey] = matchedHeader ? headerMap.get(normalizeHeaderText(matchedHeader)) ?? null : null
    return accumulator
  }, {
    orderNumber: null,
    customerName: null,
    projectName: null,
    floorNumber: null,
    productName: null,
    glassName: null,
    selfCode: null,
    flowCardNumber: null,
    rackNumber: null,
    categoryName: null,
    thickness: null,
    width: null,
    height: null,
    spec: null,
    unPlateQuantity: null,
    productEdgingName: null,
    processingRequirements: null,
    specialCraft: null,
    remark: null,
    createTime: null,
    sendDate: null
  })
}

const getCellValue = (row: unknown[], columnIndex: number | null) => {
  if (columnIndex === null || columnIndex < 0) return ''
  return row[columnIndex]
}

const buildDisplayName = ({
  glassName,
  selfCode,
  flowCardNumber,
  productName,
  categoryName,
  width,
  height
}: {
  glassName: string
  selfCode: string
  flowCardNumber: string
  productName: string
  categoryName: string
  width: number
  height: number
}) => {
  if (glassName) return glassName
  if (selfCode) return selfCode
  if (flowCardNumber) return flowCardNumber
  if (productName) return productName
  if (categoryName && Number.isFinite(width) && Number.isFinite(height)) {
    return `${ categoryName }${ width }x${ height }`
  }
  return ''
}

const normalizeExcelRow = (row: unknown[], rowIndex: number, columnIndexMap: Record<FieldKey, number | null>) => {
  const specValue = parseSpecValue(getCellValue(row, columnIndexMap.spec))
  const widthFromCell = parseNumberLike(getCellValue(row, columnIndexMap.width))
  const heightFromCell = parseNumberLike(getCellValue(row, columnIndexMap.height))
  const width = Number.isFinite(widthFromCell) ? widthFromCell : specValue?.width ?? NaN
  const height = Number.isFinite(heightFromCell) ? heightFromCell : specValue?.height ?? NaN
  const quantity = parseNumberLike(getCellValue(row, columnIndexMap.unPlateQuantity))
  const thickness = parseNumberLike(getCellValue(row, columnIndexMap.thickness))
  const edging = parseEdgingConfig(getCellValue(row, columnIndexMap.productEdgingName))
  const categoryName = toText(getCellValue(row, columnIndexMap.categoryName))
  const productName = toText(getCellValue(row, columnIndexMap.productName))
  const selfCode = toText(getCellValue(row, columnIndexMap.selfCode))
  const flowCardNumber = toText(getCellValue(row, columnIndexMap.flowCardNumber))
  const glassName = buildDisplayName({
    glassName: toText(getCellValue(row, columnIndexMap.glassName)),
    selfCode,
    flowCardNumber,
    productName,
    categoryName,
    width,
    height
  })
  const validationMessages: string[] = []

  if (!categoryName) validationMessages.push('品类为空')
  if (!Number.isFinite(thickness) || thickness <= 0) validationMessages.push('厚度无效')
  if (!Number.isFinite(width) || width <= 0) validationMessages.push('宽度无效')
  if (!Number.isFinite(height) || height <= 0) validationMessages.push('高度无效')
  if (!Number.isFinite(quantity) || quantity <= 0) validationMessages.push('数量无效')

  const area = Number.isFinite(width) && Number.isFinite(height) && Number.isFinite(quantity)
    ? roundNumber((width * height * quantity) / 1000000, 2)
    : 0

  return {
    uniqueIndex: `EXCEL-${ String(rowIndex).padStart(4, '0') }`,
    rowIndex,
    orderNumber: toText(getCellValue(row, columnIndexMap.orderNumber)),
    customerName: toText(getCellValue(row, columnIndexMap.customerName)),
    projectName: toText(getCellValue(row, columnIndexMap.projectName)),
    floorNumber: toText(getCellValue(row, columnIndexMap.floorNumber)),
    productName,
    glassName,
    pieceName: glassName,
    selfCode,
    flowCardNumber,
    rackNumber: toText(getCellValue(row, columnIndexMap.rackNumber)),
    categoryName,
    thickness: Number.isFinite(thickness) ? thickness : '',
    width: Number.isFinite(width) ? width : '',
    height: Number.isFinite(height) ? height : '',
    unPlateQuantity: Number.isFinite(quantity) ? quantity : '',
    num: Number.isFinite(quantity) ? quantity : '',
    area,
    createTime: toText(getCellValue(row, columnIndexMap.createTime)),
    sendDate: toText(getCellValue(row, columnIndexMap.sendDate)),
    productEdgingName: edging.text,
    productEdgingConfig: edging.config,
    processingRequirements: toText(getCellValue(row, columnIndexMap.processingRequirements)),
    specialCraft: toText(getCellValue(row, columnIndexMap.specialCraft)),
    remark: toText(getCellValue(row, columnIndexMap.remark)),
    validationStatus: validationMessages.length ? 'invalid' : 'valid',
    validationMessages,
    sourceRowIndexes: [rowIndex]
  } satisfies ParsedExcelRow
}

const mergeParsedRows = (rows: ParsedExcelRow[]) => {
  const rowMap = new Map<string, ParsedExcelRow>()

  rows.forEach((row) => {
    const mergeKey = [
      row.orderNumber,
      row.customerName,
      row.projectName,
      row.floorNumber,
      row.productName,
      row.glassName,
      row.selfCode,
      row.flowCardNumber,
      row.categoryName,
      row.thickness,
      row.width,
      row.height,
      row.productEdgingName,
      row.processingRequirements,
      row.specialCraft,
      row.remark,
      row.sendDate
    ].map(item => toText(item)).join('||')

    const currentRecord = rowMap.get(mergeKey)
    if (!currentRecord) {
      rowMap.set(mergeKey, {
        ...row
      })
      return
    }

    const nextQuantity = Number(currentRecord.unPlateQuantity || 0) + Number(row.unPlateQuantity || 0)
    currentRecord.unPlateQuantity = nextQuantity
    currentRecord.num = nextQuantity
    currentRecord.area = roundNumber(Number(currentRecord.area || 0) + Number(row.area || 0), 2)
    currentRecord.sourceRowIndexes = [...currentRecord.sourceRowIndexes, ...row.sourceRowIndexes]
  })

  return [...rowMap.values()]
}

const hasActualRowContent = (row: unknown[]) => {
  return row.some(cell => toText(cell))
}

const parseExcelPreview = (body: ExcelPreviewBody): ParsedExcelPreview => {
  if (!body.fileContent) {
    throw new Error('未接收到 Excel 文件内容')
  }

  const workbookBuffer = Buffer.from(body.fileContent, 'base64')
  const workbook = XLSX.read(workbookBuffer, {
    type: 'buffer',
    cellDates: true
  })
  const firstSheetName = workbook.SheetNames[0]
  if (!firstSheetName) {
    throw new Error('Excel 文件中没有可读取的工作表')
  }

  const worksheet = workbook.Sheets[firstSheetName]
  const sheetRows = XLSX.utils.sheet_to_json<(string | number)[]>(worksheet, {
    header: 1,
    raw: false,
    defval: ''
  })

  if (!sheetRows.length) {
    throw new Error('Excel 文件内容为空')
  }

  const [headerRow, ...dataRows] = sheetRows
  const columnIndexMap = getColumnIndexMap(headerRow)
  if (columnIndexMap.categoryName === null && columnIndexMap.spec === null && columnIndexMap.width === null) {
    throw new Error('未识别到可用的表头，请使用标准模板后重新导入')
  }

  const normalizedRows = dataRows
    .map((row, index) => ({
      row,
      rowIndex: index + 2
    }))
    .filter(item => hasActualRowContent(item.row))
    .map(item => normalizeExcelRow(item.row, item.rowIndex, columnIndexMap))

  const invalidRows = normalizedRows.filter(row => row.validationStatus === 'invalid')
  const validRows = normalizedRows.filter(row => row.validationStatus === 'valid')
  const mergedRows = body.mergeDuplicates === false ? validRows : mergeParsedRows(validRows)
  const totalQuantity = mergedRows.reduce((sum, row) => sum + Number(row.unPlateQuantity || 0), 0)
  const totalArea = roundNumber(mergedRows.reduce((sum, row) => sum + Number(row.area || 0), 0), 2)
  const categoryCount = new Set(mergedRows.map(row => toText(row.categoryName)).filter(Boolean)).size

  return {
    sheetName: firstSheetName,
    rows: mergedRows,
    invalidRows,
    summary: {
      totalRows: normalizedRows.length,
      validRows: validRows.length,
      invalidRows: invalidRows.length,
      mergedRows: Math.max(validRows.length - mergedRows.length, 0),
      categoryCount,
      totalQuantity,
      totalArea
    }
  }
}

const createTemplateWorkbookBuffer = () => {
  const worksheet = XLSX.utils.aoa_to_sheet([templateHeaders, ...templateRows])
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, '订单模板')
  return XLSX.write(workbook, {
    bookType: 'xlsx',
    type: 'buffer'
  })
}

const handleRouteError = (reply: FastifyReply, message = '读取本地订单 mock 数据失败') => {
  reply.code(500)
  return {
    code: 500,
    message
  }
}

export const registerOrderImportRoutes = async (app: FastifyInstance) => {
  app.get('/api/order-import/template', async (_request, reply) => {
    try {
      // 优先返回业务侧提供的真实模板文件，保证下载模板与解析口径保持一致。
      const buffer = await readFile(orderImportTemplatePath).catch(() => createTemplateWorkbookBuffer())
      reply
        .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('Content-Disposition', 'attachment; filename*=UTF-8\'\'%E9%9C%80%E5%88%87%E6%88%90%E5%93%81%E6%A8%A1%E6%9D%BF.xlsx')
      return buffer
    } catch {
      return handleRouteError(reply, '下载订单导入模板失败')
    }
  })

  app.post<{ Body: ExcelPreviewBody; }>('/api/order-import/upload-preview', async (request, reply) => {
    try {
      const preview = parseExcelPreview(request.body || {})
      return {
        code: 200,
        message: preview.summary.invalidRows
          ? `解析完成，已识别 ${ preview.summary.validRows } 条有效订单，另有 ${ preview.summary.invalidRows } 条需处理`
          : `解析完成，已识别 ${ preview.summary.validRows } 条有效订单`,
        data: preview
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '解析 Excel 文件失败'
      return handleRouteError(reply, errorMessage)
    }
  })

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
