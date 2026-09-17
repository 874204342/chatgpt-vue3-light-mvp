import path from 'node:path'
import { readFile } from 'node:fs/promises'
import type { FastifyRequest } from 'fastify'
import { serverConfig } from '../config.js'
import { type ChatMessage, extractTextContent } from '../types/chat.js'

type LayoutSpecPlateArea = {
  Ratio: number
  Width: number
  Height: number
  DuplicateMark: string
  ParentDuplicateMark?: string
  OriginalId?: number
  OriginalType?: number
  OriginalLabel?: string
  OriginalCategory?: string
  OriginalThickness?: number
  OriginalSpecification?: string
}

type LayoutResultData = {
  Ratio: number
  SpecPlateAreas: LayoutSpecPlateArea[]
  Origin: string
}

type LayoutSchemeDisplay = {
  key: string
  name: string
  description: string
  materialSummary: string
  score: number
  usedOffcutCount: number
  usedRawCount: number
  totalPlateCount: number
  isBest: boolean
  layout: LayoutResultData
}

export type LayoutResult = {
  status: number
  data: LayoutResultData
  msg: string
  schemeKey?: string
  schemeName?: string
  schemeDescription?: string
  bestSchemeKey?: string
  schemes?: LayoutSchemeDisplay[]
}

type LayoutResolutionResult = {
  messages: ChatMessage[]
  toolCalls: string[]
  layout?: LayoutResult
}

const LAYOUT_ANALYSIS_SYSTEM_PROMPT = [
  '当用户发起玻璃套料、开料或裁切分析时，请按以下业务规则回复。',
  '【执行流程要求】',
  '1. 先基于订单的品类、厚度、规格、数量和磨边要求，匹配本地库存中的可用余料与原片。',
  '2. 先组合多种候选方案，再分别调用排版接口进行真实试算，不能跳过库存筛选直接给出排版结论。',
  '3. 方案至少包含“余料优先”“余料+原片混用”“原片优先”三类；若某类方案不成立，要说明原因。',
  '4. 一个订单允许拆分为多种板材共同完成；品类匹配只看 category + thickness。',
  '5. 最终推荐方案时，优先兼顾余料消化、综合利用率、备料合理性与执行稳定性。',
  '',
  '【输出要求】',
  '请使用简洁、专业的中文进行回复，并严格拆成 4 个独立模块，不要写成长段落，也不要输出编号列表：',
  '1. 推荐方案：标题中写明“推荐方案 X”与方案名称，并明确给出综合利用率。',
  '2. 方案优势：用 2 条以内短句概括排版稳定性、订单适配度或执行效率。',
  '3. 风险预警：如存在库存不足、规格冲突、余料不适配或需要补料，单独说明并尽量给出“需求数量 / 可用库存”对比；若无明显风险，也要明确写“当前未发现明显执行风险”。',
  '4. 备选方案说明：概括其他候选方案的适用场景、未被优先推荐的原因，以及必要的执行建议。',
  '各模块标题请尽量使用“推荐方案 / 方案优势 / 风险预警 / 备选方案说明”这四类表述，方便前端进行模块化呈现。',
  '如果系统消息已经明确说明参数缺失、本地数据缺失或工具调用失败，请严格依据系统消息如实告知用户，不要补充未经验证的数据。'
].join('\n')

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

type RawInventoryRecord = {
  id?: string
  name?: string
  category?: string | null
  thickness?: number | string | null
  width?: number | string | null
  height?: number | string | null
  stockQuantity?: number | string | null
  location?: string | null
}

type OffcutInventoryRecord = {
  id?: string
  tagId?: string
  category?: string | null
  thickness?: number | string | null
  width?: number | string | null
  height?: number | string | null
  stockQuantity?: number | string | null
  location?: string | null
}

type MockInventoryFile<T> = {
  records?: T[]
}

type LayoutMaterialGroup = {
  glass_type: number
  category: string
  thickness: number
}

type LayoutParamsResolution = {
  params: LayoutParams
  material_groups: LayoutMaterialGroup[]
  missing_fields: string[]
}

