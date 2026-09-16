import type { FastifyRequest } from 'fastify'
import { serverConfig } from '../config.js'
import { getSaasToken } from '../routes/saas.js'
import { type ChatMessage, extractTextContent } from '../types/chat.js'

type LayoutSpecPlateArea = {
  Ratio: number
  Width: number
  Height: number
  DuplicateMark: string
}

export type LayoutResult = {
  status: number
  data: {
    Ratio: number
    SpecPlateAreas: LayoutSpecPlateArea[]
    Origin: string
  }
  msg: string
}

type LayoutResolutionResult = {
  messages: ChatMessage[]
  toolCalls: string[]
  layout?: LayoutResult
}

export type LayoutParams = {
  task_id: string
  min_cutting_rate: number
  cutting_margin: number
  sheet_infos: Array<{
    id: number
    glass_type: number
    size: [number, number]
    num: number
    trimming_margin: [[number, number], [number, number]]
  }>
  glass_infos: Array<{
    id: number
    glass_type: number
    size: [number, number]
    num: number
    grinding_margin: [[number, number], [number, number]]
    new_glass: number
  }>
}

type SaasResult<T> = {
  code?: number
  message?: string
  data?: {
    list?: T[]
    records?: T[]
  }
}

type ImportProduct = {
  glassCategoryId?: number
  glassName?: string
  glassQuantity?: number
  height?: number
  mergdeList?: ImportProduct[]
  orderNumber?: string
  thickness?: number
  unPlateQuantity?: number
  width?: number
}

type InventorySheet = {
  categoryId?: number
  height?: number
  num?: number
  thickness?: number
  width?: number
}

type SheetCandidate = {
  width: number
  height: number
  quantity: number
}

type ProductGroup = {
  categoryId: number
  glassType: number
  name: string
  thickness: number
  products: Array<{
    height: number
    quantity: number
    width: number
  }>
}

const extractLastUserText = (messages: ChatMessage[]) => {
  const lastUserMessage = [...messages].reverse().find(message => message.role === 'user')
  return extractTextContent(lastUserMessage?.content ?? '')
}

const extractLayoutConversation = (messages: ChatMessage[]) => {
  return messages
    .filter(message => message.role === 'user')
    .map(message => extractTextContent(message.content))
    .filter(Boolean)
    .join('\n\n')
}

const hasLayoutKeyword = (userText: string) => /排版|套料|开料|裁切|利用率优化/.test(userText)

const extractOrderNumber = (text: string) => {
  const labeledMatch = text.match(/订单(?:号|编号)?\s*[：:=]?\s*([A-Z0-9][A-Z0-9_-]{2,})/i)
  if (labeledMatch?.[1]) return labeledMatch[1].toUpperCase()

  // 兼容“D260914005 这个订单”这类订单号在前的自然表达。
  const standaloneMatch = text.match(/(?:^|[^A-Z0-9_-])(D\d{6,}[A-Z0-9_-]*)(?=$|[^A-Z0-9_-])/i)
  return standaloneMatch?.[1]?.toUpperCase()
}

export const shouldGenerateLayout = async (messages: ChatMessage[]) => {
  const userText = extractLayoutConversation(messages)
  const lastUserText = extractLastUserText(messages)

  // 明确的“订单号 + 裁切意图”直接进入业务流程，避免依赖模型分类结果。
  if (extractOrderNumber(lastUserText) && hasLayoutKeyword(lastUserText)) return true

  try {
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
              '判断用户是否希望进行玻璃套料、开料、裁切或原片利用率优化。',
              '用户只提供订单号并要求自动排版或生成裁切方案时，也必须返回 true；系统会自行查询该订单的产品明细和匹配的原片库存。',
              '用户手工提供成品规格和原片库存并要求生成裁切方案时返回 true。',
              '单纯查询订单或库存、且没有排版或裁切诉求时返回 false。',
              '其他所有请求返回 false。',
              '只输出 true 或 false，不要输出其他内容。'
            ].join('\n')
          },
          {
            role: 'user',
            content: userText
          }
        ]
      }),
      signal: AbortSignal.timeout(30000)
    })

    if (!response.ok) return hasLayoutKeyword(userText)

    const data = await response.json()
    return data?.choices?.[0]?.message?.content?.trim().toLowerCase() === 'true'
  } catch {
    return hasLayoutKeyword(userText)
  }
}

