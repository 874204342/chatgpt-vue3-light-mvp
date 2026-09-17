type OrderImportParams = Record<string, unknown>

export type OrderImportRow = {
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
  mergdeList?: OrderImportRow[]
}

export type OrderImportExcelPreview = {
  sheetName: string
  rows: OrderImportRow[]
  invalidRows: Array<OrderImportRow & {
    rowIndex: number
    validationMessages: string[]
  }>
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

const createOrderImportRequest = async (path: string, body: OrderImportParams) => {
  const response = await fetch(`${ location.origin }/local-ai${ path }`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body || {})
  })

  const result = await response.json().catch(() => ({}))
  if (!response.ok && !result?.message) {
    throw new Error(`请求失败 (${ response.status })`)
  }
  return result
}

export const getOrderImportCategorySummary = (body: OrderImportParams) => {
  return createOrderImportRequest('/api/order-import/category-summary', body)
}

export const getOrderImportList = (body: OrderImportParams) => {
  return createOrderImportRequest('/api/order-import/list', body)
}

export const uploadOrderImportExcelPreview = (body: {
  fileName: string
  fileContent: string
  mergeDuplicates?: boolean
}) => {
  return createOrderImportRequest('/api/order-import/upload-preview', body)
}

export const downloadOrderImportTemplate = async () => {
  const response = await fetch(`${ location.origin }/local-ai/api/order-import/template`, {
    method: 'GET',
    credentials: 'include'
  })

  if (!response.ok) {
    throw new Error(`模板下载失败 (${ response.status })`)
  }

  const blob = await response.blob()
  const contentDisposition = response.headers.get('Content-Disposition') || ''
  const utf8NameMatch = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i)
  const filename = utf8NameMatch?.[1] ? decodeURIComponent(utf8NameMatch[1]) : '需切成品模板.xlsx'
  const blobUrl = window.URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = blobUrl
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  window.URL.revokeObjectURL(blobUrl)
}