type GroupDemandProfile = {
  group: LayoutMaterialGroup
  glassInfos: LayoutParams['glass_infos']
  totalArea: number
}

type InventorySheetCandidate = {
  source: 'offcut' | 'raw'
  recordId: string
  label: string
  location: string
  category: string
  thickness: number
  width: number
  height: number
  quantity: number
  glassType: number
}

type SchemeKind = 'offcut-first' | 'mix' | 'raw-first'

type LayoutSchemeCandidate = {
  name: string
  kind: SchemeKind
  description: string
  sheets: InventorySheetCandidate[]
  params: LayoutParams
  sheetMap: Map<number, InventorySheetCandidate>
}

type LayoutSchemeResult = {
  scheme: LayoutSchemeCandidate
  layout: LayoutResult
  score: number
  usedOffcutCount: number
  usedRawCount: number
  totalPlateCount: number
}

const rawInventoryPath = path.resolve(serverConfig.workspaceRoot, 'server', 'src', 'mockData', 'raw_inventory.json')
const offcutInventoryPath = path.resolve(serverConfig.workspaceRoot, 'server', 'src', 'mockData', 'offcut_inventory.json')

let rawInventoryCache: RawInventoryRecord[] | null = null
let offcutInventoryCache: OffcutInventoryRecord[] | null = null

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
const hasInventoryOrOrderKeyword = (userText: string) => {
  return /原片库存|余料库存|仓库库存|查询库存|查库存|库存多少|库存量|可用库存|原片仓|余料|边角料|库位|查询订单|查订单|订单信息|订单列表|订单情况|近.+订单/.test(userText)
}

const extractOrderNumber = (text: string) => {
  const labeledMatch = text.match(/订单(?:号|编号)?\s*[：:=]?\s*([A-Z0-9][A-Z0-9_-]{2,})/i)
  if (labeledMatch?.[1]) return labeledMatch[1].toUpperCase()

  const standaloneMatch = text.match(/(?:^|[^A-Z0-9_-])(D\d{6,}[A-Z0-9_-]*)(?=$|[^A-Z0-9_-])/i)
  return standaloneMatch?.[1]?.toUpperCase()
}

const hasStructuredLayoutPayload = (text: string) => {
  return /【成品订单】|规格：|数量：|品类：|厚度：|磨边：/m.test(text)
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

const withLayoutAnalysisPrompt = (messages: ChatMessage[]) => {
  return insertBeforeLastUserMessage(messages, {
    role: 'system',
    content: LAYOUT_ANALYSIS_SYSTEM_PROMPT
  })
}

const toPositiveNumber = (value: unknown) => {
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? num : 0
}

const toNormalizedText = (value: unknown) => String(value || '').trim()

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

export const shouldGenerateLayout = async (messages: ChatMessage[]) => {
  const userText = extractLayoutConversation(messages)
  const lastUserText = extractLastUserText(messages)

  if (hasInventoryOrOrderKeyword(lastUserText) && !hasLayoutKeyword(lastUserText)) {
    return false
  }

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
              '用户只提供订单号并要求自动排版或生成裁切方案时，也必须返回 true；后续流程会再判断本地是否存在对应业务数据。',
              '用户手工提供订单规格并要求系统先筛库存再给出排版方案时返回 true。',
              '单纯查询订单或库存、且没有排版或裁切诉求时返回 false。',
              '其他所有请求返回 false。',
              '只输出 true 或 false，不要输出其他内容。'
            ].join('\n')
          },
          {
            role: 'user',
            content: lastUserText || userText
          }
        ]
      }),
      signal: AbortSignal.timeout(30000)
    })

    if (!response.ok) return hasLayoutKeyword(lastUserText || userText)

    const data = await response.json()
    return data?.choices?.[0]?.message?.content?.trim().toLowerCase() === 'true'
  } catch {
    return hasLayoutKeyword(lastUserText || userText)
  }
}