const createLayoutSummary = (layout: LayoutResult) => {
  const plates = layout.data.SpecPlateAreas
  const plans = plates.map((plate, index) => {
    const count = plate.DuplicateMark.length
    return `- 方案 ${ index + 1 }：原片 ${ plate.Width }×${ plate.Height }，单片利用率 ${ (plate.Ratio * 100).toFixed(2) }%，使用数量 ${ count }`
  })

  return [
    '排版结果摘要：',
    `- 综合利用率：${ (layout.data.Ratio * 100).toFixed(2) }%`,
    `- 排版方案数：${ plates.length }`,
    ...plans
  ].join('\n')
}

const extractJsonObject = (text: string) => {
  const matched = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const rawText = matched?.[1] || text
  const startIndex = rawText.indexOf('{')
  const endIndex = rawText.lastIndexOf('}')

  if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) {
    throw new Error('模型未返回有效 JSON')
  }

  return JSON.parse(rawText.slice(startIndex, endIndex + 1))
}

type LayoutParamsResolution = {
  params: LayoutParams
  missing_fields: string[]
}

const assertLayoutParamsResolution = (params: any): LayoutParamsResolution => {
  if (!params || !params.params || !Array.isArray(params.missing_fields)) {
    throw new Error('模型生成的排版参数结构不完整')
  }

  const { params: layoutParams } = params
  if (!Array.isArray(layoutParams.sheet_infos) || !Array.isArray(layoutParams.glass_infos)) {
    throw new Error('模型生成的排版参数结构不完整')
  }

  return params as LayoutParamsResolution
}

const generateLayoutParamsByModel = async (userText: string) => {
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
            '你是玻璃套料排版接口参数提取器。',
            '请根据用户提供的信息输出严格 JSON，不要输出解释、Markdown 或代码块。',
            'JSON 必须匹配以下结构：',
            '{"params":{"task_id":"string","min_cutting_rate":0,"cutting_margin":0,"sheet_infos":[{"id":1,"glass_type":0,"size":[3660,2140],"num":327,"trimming_margin":[[0,0],[0,0]]}],"glass_infos":[{"id":1001,"glass_type":0,"size":[1100,1000],"num":135,"grinding_margin":[[0,0],[0,0]],"new_glass":0}]},"missing_fields":[]}',
            '必须确认：至少一项成品订单的规格和数量；至少一项原片库存的规格和库存；是否允许旋转。缺少任一项时，写入 missing_fields，并且 params 中不得虚构该字段。',
            '规格格式为宽×高时，size 按 [宽, 高] 输出；库存/数量转为 num；glass_type、new_glass、磨边、修边、最低切裁率、掰片距离可按默认值 0 输出；id 用递增整数；task_id 可用当前时间戳字符串。'
          ].join('\n')
        },
        {
          role: 'user',
          content: userText
        }
      ]
    }),
    signal: AbortSignal.timeout(600000)
  })

  if (!response.ok) {
    throw new Error(`排版参数解析模型请求失败：${ response.status }`)
  }

  const data = await response.json()
  const content = data?.choices?.[0]?.message?.content
  if (!content) {
    throw new Error('排版参数解析模型未返回内容')
  }

  return assertLayoutParamsResolution(extractJsonObject(content))
}

const getSaasRecords = <T>(result: SaasResult<T>) => result.data?.list || result.data?.records || []

