import { serverConfig } from '../config.js'

type OrderImportImageBody = {
  fileName?: string
  fileContent?: string
  mimeType?: string
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

type ParsedOrderImportRow = OrderImportRecord & {
  rowIndex: number
  validationStatus: 'valid' | 'invalid'
  validationMessages: string[]
}

type OrderImportImageOcrLine = {
  text: string
  score: number
  box: number[][]
}

type OrderImportImageResult = {
  rows: OrderImportRecord[]
  invalidRows: ParsedOrderImportRow[]
  rawText: string
  normalizedText: string
  avgScore: number
  lines: OrderImportImageOcrLine[]
  missingFields: string[]
  warnings: string[]
}

type LocalOcrResponse = {
  rawText?: string
  lines?: OrderImportImageOcrLine[]
  avgScore?: number
}

type ParsedModelPayload = {
  orders?: any[]
  missingFields?: unknown[]
  warnings?: unknown[]
}

const LOCAL_OCR_BOOT_MESSAGE = '本地 OCR 服务未启动，请先安装依赖并运行 server\\ocr_service\\app.py'
const OCR_TABLE_HEADER_ALIAS_MAP = {
  productName: ['产品名称', '产品', '部件名称'],
  glassName: ['单片名称', '玻璃名称', '片名', '名称'],
  categoryName: ['品类', '玻璃品类', '材质', '类别'],
  width: ['宽', '宽度', '成品宽'],
  height: ['高', '高度', '成品高'],
  unPlateQuantity: ['数量', '片数', '需求数量'],
  thickness: ['厚度', '厚度mm', '厚度毫米'],
  orderNumber: ['订单编号', '订单号'],
  selfCode: ['自编号'],
  flowCardNumber: ['流程卡号'],
  rackNumber: ['架号'],
  projectName: ['项目名称', '项目'],
  customerName: ['客户名称', '客户'],
  floorNumber: ['楼层编号', '楼层'],
  processingRequirements: ['加工要求', '加工说明'],
  remark: ['备注'],
  specialCraft: ['特殊工艺', '特殊要求'],
  productEdgingName: ['磨边', '磨边等级', '磨边配置']
} as const

const toText = (value: unknown) => String(value ?? '').trim()

const normalizeHeaderText = (value: unknown) => {
  return toText(value)
    .replace(/[＊*]/g, '')
    .replace(/[\s_\-]/g, '')
    .replace(/[()（）]/g, '')
    .replace(/选填|必填/g, '')
    .replace(/毫米/gi, 'mm')
    .toLowerCase()
}

const roundNumber = (value: number, digits = 2) => {
  if (!Number.isFinite(value)) return 0
  const multiplier = 10 ** digits
  return Math.round(value * multiplier) / multiplier
}

const normalizeOcrText = (value: string) => {
  return value
    .replace(/\r/g, '\n')
    .replace(/[：﹕]/g, ':')
    .replace(/[，]/g, ',')
    .replace(/[；]/g, ';')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/[＊*]/g, 'x')
    .replace(/([0-9])\s*[xX×]\s*([0-9])/g, '$1×$2')
    .replace(/\bO(?=\d)|(?<=\d)O\b/g, '0')
    .replace(/\bI(?=\d)|(?<=\d)I\b/g, '1')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const parseNumberLike = (value: unknown) => {
  const normalizedValue = toText(value)
    .replace(/[，,]/g, '')
    .replace(/mm|毫米|片|pcs|㎡|m2/gi, '')
    .trim()
  if (!normalizedValue) return NaN
  return Number(normalizedValue)
}

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

  const segments = normalizedValue
    .split(/[|,，/]/)
    .map(item => item.trim())
    .filter(Boolean)

  if (segments.length > 1 && segments.every(item => Number.isFinite(Number(item)))) {
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

const getLineBounds = (line: OrderImportImageOcrLine) => {
  const points = Array.isArray(line.box) ? line.box : []
  const xs = points.map(item => Number(item?.[0] || 0))
  const ys = points.map(item => Number(item?.[1] || 0))
  const minX = xs.length ? Math.min(...xs) : 0
  const maxX = xs.length ? Math.max(...xs) : 0
  const minY = ys.length ? Math.min(...ys) : 0
  const maxY = ys.length ? Math.max(...ys) : 0

  return {
    minX,
    maxX,
    minY,
    maxY,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
    height: Math.max(maxY - minY, 0)
  }
}

const resolveTableHeaderField = (value: string) => {
  const normalizedValue = normalizeHeaderText(value)
  if (!normalizedValue) return ''

  const matchedEntry = Object.entries(OCR_TABLE_HEADER_ALIAS_MAP).find(([, aliases]) => {
    return aliases.some((alias) => {
      const normalizedAlias = normalizeHeaderText(alias)
      return normalizedValue.includes(normalizedAlias) || normalizedAlias.includes(normalizedValue)
    })
  })

  return matchedEntry?.[0] || ''
}

const groupOcrLinesByRow = (lines: OrderImportImageOcrLine[]) => {
  const sortedLines = [...lines]
    .filter(line => toText(line.text))
    .sort((left, right) => {
      const leftBounds = getLineBounds(left)
      const rightBounds = getLineBounds(right)
      return leftBounds.centerY - rightBounds.centerY || leftBounds.centerX - rightBounds.centerX
    })

  const groupedRows: OrderImportImageOcrLine[][] = []

  sortedLines.forEach((line) => {
    const lineBounds = getLineBounds(line)
    const currentRow = groupedRows[groupedRows.length - 1]
    if (!currentRow) {
      groupedRows.push([line])
      return
    }

    const currentCenters = currentRow.map(item => getLineBounds(item).centerY)
    const currentHeights = currentRow.map(item => getLineBounds(item).height).filter(Boolean)
    const rowCenterY = currentCenters.reduce((sum, item) => sum + item, 0) / currentCenters.length
    const avgHeight = currentHeights.length
      ? currentHeights.reduce((sum, item) => sum + item, 0) / currentHeights.length
      : lineBounds.height || 18
    const mergeTolerance = Math.max(14, avgHeight * 0.9)

    if (Math.abs(lineBounds.centerY - rowCenterY) <= mergeTolerance) {
      currentRow.push(line)
      currentRow.sort((left, right) => getLineBounds(left).centerX - getLineBounds(right).centerX)
      return
    }

    groupedRows.push([line])
  })

  return groupedRows
}

const parseTableRowsFromOcrLines = (lines: OrderImportImageOcrLine[]) => {
  const groupedRows = groupOcrLinesByRow(lines)
  const headerRowIndex = groupedRows.findIndex((row) => {
    const matchedFields = new Set(
      row.map(item => resolveTableHeaderField(item.text)).filter(Boolean)
    )
    return matchedFields.size >= 4
      && matchedFields.has('categoryName')
      && matchedFields.has('width')
      && matchedFields.has('height')
      && matchedFields.has('unPlateQuantity')
  })

  if (headerRowIndex < 0) return []

  const headerCells = groupedRows[headerRowIndex]
    .map((line) => {
      const field = resolveTableHeaderField(line.text)
      if (!field) return null
      return {
        field,
        centerX: getLineBounds(line).centerX
      }
    })
    .filter(Boolean) as Array<{ field: string; centerX: number; }>

  if (headerCells.length < 4) return []

  return groupedRows
    .slice(headerRowIndex + 1)
    .map((row) => {
      const mappedRecord = row.reduce<Record<string, string>>((accumulator, line) => {
        const cellText = toText(line.text)
        if (!cellText) return accumulator

        const lineBounds = getLineBounds(line)
        const closestHeader = [...headerCells]
          .sort((left, right) => Math.abs(left.centerX - lineBounds.centerX) - Math.abs(right.centerX - lineBounds.centerX))[0]

        if (!closestHeader) return accumulator
        accumulator[closestHeader.field] = accumulator[closestHeader.field]
          ? `${ accumulator[closestHeader.field] } ${ cellText }`
          : cellText
        return accumulator
      }, {})

      if (!Object.keys(mappedRecord).length) return null
      if (!toText(mappedRecord.categoryName) && !toText(mappedRecord.width) && !toText(mappedRecord.height)) {
        return null
      }

      return {
        productName: toText(mappedRecord.productName),
        glassName: toText(mappedRecord.glassName),
        categoryName: toText(mappedRecord.categoryName),
        width: toText(mappedRecord.width),
        height: toText(mappedRecord.height),
        unPlateQuantity: toText(mappedRecord.unPlateQuantity),
        thickness: toText(mappedRecord.thickness),
        orderNumber: toText(mappedRecord.orderNumber),
        selfCode: toText(mappedRecord.selfCode),
        flowCardNumber: toText(mappedRecord.flowCardNumber),
        rackNumber: toText(mappedRecord.rackNumber),
        projectName: toText(mappedRecord.projectName),
        customerName: toText(mappedRecord.customerName),
        floorNumber: toText(mappedRecord.floorNumber),
        processingRequirements: toText(mappedRecord.processingRequirements),
        specialCraft: toText(mappedRecord.specialCraft),
        remark: toText(mappedRecord.remark),
        productEdgingName: toText(mappedRecord.productEdgingName)
      }
    })
    .filter(Boolean)
}

const parseTableRowsFromNormalizedText = (normalizedText: string) => {
  const textLines = normalizedText
    .split(/\r?\n/)
    .map(item => item.trim())
    .filter(Boolean)

  const headerLineIndex = textLines.findIndex((line) => {
    const matchedFields = new Set(
      line
        .split(/\s+/)
        .map(item => resolveTableHeaderField(item))
        .filter(Boolean)
    )
    return matchedFields.has('categoryName')
      && matchedFields.has('width')
      && matchedFields.has('height')
      && matchedFields.has('unPlateQuantity')
      && matchedFields.has('thickness')
  })

  if (headerLineIndex < 0) return []

  const headerTokens = textLines[headerLineIndex]
    .split(/\s+/)
    .map(item => ({
      field: resolveTableHeaderField(item),
      raw: item
    }))
    .filter(item => item.field)

  const dataLine = textLines.slice(headerLineIndex + 1).find((line) => {
    const tokens = line.split(/\s+/).filter(Boolean)
    return tokens.length >= Math.min(headerTokens.length - 1, 4)
  })

  if (!dataLine || !headerTokens.length) return []

  const dataTokens = dataLine.split(/\s+/).filter(Boolean)
  const mappedRecord = headerTokens.reduce<Record<string, string>>((accumulator, headerItem, index) => {
    accumulator[headerItem.field] = dataTokens[index] || ''
    return accumulator
  }, {})

  const numericTokens = dataTokens.filter(item => Number.isFinite(parseNumberLike(item)))
  if (!mappedRecord.width && !mappedRecord.height && numericTokens.length >= 4) {
    const [width, height, quantity, thickness] = numericTokens.slice(-4)
    mappedRecord.width = width
    mappedRecord.height = height
    mappedRecord.unPlateQuantity = quantity
    mappedRecord.thickness = thickness
  }

  if (!mappedRecord.categoryName) {
    const numericStartIndex = dataTokens.findIndex(item => Number.isFinite(parseNumberLike(item)))
    if (numericStartIndex > 0) {
      mappedRecord.categoryName = dataTokens[numericStartIndex - 1] || ''
    }
  }

  if (!mappedRecord.glassName && dataTokens.length >= 2) {
    mappedRecord.glassName = dataTokens[1]
  }

  if (!mappedRecord.productName && dataTokens.length >= 1) {
    mappedRecord.productName = dataTokens[0]
  }

  if (!Object.values(mappedRecord).some(item => toText(item))) return []

  return [{
    productName: toText(mappedRecord.productName),
    glassName: toText(mappedRecord.glassName),
    categoryName: toText(mappedRecord.categoryName),
    width: toText(mappedRecord.width),
    height: toText(mappedRecord.height),
    unPlateQuantity: toText(mappedRecord.unPlateQuantity),
    thickness: toText(mappedRecord.thickness),
    orderNumber: toText(mappedRecord.orderNumber),
    selfCode: toText(mappedRecord.selfCode),
    flowCardNumber: toText(mappedRecord.flowCardNumber),
    rackNumber: toText(mappedRecord.rackNumber),
    projectName: toText(mappedRecord.projectName),
    customerName: toText(mappedRecord.customerName),
    floorNumber: toText(mappedRecord.floorNumber),
    processingRequirements: toText(mappedRecord.processingRequirements),
    specialCraft: toText(mappedRecord.specialCraft),
    remark: toText(mappedRecord.remark),
    productEdgingName: toText(mappedRecord.productEdgingName)
  }]
}

const extractJsonObject = (text: string) => {
  const matched = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const rawText = matched?.[1] || text
  const startIndex = rawText.indexOf('{')
  const endIndex = rawText.lastIndexOf('}')

  if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) {
    throw new Error('订单图片解析模型未返回有效 JSON')
  }

  return JSON.parse(rawText.slice(startIndex, endIndex + 1))
}

const requestLocalOcr = async (body: OrderImportImageBody) => {
  const ocrEndpoint = `${ serverConfig.localOcrBaseUrl.replace(/\/$/, '') }/ocr`

  let response: Response
  try {
    response = await fetch(ocrEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        file_name: body.fileName || '',
        file_content: body.fileContent || '',
        mime_type: body.mimeType || ''
      }),
      signal: AbortSignal.timeout(serverConfig.localOcrTimeout)
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : ''
    if (/fetch failed|ECONNREFUSED|timed out/i.test(errorMessage)) {
      throw new Error(LOCAL_OCR_BOOT_MESSAGE)
    }
    throw error
  }

  const result = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(result?.message || '本地 OCR 服务调用失败')
  }
  if (Number(result?.code || 0) !== 200) {
    throw new Error(result?.message || '本地 OCR 服务识别失败')
  }

  return (result?.data || {}) as LocalOcrResponse
}