const createLayoutSummary = (layout: LayoutResult, schemeName?: string) => {
  const plates = layout.data.SpecPlateAreas
  const plans = plates.map((plate, index) => {
    const count = Math.max(1, plate.DuplicateMark?.length || 1)
    return `- 原片方案 ${ index + 1 }：原片 ${ plate.Width }×${ plate.Height }，单片利用率 ${ (plate.Ratio * 100).toFixed(2) }%，使用数量 ${ count }`
  })

  return [
    schemeName ? `最佳排版方案：${ schemeName }` : '',
    '排版结果摘要：',
    `- 综合利用率：${ (layout.data.Ratio * 100).toFixed(2) }%`,
    `- 排版方案数：${ plates.length }`,
    ...plans
  ].filter(Boolean).join('\n')
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

const assertLayoutParamsResolution = (payload: any): LayoutParamsResolution => {
  if (!payload || !payload.params || !Array.isArray(payload.missing_fields) || !Array.isArray(payload.material_groups)) {
    throw new Error('模型生成的排版规划结构不完整')
  }

  const { params } = payload
  if (!Array.isArray(params.glass_infos)) {
    throw new Error('模型生成的订单规格结构不完整')
  }

  return payload as LayoutParamsResolution
}

const normalizeLayoutResolution = (resolution: LayoutParamsResolution): LayoutParamsResolution => {
  const normalizedGroups = resolution.material_groups
    .map((group, index) => ({
      glass_type: index + 1,
      category: toNormalizedText(group.category),
      thickness: toPositiveNumber(group.thickness)
    }))
    .filter(group => group.category && group.thickness > 0)

  if (!normalizedGroups.length) {
    throw new Error('未识别到有效的订单材质分组')
  }

  const groupTypeMap = new Map<number, number>()
  resolution.material_groups.forEach((group, index) => {
    groupTypeMap.set(Number(group.glass_type), index + 1)
  })

  const normalizedGlassInfos = resolution.params.glass_infos
    .map((glass, index) => {
      const width = toPositiveNumber(glass.size?.[0])
      const height = toPositiveNumber(glass.size?.[1])
      const num = Math.max(1, Math.round(toPositiveNumber(glass.num)))
      const mappedType = groupTypeMap.get(Number(glass.glass_type))

      if (!mappedType || width <= 0 || height <= 0) return null

      return {
        id: Number(glass.id) || index + 1,
        glass_type: mappedType,
        size: [width, height] as [number, number],
        num,
        grinding_margin: Array.isArray(glass.grinding_margin) && glass.grinding_margin.length === 2
          ? glass.grinding_margin
          : [[0, 0], [0, 0]],
        new_glass: Number(glass.new_glass) || 0
      }
    })
    .filter(Boolean) as LayoutParams['glass_infos']

  if (!normalizedGlassInfos.length) {
    throw new Error('未识别到有效的订单规格')
  }

  return {
    params: {
      task_id: resolution.params.task_id || `layout-plan-${ Date.now() }`,
      min_cutting_rate: Number(resolution.params.min_cutting_rate) || 0,
      cutting_margin: Number(resolution.params.cutting_margin) || 0,
      sheet_infos: [],
      glass_infos: normalizedGlassInfos
    },
    material_groups: normalizedGroups,
    missing_fields: Array.from(new Set(
      resolution.missing_fields
        .map(item => toNormalizedText(item))
        .filter(Boolean)
    ))
  }
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
            '你是玻璃套料排版规划参数提取器。',
            '请根据用户提供的信息输出严格 JSON，不要输出解释、Markdown 或代码块。',
            'JSON 必须匹配以下结构：',
            '{"params":{"task_id":"string","min_cutting_rate":0,"cutting_margin":0,"sheet_infos":[],"glass_infos":[{"id":1001,"glass_type":1,"size":[1100,1000],"num":135,"grinding_margin":[[0,0],[0,0]],"new_glass":0}]},"material_groups":[{"glass_type":1,"category":"白玻","thickness":8}],"missing_fields":[]}',
            '这里的 sheet_infos 必须始终返回空数组，因为原片和余料库存将由后端根据本地 mock 数据自动筛选。',
            '必须确认：至少一项成品订单的规格和数量；并且每个订单材质分组都要有 category 和 thickness。',
            '若缺少上述信息，写入 missing_fields，并且不要虚构 category、thickness、规格或数量。',
            '同一 category + thickness 的订单必须使用同一个 glass_type；不同分组使用不同 glass_type。',
            '规格格式为宽×高时，size 按 [宽, 高] 输出；数量转为 num；磨边、最低切裁率、掰片距离可按默认值 0 输出；id 用递增整数；task_id 可用当前时间戳字符串。'
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

  return normalizeLayoutResolution(assertLayoutParamsResolution(extractJsonObject(content)))
}

const getGroupDemandProfiles = (
  materialGroups: LayoutMaterialGroup[],
  glassInfos: LayoutParams['glass_infos']
) => {
  return materialGroups
    .map((group) => {
      const relatedGlassInfos = glassInfos.filter(item => item.glass_type === group.glass_type)
      const totalArea = relatedGlassInfos.reduce((sum, item) => {
        return sum + item.size[0] * item.size[1] * item.num
      }, 0)

      return {
        group,
        glassInfos: relatedGlassInfos,
        totalArea
      }
    })
    .filter(item => item.glassInfos.length)
}

const canFitPiece = (sheetWidth: number, sheetHeight: number, pieceWidth: number, pieceHeight: number) => {
  return (
    (sheetWidth >= pieceWidth && sheetHeight >= pieceHeight)
    || (sheetWidth >= pieceHeight && sheetHeight >= pieceWidth)
  )
}

const getPieceCapacity = (sheetWidth: number, sheetHeight: number, pieceWidth: number, pieceHeight: number) => {
  const direct = Math.floor(sheetWidth / pieceWidth) * Math.floor(sheetHeight / pieceHeight)
  const rotated = Math.floor(sheetWidth / pieceHeight) * Math.floor(sheetHeight / pieceWidth)
  return Math.max(direct, rotated)
}

const estimateSheetUtilityScore = (candidate: InventorySheetCandidate, profile: GroupDemandProfile) => {
  const sheetArea = candidate.width * candidate.height
  if (!sheetArea) return 0

  const bestRatio = profile.glassInfos.reduce((maxRatio, glass) => {
    const pieceWidth = glass.size[0]
    const pieceHeight = glass.size[1]
    const capacity = getPieceCapacity(candidate.width, candidate.height, pieceWidth, pieceHeight)
    if (!capacity) return maxRatio

    const usedArea = Math.min(capacity, glass.num) * pieceWidth * pieceHeight
    return Math.max(maxRatio, usedArea / sheetArea)
  }, 0)

  const areaPenalty = sheetArea / Math.max(profile.totalArea, sheetArea)
  return bestRatio * 100 - areaPenalty
}

const aggregateInventoryCandidates = (items: InventorySheetCandidate[]) => {
  const merged = new Map<string, InventorySheetCandidate>()

  items.forEach((item) => {
    const key = [
      item.source,
      item.glassType,
      item.width,
      item.height
    ].join(':')
    const current = merged.get(key)

    if (current) {
      current.quantity += item.quantity
      current.label = `${ current.label } / ${ item.label }`
      current.location = `${ current.location } / ${ item.location }`
      return
    }

    merged.set(key, {
      ...item
    })
  })

  return [...merged.values()]
}

const getInventoryCandidatesByGroup = async (profiles: GroupDemandProfile[]) => {
  const rawRecords = await getRawInventoryRecords()
  const offcutRecords = await getOffcutInventoryRecords()
  const groupCandidateMap = new Map<number, {
    raws: InventorySheetCandidate[]
    offcuts: InventorySheetCandidate[]
  }>()

  profiles.forEach((profile) => {
    const raws = aggregateInventoryCandidates(
      rawRecords
        .filter(record => toNormalizedText(record.category) === profile.group.category)
        .filter(record => toPositiveNumber(record.thickness) === profile.group.thickness)
        .map((record): InventorySheetCandidate | null => {
          const width = toPositiveNumber(record.width)
          const height = toPositiveNumber(record.height)
          const quantity = Math.max(1, Math.round(toPositiveNumber(record.stockQuantity)))
          if (!width || !height || !quantity) return null
          if (!profile.glassInfos.some(glass => canFitPiece(width, height, glass.size[0], glass.size[1]))) return null

          return {
            source: 'raw',
            recordId: toNormalizedText(record.id) || `${ profile.group.glass_type }-raw-${ width }-${ height }`,
            label: toNormalizedText(record.name) || `${ profile.group.category }原片${ width }×${ height }`,
            location: toNormalizedText(record.location) || '-',
            category: profile.group.category,
            thickness: profile.group.thickness,
            width,
            height,
            quantity,
            glassType: profile.group.glass_type
          }
        })
        .filter(Boolean) as InventorySheetCandidate[]
    ).sort((left, right) => {
      return estimateSheetUtilityScore(right, profile) - estimateSheetUtilityScore(left, profile)
    })

    const offcuts = aggregateInventoryCandidates(
      offcutRecords
        .filter(record => toNormalizedText(record.category) === profile.group.category)
        .filter(record => toPositiveNumber(record.thickness) === profile.group.thickness)
        .map((record): InventorySheetCandidate | null => {
          const width = toPositiveNumber(record.width)
          const height = toPositiveNumber(record.height)
          const quantity = Math.max(1, Math.round(toPositiveNumber(record.stockQuantity)))
          if (!width || !height || !quantity) return null
          if (!profile.glassInfos.some(glass => canFitPiece(width, height, glass.size[0], glass.size[1]))) return null

          return {
            source: 'offcut',
            recordId: toNormalizedText(record.id || record.tagId) || `${ profile.group.glass_type }-offcut-${ width }-${ height }`,
            label: toNormalizedText(record.tagId) || `${ profile.group.category }余料${ width }×${ height }`,
            location: toNormalizedText(record.location) || '-',
            category: profile.group.category,
            thickness: profile.group.thickness,
            width,
            height,
            quantity,
            glassType: profile.group.glass_type
          }
        })
        .filter(Boolean) as InventorySheetCandidate[]
    ).sort((left, right) => {
      return estimateSheetUtilityScore(right, profile) - estimateSheetUtilityScore(left, profile)
    })

    groupCandidateMap.set(profile.group.glass_type, {
      raws,
      offcuts
    })
  })

  return groupCandidateMap
}

const takeWithAreaTarget = (
  candidates: InventorySheetCandidate[],
  targetArea: number,
  hardLimit: number
) => {
  const selected: InventorySheetCandidate[] = []
  let currentArea = 0

  candidates.some((candidate) => {
    if (selected.length >= hardLimit) return true
    selected.push(candidate)
    currentArea += candidate.width * candidate.height * candidate.quantity
    return currentArea >= targetArea
  })

  return selected
}

const createSchemeSheets = (
  kind: SchemeKind,
  profiles: GroupDemandProfile[],
  groupCandidateMap: Map<number, {
    raws: InventorySheetCandidate[]
    offcuts: InventorySheetCandidate[]
  }>
) => {
  const sheets: InventorySheetCandidate[] = []

  profiles.forEach((profile) => {
    const candidates = groupCandidateMap.get(profile.group.glass_type)
    const raws = candidates?.raws || []
    const offcuts = candidates?.offcuts || []

    if (!raws.length && !offcuts.length) {
      throw new Error(`${ profile.group.category } ${ profile.group.thickness }mm 没有可用于排版的本地原片或余料库存`)
    }

    if (kind === 'offcut-first') {
      const targetArea = profile.totalArea * 1.15
      const selectedOffcuts = takeWithAreaTarget(offcuts, targetArea, 6)
      const selectedRaws = selectedOffcuts.reduce((sum, item) => sum + item.width * item.height * item.quantity, 0) >= targetArea
        ? []
        : raws.slice(0, Math.min(raws.length, 2))

      sheets.push(...(selectedOffcuts.length ? selectedOffcuts : raws.slice(0, 1)))
      sheets.push(...selectedRaws)
      return
    }

    if (kind === 'mix') {
      sheets.push(...offcuts.slice(0, Math.min(offcuts.length, 4)))
      sheets.push(...raws.slice(0, Math.min(raws.length, 2)))
      if (!offcuts.length && raws.length) {
        sheets.push(...raws.slice(2, Math.min(raws.length, 3)))
      }
      return
    }

    if (raws.length) {
      sheets.push(...raws.slice(0, Math.min(raws.length, 3)))
      return
    }

    sheets.push(...offcuts.slice(0, Math.min(offcuts.length, 3)))
  })

  return sheets
}

const buildLayoutParamsForScheme = (
  baseParams: LayoutParams,
  schemeName: string,
  sheets: InventorySheetCandidate[]
): LayoutSchemeCandidate => {
  const normalizedSheets = sheets.filter((item, index, array) => {
    return array.findIndex(candidate => (
      candidate.source === item.source
      && candidate.glassType === item.glassType
      && candidate.width === item.width
      && candidate.height === item.height
    )) === index
  })

  const sheetMap = new Map<number, InventorySheetCandidate>()
  const sheetInfos = normalizedSheets.map((sheet, index) => {
    const id = index + 1
    sheetMap.set(id, sheet)
    return {
      id,
      glass_type: sheet.glassType,
      size: [sheet.width, sheet.height] as [number, number],
      num: sheet.quantity,
      trimming_margin: [[0, 0], [0, 0]] as [[number, number], [number, number]]
    }
  })

  return {
    name: schemeName,
    kind: schemeName === '方案A：余料优先'
      ? 'offcut-first'
      : schemeName === '方案B：余料 + 原片混用'
        ? 'mix'
        : 'raw-first',
    description: schemeName === '方案A：余料优先'
      ? '优先消化本地余料，不足部分再少量补充原片。'
      : schemeName === '方案B：余料 + 原片混用'
        ? '同时保留可用余料与主力原片规格，兼顾利用率与执行稳定性。'
        : '优先使用标准原片规格，追求更稳定的批量执行效率。',
    sheets: normalizedSheets,
    params: {
      ...baseParams,
      task_id: `${ baseParams.task_id }-${ Date.now() }-${ schemeName }`,
      sheet_infos: sheetInfos
    },
    sheetMap
  }
}

const createSchemeCandidates = async (
  resolution: LayoutParamsResolution
) => {
  const profiles = getGroupDemandProfiles(resolution.material_groups, resolution.params.glass_infos)
  const groupCandidateMap = await getInventoryCandidatesByGroup(profiles)
  const schemes = [
    buildLayoutParamsForScheme(
      resolution.params,
      '方案A：余料优先',
      createSchemeSheets('offcut-first', profiles, groupCandidateMap)
    ),
    buildLayoutParamsForScheme(
      resolution.params,
      '方案B：余料 + 原片混用',
      createSchemeSheets('mix', profiles, groupCandidateMap)
    ),
    buildLayoutParamsForScheme(
      resolution.params,
      '方案C：原片优先',
      createSchemeSheets('raw-first', profiles, groupCandidateMap)
    )
  ]

  const uniqueSchemes = new Map<string, LayoutSchemeCandidate>()
  schemes.forEach((scheme) => {
    const key = scheme.sheets
      .map(item => `${ item.source }:${ item.glassType }:${ item.width }x${ item.height }:${ item.quantity }`)
      .sort()
      .join('|')
    if (!uniqueSchemes.has(key)) {
      uniqueSchemes.set(key, scheme)
    }
  })

  return [...uniqueSchemes.values()]
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

const countPlateUsage = (plate: LayoutSpecPlateArea) => {
  return Math.max(1, plate.DuplicateMark?.length || 1)
}

const scoreLayoutScheme = (result: LayoutSchemeCandidate, layout: LayoutResult): LayoutSchemeResult => {
  let usedOffcutCount = 0
  let usedRawCount = 0
  let totalPlateCount = 0

  layout.data.SpecPlateAreas.forEach((plate) => {
    const count = countPlateUsage(plate)
    totalPlateCount += count
    const source = typeof plate.OriginalId === 'number' ? result.sheetMap.get(plate.OriginalId) : null
    if (!source) return
    if (source.source === 'offcut') {
      usedOffcutCount += count
      return
    }
    usedRawCount += count
  })

  const kindBonus = result.kind === 'offcut-first'
    ? 8
    : result.kind === 'mix'
      ? 4
      : 0
  const score = layout.data.Ratio * 1000 + usedOffcutCount * 18 - usedRawCount * 3 + kindBonus

  return {
    scheme: result,
    layout,
    score,
    usedOffcutCount,
    usedRawCount,
    totalPlateCount
  }
}

const enrichLayoutPlateMeta = (layout: LayoutResult, scheme: LayoutSchemeCandidate) => {
  layout.data.SpecPlateAreas.forEach((plate) => {
    const source = typeof plate.OriginalId === 'number' ? scheme.sheetMap.get(plate.OriginalId) : null
    if (!source) return

    // 将真实原片业务信息回传给前端，避免标题退化为“原片1/原片2”。
    plate.OriginalLabel = source.label
    plate.OriginalCategory = source.category
    plate.OriginalThickness = source.thickness
    plate.OriginalSpecification = `${ source.width }×${ source.height }`
  })

  return layout
}

const buildSchemeResultKey = (scheme: LayoutSchemeCandidate) => {
  return `${ scheme.kind }-${ scheme.name }`
}

const toLayoutSchemeDisplay = (result: LayoutSchemeResult, bestSchemeKey: string): LayoutSchemeDisplay => {
  const key = buildSchemeResultKey(result.scheme)

  return {
    key,
    name: result.scheme.name,
    description: result.scheme.description,
    materialSummary: formatSchemeMaterialSummary(result.scheme),
    score: Number(result.score.toFixed(2)),
    usedOffcutCount: result.usedOffcutCount,
    usedRawCount: result.usedRawCount,
    totalPlateCount: result.totalPlateCount,
    isBest: key === bestSchemeKey,
    layout: result.layout.data
  }
}

const formatSchemeMaterialSummary = (scheme: LayoutSchemeCandidate) => {
  const offcutSpecs = scheme.sheets.filter(item => item.source === 'offcut')
  const rawSpecs = scheme.sheets.filter(item => item.source === 'raw')
  const offcutSummary = offcutSpecs.length
    ? `余料 ${ offcutSpecs.slice(0, 3).map(item => `${ item.width }×${ item.height }(${ item.quantity }张)`).join('、') }`
    : '未纳入余料'
  const rawSummary = rawSpecs.length
    ? `原片 ${ rawSpecs.slice(0, 3).map(item => `${ item.width }×${ item.height }(${ item.quantity }张)`).join('、') }`
    : '未纳入原片'

  return `${ offcutSummary }；${ rawSummary }`
}

const createSchemeComparisonSummary = (results: LayoutSchemeResult[]) => {
  const sortedResults = [...results].sort((left, right) => right.score - left.score)

  return [
    '多方案试排结果：',
    ...sortedResults.map((item, index) => {
      return [
        `- ${ item.scheme.name }${ index === 0 ? '（当前推荐）' : '' }`,
        `  候选料：${ formatSchemeMaterialSummary(item.scheme) }`,
        `  综合利用率：${ (item.layout.data.Ratio * 100).toFixed(2) }%`,
        `  实际用板：共 ${ item.totalPlateCount } 张，其中余料 ${ item.usedOffcutCount } 张，原片 ${ item.usedRawCount } 张`,
        `  方案特征：${ item.scheme.description }`
      ].join('\n')
    })
  ].join('\n')
}

const resolveSchemeLayouts = async (
  schemeCandidates: LayoutSchemeCandidate[],
  onProgress?: (message: string) => void
) => {
  const results: LayoutSchemeResult[] = []
  const errors: string[] = []

  for (const candidate of schemeCandidates) {
    try {
      onProgress?.(`正在试排${ candidate.name }…`)
      const layout = enrichLayoutPlateMeta(await requestLayout(candidate.params), candidate)
      results.push(scoreLayoutScheme(candidate, layout))
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误'
      errors.push(`${ candidate.name }：${ errorMessage }`)
    }
  }

  if (!results.length) {
    throw new Error(errors.join('；') || '候选方案均未排版成功')
  }

  return {
    best: [...results].sort((left, right) => right.score - left.score)[0],
    results,
    errors
  }
}

export const resolveLayoutMessages = async (
  _request: FastifyRequest,
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
  const shouldResolveByOrderNumber = Boolean(orderNumber && !hasStructuredLayoutPayload(lastUserText))
  const responseMessages: ChatMessage[] = shouldResolveByOrderNumber
    ? [{
      role: 'user',
      content: lastUserText
    }]
    : messages
  const layoutPromptMessages = withLayoutAnalysisPrompt(responseMessages)

  try {
    const userText = extractLayoutConversation(messages)

    if (shouldResolveByOrderNumber && orderNumber) {
      return {
        messages: [
          ...layoutPromptMessages,
          {
            role: 'system',
            content: [
              `用户希望为订单 ${ orderNumber } 自动生成裁切方案。`,
              '当前项目已停用 SaaS 订单接入，系统会优先读取本地 mock 订单数据。',
              `但目前没有订单 ${ orderNumber } 对应的本地 mock 数据，因此无法自动生成该订单的裁切方案。`,
              '请直接告知用户当前没有可用的本地订单数据；如需继续排版，请让用户直接提供成品规格、数量和材质要求。'
            ].join('\n')
          }
        ],
        toolCalls: ['layout-order-no-local-data']
      }
    }

    onProgress?.('正在整理订单规格与材质分组…')
    const resolution = await generateLayoutParamsByModel(userText)
    if (resolution.missing_fields.length) {
      return {
        messages: [
          ...withLayoutAnalysisPrompt(messages),
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

    onProgress?.('正在匹配本地原片与余料库存…')
    const schemeCandidates = await createSchemeCandidates(resolution)
    onProgress?.('正在生成候选方案并调用排版接口试算…')
    const schemeEvaluation = await resolveSchemeLayouts(schemeCandidates, onProgress)
    const schemeSummary = createSchemeComparisonSummary(schemeEvaluation.results)
    const failureSummary = schemeEvaluation.errors.length
      ? `未成功的候选方案：${ schemeEvaluation.errors.join('；') }`
      : ''
    const bestSchemeKey = buildSchemeResultKey(schemeEvaluation.best.scheme)
    const displaySchemes = schemeEvaluation.results
      .sort((left, right) => right.score - left.score)
      .map(item => toLayoutSchemeDisplay(item, bestSchemeKey))

    return {
      layout: {
        ...schemeEvaluation.best.layout,
        schemeKey: bestSchemeKey,
        schemeName: schemeEvaluation.best.scheme.name,
        schemeDescription: schemeEvaluation.best.scheme.description,
        bestSchemeKey,
        schemes: displaySchemes
      },
      messages: [
        ...layoutPromptMessages,
        {
          role: 'system',
          content: [
            '系统已基于本地原片与余料库存，先完成候选方案筛选，再对多种方案进行了真实排版试算。',
            '下方排版图卡片会默认选中综合评分最高的最佳方案，并支持切换查看其他已成功试排的候选方案。',
            '你只负责基于以下摘要生成最终说明，必须拆成“推荐方案 / 方案优势 / 风险预警 / 备选方案说明”4 个模块，每个模块单独成段，不要输出编号列表。',
            '推荐方案模块需突出综合利用率；风险预警模块若存在库存缺口，请明确写出需求数量与可用库存数量。',
            '禁止输出、尝试生成或描述任何图片、SVG、Mermaid、ASCII 图、坐标点位、HTML 表格或原始 JSON。',
            '如需提及图，请明确说明“系统已在下方展示多方案排版图，并默认选中最佳方案”。',
            schemeSummary,
            failureSummary,
            createLayoutSummary(schemeEvaluation.best.layout, schemeEvaluation.best.scheme.name)
          ].filter(Boolean).join('\n\n')
        }
      ],
      toolCalls: ['layout-generate-multi-scheme']
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : '未知错误'
    const orderContext = orderNumber ? `订单 ${ orderNumber }` : '本轮请求'
    return {
      messages: [
        ...layoutPromptMessages,
        {
          role: 'system',
          content: `${ orderContext } 的排版生成流程调用失败：${ errorMessage }。请只说明该错误和当前失败步骤，不要引用历史订单，不要补充未经工具返回的数据。`
        }
      ],
      toolCalls: ['layout-generate-error']
    }
  }
}