const requestSaas = async <T>(token: string, path: string, body: Record<string, unknown>) => {
  const response = await fetch(`${ serverConfig.saasBaseUrl }${ path }`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': token
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  })
  const result = await response.json().catch(() => ({})) as SaasResult<T>
  if (!response.ok || result.code !== 200) {
    throw new Error(result.message || 'SaaS 服务请求失败')
  }
  return getSaasRecords(result)
}

const formatDate = (date: Date) => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${ year }-${ month }-${ day }`
}

const getOrderDateRange = (orderNumber: string) => {
  const matched = orderNumber.match(/^D(\d{2})(\d{2})(\d{2})/i)
  if (matched) {
    const orderDate = `20${ matched[1] }-${ matched[2] }-${ matched[3] }`
    const parsedDate = new Date(`${ orderDate }T00:00:00`)
    if (!Number.isNaN(parsedDate.getTime()) && formatDate(parsedDate) === orderDate) {
      return {
        createDateBegin: orderDate,
        createDateEnd: orderDate
      }
    }
  }

  const end = new Date()
  const begin = new Date(end)
  begin.setDate(begin.getDate() - 29)
  return {
    createDateBegin: formatDate(begin),
    createDateEnd: formatDate(end)
  }
}

const getOrderProducts = async (token: string, orderNumber: string) => {
  const records = await requestSaas<ImportProduct>(token, '/optimImport/importOrder', {
    orderNumber,
    ...getOrderDateRange(orderNumber),
    showSpec: true,
    optimPlanType: 0,
    pageParam: {
      pageNum: 1,
      pageSize: 500
    }
  })
  if (!records.length) {
    throw new Error(`订单 ${ orderNumber } 未返回可导入的产品记录`)
  }

  // mergdeList 子项可能只含尺寸与数量，需要继承父项的材质和订单字段。
  const products = records.flatMap(item => item.mergdeList?.length
    ? item.mergdeList.map(detail => ({
      ...item,
      ...detail,
      mergdeList: undefined
    }))
    : [item])
    .filter(item => !item.orderNumber || item.orderNumber === orderNumber)

  if (!products.length) {
    throw new Error(`订单 ${ orderNumber } 的 mergdeList 未返回当前订单的加工明细`)
  }
  return products
}

const groupOrderProducts = (products: ImportProduct[]) => {
  const grouped = new Map<string, ProductGroup>()

  products.forEach(product => {
    const categoryId = Number(product.glassCategoryId)
    const thickness = Number(product.thickness)
    const width = Number(product.width)
    const height = Number(product.height)
    const quantity = product.unPlateQuantity === undefined || product.unPlateQuantity === null
      ? Number(product.glassQuantity)
      : Number(product.unPlateQuantity)

    if (![categoryId, thickness, width, height, quantity].every(Number.isFinite) || quantity <= 0 || width <= 0 || height <= 0) return

    const key = `${ categoryId }:${ thickness }`
    let group = grouped.get(key)
    if (!group) {
      group = {
        categoryId,
        glassType: grouped.size + 1,
        name: product.glassName || String(categoryId),
        thickness,
        products: []
      }
      grouped.set(key, group)
    }

    const sameSize = group.products.find(item => item.width === width && item.height === height)
    if (sameSize) {
      sameSize.quantity += quantity
    } else {
      group.products.push({
        width,
        height,
        quantity
      })
    }
  })

  return [...grouped.values()]
}

const canFitAnyProduct = (sheet: InventorySheet, group: ProductGroup) => {
  const sheetWidth = Number(sheet.width)
  const sheetHeight = Number(sheet.height)
  return group.products.some(product => (
    (sheetWidth >= product.width && sheetHeight >= product.height)
    || (sheetWidth >= product.height && sheetHeight >= product.width)
  ))
}

const buildOrderLayoutParams = async (token: string, orderNumber: string) => {
  const products = await getOrderProducts(token, orderNumber)
  const groups = groupOrderProducts(products)
  if (!groups.length) {
    const missingFields = ['glassCategoryId', 'thickness', 'width', 'height']
      .filter(field => products.every((product) => {
        const value = product[field as keyof ImportProduct]
        return value === undefined || value === null
      }))
    const fieldMessage = missingFields.length ? `，缺少字段：${ missingFields.join('、') }` : ''
    throw new Error(`订单 ${ orderNumber } 已读取 ${ products.length } 条 mergdeList 明细，但没有数量大于 0 的有效加工规格${ fieldMessage }`)
  }

  const inventories = await Promise.all(groups.map(group => requestSaas<InventorySheet>(
    token,
    '/optimGlassInfo/otherList?pageNum=1&pageSize=200',
    {
      categoryId: group.categoryId,
      thickness: group.thickness,
      excludeZeroStock: 1
    }
  )))

  const sheetInfos: LayoutParams['sheet_infos'] = []
  const glassInfos: LayoutParams['glass_infos'] = []
  let sheetId = 1
  let glassId = 1001

  groups.forEach((group, groupIndex) => {
    const matchingSheets = inventories[groupIndex]
      .filter(sheet => Number(sheet.categoryId) === group.categoryId)
      .filter(sheet => Number(sheet.thickness) === group.thickness)
      .filter(sheet => Number(sheet.num) > 0 && Number(sheet.width) > 0 && Number(sheet.height) > 0)
      .filter(sheet => canFitAnyProduct(sheet, group))

    if (!matchingSheets.length) {
      throw new Error(`${ group.name } ${ group.thickness }mm 没有可容纳订单规格的原片库存`)
    }
    const unsupportedProduct = group.products.find(product => !matchingSheets.some(sheet => {
      const sheetWidth = Number(sheet.width)
      const sheetHeight = Number(sheet.height)
      return (sheetWidth >= product.width && sheetHeight >= product.height)
        || (sheetWidth >= product.height && sheetHeight >= product.width)
    }))
    if (unsupportedProduct) {
      throw new Error(`${ group.name } ${ group.thickness }mm 缺少可容纳 ${ unsupportedProduct.width }×${ unsupportedProduct.height } 的原片`)
    }

    const mergedSheets = new Map<string, SheetCandidate>()
    matchingSheets.forEach(sheet => {
      const width = Number(sheet.width)
      const height = Number(sheet.height)
      const key = `${ width }:${ height }`
      const current = mergedSheets.get(key)
      if (current) current.quantity += Number(sheet.num)
      else mergedSheets.set(key, {
        width,
        height,
        quantity: Number(sheet.num)
      })
    })

    const sortedSheets = [...mergedSheets.values()]
      .sort((left, right) => left.width * left.height - right.width * right.height)
    sortedSheets.forEach(sheet => {
      sheetInfos.push({
        id: sheetId++,
        glass_type: group.glassType,
        size: [sheet.width, sheet.height],
        num: sheet.quantity,
        trimming_margin: [[0, 0], [0, 0]]
      })
    })

    group.products.forEach(product => {
      glassInfos.push({
        id: glassId++,
        glass_type: group.glassType,
        size: [product.width, product.height],
        num: product.quantity,
        grinding_margin: [[0, 0], [0, 0]],
        new_glass: 0
      })
    })
  })

  return {
    params: {
      task_id: `order-${ orderNumber }-${ Date.now() }`,
      min_cutting_rate: 0,
      cutting_margin: 0,
      sheet_infos: sheetInfos,
      glass_infos: glassInfos
    } satisfies LayoutParams,
    summary: `订单 ${ orderNumber }：${ groups.length } 个材质/厚度分组，${ glassInfos.length } 种成品规格，筛选出 ${ sheetInfos.length } 种可用原片规格。`
  }
}

const requestLayout = async (params: LayoutParams) => {
  const response = await fetch('http://192.168.2.189:8088/layout/generate/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(60000)
  })

  if (!response.ok) {
    throw new Error(`排版接口请求失败：${ response.status }`)
  }

  return JSON.parse(await response.text()) as LayoutResult
}

export const resolveLayoutMessages = async (
  request: FastifyRequest,
  messages: ChatMessage[],
  isLayoutRequest: boolean,
  onProgress?: (message: string) => void
): Promise<LayoutResolutionResult> => {
  if (!isLayoutRequest) {
    return {
      messages,
      toolCalls: []
    }
  }

  const lastUserText = extractLastUserText(messages)
  const orderNumber = extractOrderNumber(lastUserText)
  // 订单自动排版只保留本轮指令，避免历史订单信息污染模型总结。
  const responseMessages: ChatMessage[] = orderNumber
    ? [{
      role: 'user',
      content: lastUserText
    }]
    : messages

  try {
    const userText = extractLayoutConversation(messages)
    let params: LayoutParams
    let sourceSummary = ''

    if (orderNumber) {
      const token = getSaasToken(request)
      if (!token) {
        return {
          messages: [
            ...responseMessages,
            {
              role: 'system',
              content: `用户希望为订单 ${ orderNumber } 自动生成裁切方案，但当前未登录 SaaS。请仅提示用户先在页面右上角登录 SaaS 后重试，不要提及其他订单，不要猜测订单或库存数据。`
            }
          ],
          toolCalls: ['layout-order-auth-required']
        }
      }

      onProgress?.(`正在同步订单 ${ orderNumber } 的成品与原片库存…`)
      const orderLayout = await buildOrderLayoutParams(token, orderNumber)
      params = orderLayout.params
      sourceSummary = orderLayout.summary
    } else {
      onProgress?.('正在整理订单规格与原片数据…')
      const resolution = await generateLayoutParamsByModel(userText)
      if (resolution.missing_fields.length) {
        return {
          messages: [
            ...messages,
            {
              role: 'system',
              content: [
                '用户希望进行玻璃套料排版，但参数不完整。',
                `缺少的信息：${ resolution.missing_fields.join('；') }。`,
                '请用简短、清晰的中文向用户逐项追问；不要猜测参数，不要声称已调用排版接口。'
              ].join('\n')
            }
          ],
          toolCalls: ['layout-generate-need-input']
        }
      }
      params = resolution.params
      params.sheet_infos.forEach(sheet => {
        sheet.glass_type = 0
      })
      params.glass_infos.forEach(glass => {
        glass.glass_type = 0
      })
    }

    onProgress?.('正在计算最优排版方案…')
    const layout = await requestLayout(params)
    return {
      layout,
      messages: [
        ...responseMessages,
        {
          role: 'system',
          content: [
            sourceSummary,
            '排版已完成，系统已根据排版接口的真实结果在聊天界面展示排版图，并提供图片导出功能。',
            '你只负责基于以下摘要，用 3～5 条简短、易懂的要点解释利用率、原片方案和废料优化建议。',
            '禁止输出、尝试生成或描述任何图片、SVG、Mermaid、ASCII 图、坐标点位、HTML 表格或原始 JSON。',
            '禁止声称无法生成图片，也不要提示用户查看你生成的图。',
            '如需提及图，请明确说明“系统生成的排版图已在下方展示”。',
            createLayoutSummary(layout)
          ].filter(Boolean).join('\n\n')
        }
      ],
      toolCalls: [orderNumber ? 'layout-generate-from-order' : 'layout-generate']
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : '未知错误'
    const orderContext = orderNumber ? `订单 ${ orderNumber }` : '本轮请求'
    return {
      messages: [
        ...responseMessages,
        {
          role: 'system',
          content: `${ orderContext } 的排版生成流程调用失败：${ errorMessage }。请只说明该错误和当前失败步骤，不要引用历史订单，不要补充未经工具返回的数据。`
        }
      ],
      toolCalls: ['layout-generate-error']
    }
  }
}