const generateOrderRowsByModel = async (normalizedText: string) => {
  if (!serverConfig.newApiApiKey) {
    throw new Error('未配置 NEW_API_KEY，无法解析 OCR 文本')
  }

  const response = await fetch(`${ serverConfig.newApiBaseUrl }/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ serverConfig.newApiApiKey }`
    },
    body: JSON.stringify({
      model: serverConfig.newApiModel,
      stream: false,
      messages: [
        {
          role: 'system',
          content: [
            '你是玻璃订单图片文本解析器。',
            '现在只会收到 OCR 识别后的纯文本，请从中抽取可用于排版的订单字段，并输出严格 JSON。',
            '不要输出解释、Markdown、代码块或额外文字。',
            'JSON 必须匹配以下结构：',
            '{"orders":[{"productName":"","glassName":"","categoryName":"","thickness":8,"width":900,"height":1950,"unPlateQuantity":18,"orderNumber":"","customerName":"","projectName":"","floorNumber":"","selfCode":"","flowCardNumber":"","rackNumber":"","productEdgingName":"","processingRequirements":"","specialCraft":"","remark":""}],"missingFields":[],"warnings":[]}',
            '如果 OCR 文本中存在多条成品明细，请拆成多个 orders 项。',
            '只提取 OCR 文本中明确出现的信息，禁止虚构品类、厚度、宽高、数量。',
            '若某条记录缺少品类、厚度、宽、高、数量中的任何一项，请仍保留该记录，并在 missingFields 中写入“第N条-字段名”。',
            '宽高必须输出数字，数量输出到 unPlateQuantity，厚度输出数字毫米值。',
            'glassName 优先使用单片名称、玻璃名称、片名；没有就退回产品名称或品类+规格。',
            'productEdgingName 保留 OCR 文本中的原始磨边表达，如 0|0|0|0、四边磨边、精磨。',
            '若 OCR 文本存在歧义、字段冲突或疑似识别错误，请在 warnings 中简短说明。'
          ].join('\n')
        },
        {
          role: 'user',
          content: normalizedText
        }
      ]
    }),
    signal: AbortSignal.timeout(600000)
  })

  if (!response.ok) {
    throw new Error(`订单图片解析模型请求失败：${ response.status }`)
  }

  const data = await response.json()
  const content = data?.choices?.[0]?.message?.content
  if (!content) {
    throw new Error('订单图片解析模型未返回内容')
  }

  return extractJsonObject(content) as ParsedModelPayload
}

const normalizeParsedRows = (payload: ParsedModelPayload) => {
  const rawOrders = Array.isArray(payload.orders) ? payload.orders : []
  const rows: OrderImportRecord[] = []
  const invalidRows: ParsedOrderImportRow[] = []

  rawOrders.forEach((item, index) => {
    const specValue = parseSpecValue(item?.spec || item?.size || item?.glassName)
    const width = Number.isFinite(parseNumberLike(item?.width)) ? Number(parseNumberLike(item?.width)) : specValue?.width ?? NaN
    const height = Number.isFinite(parseNumberLike(item?.height)) ? Number(parseNumberLike(item?.height)) : specValue?.height ?? NaN
    const quantity = Number.isFinite(parseNumberLike(item?.unPlateQuantity ?? item?.quantity ?? item?.num))
      ? Number(parseNumberLike(item?.unPlateQuantity ?? item?.quantity ?? item?.num))
      : NaN
    const thickness = Number.isFinite(parseNumberLike(item?.thickness))
      ? Number(parseNumberLike(item?.thickness))
      : NaN
    const categoryName = toText(item?.categoryName || item?.glassType || item?.category)
    const productName = toText(item?.productName)
    const selfCode = toText(item?.selfCode)
    const flowCardNumber = toText(item?.flowCardNumber)
    const edging = parseEdgingConfig(item?.productEdgingName || item?.edging)
    const glassName = buildDisplayName({
      glassName: toText(item?.glassName || item?.pieceName || item?.name),
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

    const nextRow: ParsedOrderImportRow = {
      uniqueIndex: `IMG-${ String(index + 1).padStart(4, '0') }`,
      rowIndex: index + 1,
      orderNumber: toText(item?.orderNumber),
      customerName: toText(item?.customerName),
      projectName: toText(item?.projectName),
      floorNumber: toText(item?.floorNumber),
      productName,
      glassName,
      pieceName: glassName,
      selfCode,
      flowCardNumber,
      rackNumber: toText(item?.rackNumber),
      categoryName,
      thickness: Number.isFinite(thickness) ? thickness : '',
      width: Number.isFinite(width) ? width : '',
      height: Number.isFinite(height) ? height : '',
      unPlateQuantity: Number.isFinite(quantity) ? quantity : '',
      num: Number.isFinite(quantity) ? quantity : '',
      area: Number.isFinite(width) && Number.isFinite(height) && Number.isFinite(quantity)
        ? roundNumber((width * height * quantity) / 1000000, 2)
        : 0,
      productEdgingName: edging.text,
      productEdgingConfig: edging.config,
      processingRequirements: toText(item?.processingRequirements),
      specialCraft: toText(item?.specialCraft),
      remark: toText(item?.remark),
      validationStatus: validationMessages.length ? 'invalid' : 'valid',
      validationMessages
    }

    if (validationMessages.length) {
      invalidRows.push(nextRow)
      return
    }

    rows.push(nextRow)
  })

  return {
    rows,
    invalidRows
  }
}

export const parseOrderImageToRows = async (body: OrderImportImageBody): Promise<OrderImportImageResult> => {
  if (!toText(body.fileContent)) {
    throw new Error('未接收到订单图片内容')
  }

  const ocrResult = await requestLocalOcr(body)
  const lines = Array.isArray(ocrResult.lines) ? ocrResult.lines : []
  const rawText = toText(ocrResult.rawText || lines.map(item => toText(item.text)).filter(Boolean).join('\n'))
  if (!rawText) {
    throw new Error('未识别到有效订单内容，请重新上传清晰的订单图片')
  }

  const normalizedText = normalizeOcrText(rawText)
  const avgScore = Number(ocrResult.avgScore || 0)
  let modelPayload: ParsedModelPayload = {
    orders: [],
    missingFields: [],
    warnings: []
  }
  const warnings: string[] = []

  try {
    modelPayload = await generateOrderRowsByModel(normalizedText)
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : '订单图片解析模型调用失败')
  }

  const fallbackOrdersFromLines = parseTableRowsFromOcrLines(lines)
  const fallbackOrdersFromText = parseTableRowsFromNormalizedText(normalizedText)
  const normalizedModelResult = normalizeParsedRows(modelPayload)
  const normalizedFallbackResult = normalizeParsedRows({
    orders: fallbackOrdersFromLines.length ? fallbackOrdersFromLines : fallbackOrdersFromText,
    missingFields: [],
    warnings: []
  })
  const shouldUseFallback = !normalizedModelResult.rows.length && normalizedFallbackResult.rows.length > 0
  const rows = shouldUseFallback ? normalizedFallbackResult.rows : normalizedModelResult.rows
  const invalidRows = shouldUseFallback ? normalizedFallbackResult.invalidRows : normalizedModelResult.invalidRows

  warnings.push(
    ...(Array.isArray(modelPayload.warnings) ? modelPayload.warnings.map(item => toText(item)).filter(Boolean) : []),
    ...(shouldUseFallback ? ['当前结果由 OCR 表格兜底解析生成，建议复核关键规格字段'] : []),
    ...(avgScore > 0 && avgScore < 0.85 ? ['OCR 平均置信度偏低，建议人工复核关键规格字段'] : [])
  )

  return {
    rows,
    invalidRows,
    rawText,
    normalizedText,
    avgScore,
    lines,
    missingFields: shouldUseFallback
      ? []
      : Array.isArray(modelPayload.missingFields)
        ? modelPayload.missingFields.map(item => toText(item)).filter(Boolean)
        : [],
    warnings
  }
}
