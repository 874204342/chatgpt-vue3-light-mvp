/**
 * 玻璃套料排版业务工具模块。
 *
 * 职责：当用户发起“套料 / 开料 / 裁切 / 利用率优化”等排版诉求时，
 * 后端在这里完成「订单参数解析 → 本地库存匹配 → 候选方案构建 → 调排版接口试算 → 评分排序 → 摘要回传」的完整链路。
 *
 * 关键约定：
 * - 库存数据源为本地 mockData（原片 raw_inventory.json、余料 offcut_inventory.json），由后端直接读取并筛选，
 *   大模型不直接访问库存接口，只负责从用户文本中抽取订单规格与材质分组。
 * - 排版接口固定为外部的 layout/generate 服务，本模块负责把筛选后的原片/余料规格注入到 sheet_infos 再发起请求。
 * - 方案固定为三种：方案A 余料优先、方案B 原片优先、方案C 余料+原片混用。
 */
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import type { FastifyRequest } from 'fastify'
import { serverConfig } from '../config.js'
import { type ChatMessage, extractTextContent } from '../types/chat.js'

/**
 * 排版接口返回的「单张原片套版区域」元数据。
 * 每一项代表一块被实际用于切割的原片，以及其上排布的成品/废料信息。
 * 其中 Original* 系列字段为后端回填的本地业务信息，用于前端展示真实原片名称、品类等，避免退化为“原片1/原片2”。
 */
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

/** 排版接口返回的数据主体：综合利用率 + 多张原片套版区域列表。 */
type LayoutResultData = {
  Ratio: number
  SpecPlateAreas: LayoutSpecPlateArea[]
  Origin: string
}

/** 单条候选方案在前端展示所需的摘要字段。 */
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

/**
 * 最终回传给前端的排版结果。
 * 除接口原始 status/data/msg 外，追加了方案维度的元信息：
 * - schemeKey / schemeName / schemeDescription / bestSchemeKey：最佳方案标识与说明
 * - schemes：多套候选方案的前端展示数据，用于轮播切换查看
 */
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

/** resolveLayoutMessages 的返回结构：拼接后的消息、命中的工具调用标识、以及可选的排版结果。 */
type LayoutResolutionResult = {
  messages: ChatMessage[]
  toolCalls: string[]
  layout?: LayoutResult
}

/**
 * 排版分析的系统提示词，注入到对话中约束大模型的最终回复行为。
 * 它不负责做排版计算（计算由后端 + 外部排版接口完成），
 * 只规范大模型如何基于后端提供的摘要，输出「推荐方案 / 方案优势 / 风险预警 / 备选方案说明」四个模块化结论。
 */
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

/**
 * 外部排版接口的请求参数结构。
 * - sheet_infos：可供切割的「原片/余料」列表（由后端根据本地库存筛选后填充）。
 * - glass_infos：需要切割出的「成品玻璃」列表（由大模型从订单中抽取）。
 * 两者通过 glass_type 关联，保证同一品类+厚度在同一分组内匹配。
 */
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
  layout_result: null
}

/** 本地 mockData 中的原片库存记录结构（字段允许为空，读取后统一做归一化）。 */
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

/** 本地 mockData 中的余料库存记录结构。余料用 tagId 作为业务标识。 */
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

/** mock 库存文件的外层结构：records 数组承载实际数据。 */
type MockInventoryFile<T> = {
  records?: T[]
}

/** 订单材质分组：同一 category + thickness 归为一组，使用同一个 glass_type。 */
type LayoutMaterialGroup = {
  glass_type: number
  category: string
  thickness: number
}

/** 大模型抽取并归一化后的排版规划参数结果。 */
type LayoutParamsResolution = {
  params: LayoutParams
  material_groups: LayoutMaterialGroup[]
  missing_fields: string[]
  max_raw_spec_count?: number | string | null
}

/** 单个材质分组的需求画像：关联的成品玻璃列表 + 总需求面积，用于后续库存匹配。 */
type GroupDemandProfile = {
  group: LayoutMaterialGroup
  glassInfos: LayoutParams['glass_infos']
  totalArea: number
}

/**
 * 一条「可用于排版」的库存候选（原片或余料）的标准结构。
 * 无论来源是原片还是余料，都统一归一化成该结构，方便后续按同一套逻辑筛选与构建 sheet_infos。
 */
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

/** 候选方案类型：余料优先 / 混用 / 原片优先。 */
type SchemeKind = 'offcut-first' | 'mix' | 'raw-first'

/** 一套候选方案的完整描述：名称、策略、说明、筛选出的库存、以及据此生成的排版请求参数。 */
type LayoutSchemeCandidate = {
  name: string
  kind: SchemeKind
  description: string
  sheets: InventorySheetCandidate[]
  params: LayoutParams
  sheetMap: Map<number, InventorySheetCandidate>
  groupProfiles: GroupDemandProfile[]
}

/** 方案的静态定义：仅描述名称、策略与说明，具体库存筛选在运行时完成。 */
type LayoutSchemeDefinition = {
  name: string
  kind: SchemeKind
  description: string
}

/** 单套方案试排成功后的评分结果。 */
type LayoutSchemeResult = {
  scheme: LayoutSchemeCandidate
  layout: LayoutResult
  score: number
  usedOffcutCount: number
  usedRawCount: number
  totalPlateCount: number
}

/** 候选方案构建阶段的结果：成功构建的方案列表 + 各方案构建失败的错误信息。 */
type SchemeCandidateBuildResult = {
  schemes: LayoutSchemeCandidate[]
  errors: string[]
}

type LayoutFailureKind =
  | 'no-local-inventory'
  | 'layout-service-failed'
  | 'all-schemes-failed'
  | 'candidate-build-failed'
  | 'unknown'

// 方案字母、策略类型与说明文案统一在此维护，避免只调整顺序后出现 B/C 语义错位。
// 注意：这里的 name 顺序即最终执行顺序（方案A 余料优先 → 方案B 原片优先 → 方案C 混用）。
const LAYOUT_SCHEME_DEFINITIONS: LayoutSchemeDefinition[] = [
  {
    name: '方案A：余料优先',
    kind: 'offcut-first',
    description: '优先消化本地余料，不足部分再少量补充原片。'
  },
  {
    name: '方案B：原片优先',
    kind: 'raw-first',
    description: '优先使用标准原片规格，追求更稳定的批量执行效率。'
  },
  {
    name: '方案C：余料 + 原片混用',
    kind: 'mix',
    description: '同时保留可用余料与主力原片规格，兼顾利用率与执行稳定性。'
  }
]

// 原片 / 余料本地 mock 数据文件路径。库存筛选不经过 HTTP 接口，直接读这两份本地 JSON。
const rawInventoryPath = path.resolve(serverConfig.workspaceRoot, 'server', 'src', 'mockData', 'raw_inventory.json')
const offcutInventoryPath = path.resolve(serverConfig.workspaceRoot, 'server', 'src', 'mockData', 'offcut_inventory.json')

/** 取对话中「最后一条用户消息」的纯文本内容（倒序查找，跳过非 user 消息）。 */
const extractLastUserText = (messages: ChatMessage[]) => {
  const lastUserMessage = [...messages].reverse().find(message => message.role === 'user')
  return extractTextContent(lastUserMessage?.content ?? '')
}

/** 拼接对话中「所有用户消息」的纯文本，用于识别是否包含排版诉求、订单号等关键信息。 */
const extractLayoutConversation = (messages: ChatMessage[]) => {
  return messages
    .filter(message => message.role === 'user')
    .map(message => extractTextContent(message.content))
    .filter(Boolean)
    .join('\n\n')
}

/** 判断文本是否包含「排版/套料/开料/裁切/利用率优化」等排版诉求关键词。 */
const hasLayoutKeyword = (userText: string) => /排版|套料|开料|裁切|利用率优化/.test(userText)

/** 判断文本是否包含「库存/订单查询」类关键词，用于和纯排版诉求做区分。 */
const hasInventoryOrOrderKeyword = (userText: string) => {
  return /原片库存|余料库存|仓库库存|查询库存|查库存|库存多少|库存量|可用库存|原片仓|余料|边角料|库位|查询订单|查订单|订单信息|订单列表|订单情况|近.+订单/.test(userText)
}

/**
 * 从文本中提取订单号。
 * 优先匹配「订单号/订单编号：XXX」这种显式标注形式；
 * 若没有，再回退匹配「D 开头 + 6 位以上数字」的独立订单号格式（如 D20240901）。
 * 统一转大写返回，避免大小写导致后续比对不一致。
 */
const extractOrderNumber = (text: string) => {
  const labeledMatch = text.match(/订单(?:号|编号)?\s*[：:=]?\s*([A-Z0-9][A-Z0-9_-]{2,})/i)
  if (labeledMatch?.[1]) return labeledMatch[1].toUpperCase()

  const standaloneMatch = text.match(/(?:^|[^A-Z0-9_-])(D\d{6,}[A-Z0-9_-]*)(?=$|[^A-Z0-9_-])/i)
  return standaloneMatch?.[1]?.toUpperCase()
}

/**
 * 判断文本是否为「结构化订单导入」格式。
 * 前端导入订单时会把订单信息格式化成「【成品订单】+ 规格：/数量：/品类：/厚度：/磨边：」这类结构化文本，
 * 用这些标记区分「纯订单号查询」与「已带完整规格的结构化订单」。
 */
const hasStructuredLayoutPayload = (text: string) => {
  return /【成品订单】|规格：|数量：|品类：|厚度：|磨边：/m.test(text)
}

/**
 * 在「最后一条用户消息之前」插入一条系统消息。
 * 这样系统提示词会紧贴在用户最新输入之前，而不是被更早的历史消息冲淡。
 * 若无用户消息则直接追加到末尾。
 */
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

/** 把排版分析系统提示词注入到对话中（插到最后一条用户消息之前）。 */
const withLayoutAnalysisPrompt = (messages: ChatMessage[]) => {
  return insertBeforeLastUserMessage(messages, {
    role: 'system',
    content: LAYOUT_ANALYSIS_SYSTEM_PROMPT
  })
}

/** 将任意值转换为「严格大于 0 的数字」，无法转换或非正数时返回 0。用于统一清洗厚度/宽高/数量等字段。 */
const toPositiveNumber = (value: unknown) => {
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? num : 0
}

/**
 * 归一化「原片最多使用规格数」这一用户约束。
 * - null/undefined/空串/「不限制/不限/null/none」→ null（表示不限制）
 * - 其余情况尝试转为正整数；转换失败或非正数 → null
 */
const normalizeMaxRawSpecCount = (value: unknown) => {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  if (!text || /^(不限制|不限|null|none)$/iu.test(text)) return null

  const count = Math.floor(Number(text))
  return Number.isFinite(count) && count > 0 ? count : null
}

/** 将任意值转为去空白的字符串；空值统一返回空串。用于清洗品类/名称/库位等文本字段。 */
const toNormalizedText = (value: unknown) => String(value || '').trim()

/**
 * 统一输出排版链路调试日志，便于串联「候选构建 -> 接口请求 -> 接口返回」三段证据。
 * 这里只打印规格、数量、面积等业务摘要，避免日志过长。
 */
const logLayoutDebug = (stage: string, payload: Record<string, unknown>) => {
  console.log(`[layout-debug][${ stage }] ${ JSON.stringify(payload) }`)
}

/** 将候选板材压缩为便于排查的摘要结构。 */
const summarizeCandidateSheets = (items: InventorySheetCandidate[]) => {
  return items.map(item => ({
    source: item.source,
    specification: `${ item.width }x${ item.height }`,
    quantity: item.quantity,
    category: item.category,
    thickness: item.thickness
  }))
}

/** 将接口 sheet_infos 压缩为日志摘要，避免直接打印完整请求体。 */
const summarizeSheetInfosForDebug = (items: LayoutParams['sheet_infos']) => {
  return items.map(item => ({
    id: item.id,
    glass_type: item.glass_type,
    size: `${ item.size[0] }x${ item.size[1] }`,
    num: item.num
  }))
}

/** 将接口 glass_infos 压缩为日志摘要，便于核对订单需求是否与板材池匹配。 */
const summarizeGlassInfosForDebug = (items: LayoutParams['glass_infos']) => {
  return items.map(item => ({
    id: item.id,
    glass_type: item.glass_type,
    size: `${ item.size[0] }x${ item.size[1] }`,
    num: item.num
  }))
}

// 根据后端真实失败信息，向大模型提供更明确的失败类型，避免统一退化成模糊兜底话术。
const classifyLayoutFailure = (errorMessage: string): LayoutFailureKind => {
  if (errorMessage.includes('没有可用于排版的本地原片或余料库存')) {
    return 'no-local-inventory'
  }

  if (
    errorMessage.includes('排版接口请求失败')
    || errorMessage.includes('排版接口返回结果解析失败')
    || errorMessage.includes('排版接口未返回有效结果')
    || errorMessage.includes('排版接口业务失败')
    || errorMessage.includes('排版接口返回空数据')
    || errorMessage.includes('排版接口返回结构异常')
    || /fetch failed|aborterror|timeout/iu.test(errorMessage)
  ) {
    return 'layout-service-failed'
  }

  if (errorMessage.startsWith('候选方案全部试排失败：')) {
    return 'all-schemes-failed'
  }

  if (errorMessage.startsWith('未生成任何可试排的候选方案：')) {
    return 'candidate-build-failed'
  }

  return 'unknown'
}

const buildLayoutFailureSystemContent = (
  orderContext: string,
  errorMessage: string
) => {
  const failureKind = classifyLayoutFailure(errorMessage)

  if (failureKind === 'no-local-inventory') {
    return [
      `${ orderContext } 未匹配到可用于排版的本地库存：${ errorMessage }。`,
      '请明确告知用户：当前对应的“品类 + 厚度”在本地原片和余料库存中都没有可用板材，因此本轮无法进入真实试排。',
      '不要编造综合利用率、用板结构或推荐方案；可建议用户先补充/确认该品类厚度的本地库存，或调整订单材质后再发起排版。'
    ].join('\n')
  }

  if (failureKind === 'layout-service-failed') {
    return [
      `${ orderContext } 的排版服务调用失败：${ errorMessage }。`,
      '请明确告知用户：本轮问题出在排版服务未成功返回结果，而不是库存一定缺失。',
      '不要编造综合利用率、用板结构或推荐方案；可建议用户稍后重试，或先检查排版服务是否可用。'
    ].join('\n')
  }

  if (failureKind === 'all-schemes-failed') {
    return [
      `${ orderContext } 的候选方案全部试排失败：${ errorMessage }。`,
      '请明确告知用户：系统已经生成候选方案，但本轮没有任何方案成功完成真实试排。',
      '请保留失败摘要，不要编造最佳方案、综合利用率或用板结构。'
    ].join('\n')
  }

  if (failureKind === 'candidate-build-failed') {
    return [
      `${ orderContext } 未生成任何可试排的候选方案：${ errorMessage }。`,
      '请明确说明当前失败发生在候选方案构建阶段，原因可能是库存约束、原片规格数限制，或当前材质组合下无可用板材。',
      '不要编造综合利用率、用板结构或推荐方案。'
    ].join('\n')
  }

  return `${ orderContext } 的排版生成流程调用失败：${ errorMessage }。请只说明该错误和当前失败步骤，不要引用历史订单，不要补充未经工具返回的数据。`
}

/** 读取本地 mock JSON 文件并解析出 records 数组；文件格式异常时返回空数组兜底。 */
const loadMockRecords = async <T>(filePath: string): Promise<T[]> => {
  const content = await readFile(filePath, 'utf-8')
  const parsed = JSON.parse(content) as MockInventoryFile<T>
  return Array.isArray(parsed.records) ? parsed.records : []
}

/** 获取原片库存记录。mock 数据要求实时生效，因此这里不做进程内缓存。 */
const getRawInventoryRecords = async () => {
  return loadMockRecords<RawInventoryRecord>(rawInventoryPath)
}

/** 获取余料库存记录。mock 数据要求实时生效，因此这里不做进程内缓存。 */
const getOffcutInventoryRecords = async () => {
  return loadMockRecords<OffcutInventoryRecord>(offcutInventoryPath)
}

/**
 * 判断当前对话是否应该走「排版」流程。
 *
 * 判定策略（按优先级）：
 * 1. 若用户只是查库存/查订单、且没有排版诉求关键词 → 直接 false，交给库存/订单工具处理。
 * 2. 若同时出现订单号 + 排版关键词 → 直接 true。
 * 3. 其余情况调用一次轻量大模型做意图判定；模型不可用或请求失败时，
 *    回退到「是否包含排版关键词」这个本地兜底判断。
 */
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

/**
 * 生成排版结果的纯文本摘要，供大模型写入最终回复的「排版结果摘要」部分。
 * 逐张原片列出宽高与单片利用率；此处「使用数量」按 1 张计（数量口径由 countPlateUsage 统一控制）。
 */
const createLayoutSummary = (layout: LayoutResult, schemeName?: string) => {
  const plates = layout.data.SpecPlateAreas
  const plans = plates.map((plate, index) => {
    const count = 1
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

/**
 * 从大模型返回的文本中提取并解析 JSON 对象。
 * 先尝试剥离 markdown 代码块（```json ... ```），再从首尾大括号处截取 JSON 片段解析。
 * 找不到有效 JSON 时抛出异常。
 */
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

/**
 * 校验大模型返回的排版规划结构是否完整。
 * 仅做「字段存在性 + 数组类型」的粗校验，具体数值归一化交给 normalizeLayoutResolution 处理。
 * 结构不完整时抛出异常，避免后续按 undefined 取字段导致难以定位的运行时错误。
 */
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

/**
 * 归一化大模型解析结果，得到结构可靠、可被后续流程直接消费的排版参数。
 *
 * 主要动作：
 * 1. 材质分组重新编号：glass_type 按出现顺序重映射为 1..N，消除大模型自造的 id 不稳定问题。
 * 2. 清洗成品玻璃：宽高转正数、数量至少 1、磨边参数缺省补 0、glass_type 映射到新编号。
 * 3. sheet_infos 强制置空：原片/余料由后端从本地库存筛选后填充，不信任模型输出。
 * 4. 清洗 max_raw_spec_count 与 missing_fields（去重、去空白）。
 * 任一组/任一成品规格无效时抛出异常，由上层转为「参数缺失」提示。
 */
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
      glass_infos: normalizedGlassInfos,
      layout_result: null
    },
    material_groups: normalizedGroups,
    max_raw_spec_count: normalizeMaxRawSpecCount(resolution.max_raw_spec_count),
    missing_fields: Array.from(new Set(
      resolution.missing_fields
        .map(item => toNormalizedText(item))
        .filter(Boolean)
    ))
  }
}

/**
 * 调用大模型，从用户文本中抽取排版规划参数（成品玻璃规格、材质分组、约束等）。
 * 返回经 normalizeLayoutResolution 归一化后的结果。
 * 注意：这里要求模型把 sheet_infos 恒返回空数组，原片/余料由后端本地库存筛选，避免模型凭空捏造库存。
 */
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
            '{"params":{"task_id":"string","min_cutting_rate":0,"cutting_margin":0,"sheet_infos":[],"glass_infos":[{"id":1001,"glass_type":1,"size":[1100,1000],"num":135,"grinding_margin":[[0,0],[0,0]],"new_glass":0}]},"material_groups":[{"glass_type":1,"category":"白玻","thickness":8}],"missing_fields":[],"max_raw_spec_count":null}',
            '这里的 sheet_infos 必须始终返回空数组，因为原片和余料库存将由后端根据本地 mock 数据自动筛选。',
            '必须确认：至少一项成品订单的规格和数量；并且每个订单材质分组都要有 category 和 thickness。',
            '若缺少上述信息，写入 missing_fields，并且不要虚构 category、thickness、规格或数量。',
            '同一 category + thickness 的订单必须使用同一个 glass_type；不同分组使用不同 glass_type。',
            '规格格式为宽×高时，size 按 [宽, 高] 输出；数量转为 num；磨边、最低切裁率、掰片距离可按默认值 0 输出；id 用递增整数；task_id 可用当前时间戳字符串。',
            '如果用户明确给出“原片最多使用规格数”，提取为 max_raw_spec_count 的正整数；若未提及或写明“不限制”，返回 null。',
            '原片最多使用规格数不属于必填项，缺失时不要写入 missing_fields。'
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

/**
 * 将「材质分组 + 成品玻璃」整理成每个分组的需求画像。
 * 每个分组只保留 glass_type 匹配的成品玻璃，并计算该组总需求面积（宽×高×数量之和）。
 * 没有任何成品玻璃的分组会被过滤掉（属于无效分组）。
 */
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

/**
 * 判断一块板材（原片/余料）是否能放下某块成品玻璃。
 * 允许旋转：只要「正放」或「旋转 90°」任一方向能容纳即可。
 */
const canFitPiece = (sheetWidth: number, sheetHeight: number, pieceWidth: number, pieceHeight: number) => {
  return (
    (sheetWidth >= pieceWidth && sheetHeight >= pieceHeight)
    || (sheetWidth >= pieceHeight && sheetHeight >= pieceWidth)
  )
}

/**
 * 估算一块板材按「正放 / 旋转」两种方向最多能切出多少块指定成品（不考虑排样损耗，仅做整除上限估算）。
 * 用于快速评估板材对某成品的承载能力，作为利用率评分的输入。
 */
const getPieceCapacity = (sheetWidth: number, sheetHeight: number, pieceWidth: number, pieceHeight: number) => {
  const direct = Math.floor(sheetWidth / pieceWidth) * Math.floor(sheetHeight / pieceHeight)
  const rotated = Math.floor(sheetWidth / pieceHeight) * Math.floor(sheetHeight / pieceWidth)
  return Math.max(direct, rotated)
}

/**
 * 估算某块板材候选对某个需求分组的「利用率得分」，用于候选库存排序（分数越高越优先）。
 * 计算方式：
 * - 对分组内每块成品，用 getPieceCapacity 估算能切多少块，取其中有效利用率（有效面积/板材面积）的最大值作为 bestRatio。
 * - 再乘 100 放大后，减去一个面积惩罚项 areaPenalty（板材面积相对总需求越大，惩罚越大，避免选到过大板材浪费）。
 */
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

/**
 * 合并「同 source + glassType + 宽 + 高」的库存候选。
 * 由于同一规格可能有多条库存记录（不同库位/名称），这里把它们的数量相加、标签与库位拼接，
 * 避免同一规格在 sheet_infos 里出现多条重复条目，也便于后续按规格去重。
 */
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

/**
 * 按材质分组，从本地原片/余料库存中筛出「可用于排版」的候选，并按利用率得分降序排列。
 *
 * 筛选规则（对每个分组分别执行）：
 * - 品类 category 完全一致（归一化后比较）。
 * - 厚度 thickness 完全一致（转正数后比较）。
 * - 宽/高/数量有效（均为正数）。
 * - 至少要能放得下分组内「某一块」成品玻璃（canFitPiece）。
 * 原片与余料分别筛选、分别排序，最后按 glass_type 存入 Map 供各方案复用。
 */
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

    // 输出每个材质分组实际命中的候选库存数量，便于排查筛选链路是否符合预期。
    console.log(
      `[layout-debug] category=${ profile.group.category }, thickness=${ profile.group.thickness }mm, rawCandidates=${ raws.length }, offcutCandidates=${ offcuts.length }`
    )

    groupCandidateMap.set(profile.group.glass_type, {
      raws,
      offcuts
    })
  })

  return groupCandidateMap
}

/**
 * 按“目标面积”从已排序的候选库存中贪心截取，用于余料优先方案。
 *
 * 入参说明：
 * - candidates：已经按利用率（estimateSheetUtilityScore）从高到低排序的候选，
 *   排在越前的越值得优先采用，因此这里直接顺序遍历即可拿到“较优”组合。
 * - targetArea：期望覆盖的目标面积。调用方一般传“需求总面积 × 1.15”，
 *   即预留 15% 富余，避免余料刚好贴边导致排版试算时因利用率不足被淘汰。
 * - hardLimit：最多选取的规格条目数上限，防止一次把所有余料规格都塞进去，
 *   既控制候选方案规模，也避免过多余料混用造成切割复杂、执行不稳定。
 *
 * 返回：满足面积目标（或触及条目上限）后截取的候选列表。
 * 说明：这里返回的是“规格 + 数量”的组合，面积按 width × height × quantity 计算，
 *   即同规格多张余料会一次性计入总面积。
 */
const takeWithAreaTarget = (
  candidates: InventorySheetCandidate[],
  targetArea: number,
  hardLimit: number
) => {
  const selected: InventorySheetCandidate[] = []
  let currentArea = 0

  // 用 some 实现“提前终止”的遍历：回调返回 true 时立即结束循环。
  candidates.some((candidate) => {
    // 已选条目数达到上限，停止继续追加。
    if (selected.length >= hardLimit) return true

    selected.push(candidate)
    // 累加该候选的可用面积（规格面积 × 库存数量）。
    currentArea += candidate.width * candidate.height * candidate.quantity

    // 面积已经覆盖目标，提前停止；否则返回 false 继续取下一档候选。
    return currentArea >= targetArea
  })

  return selected
}

/**
 * 生成某个候选的「原片规格唯一键」。
 * 以 category:thickness:宽x高 作为去重维度，用于「原片最多使用规格数」的跨方案计数限制。
 */
const buildRawSpecKey = (candidate: InventorySheetCandidate) => {
  return `${ candidate.category }:${ candidate.thickness }:${ candidate.width }x${ candidate.height }`
}

/**
 * 在「原片最多使用规格数」约束下，从候选原片中选取最多 desiredCount 条。
 *
 * 与 takeWithAreaTarget 的差异：这里除了数量上限，还要遵守「已选规格种类数不超过 maxRawSpecCount」。
 * selectedRawSpecKeys 的作用域由调用方控制；当前实现按“单个材质分组”维度累计，
 * 保证前一个分组不会占用后一个分组的原片规格名额。
 */
const takeRawCandidatesWithLimit = (
  candidates: InventorySheetCandidate[],
  desiredCount: number,
  selectedRawSpecKeys: Set<string>,
  maxRawSpecCount: number | null
) => {
  const selected: InventorySheetCandidate[] = []

  candidates.some((candidate) => {
    if (selected.length >= desiredCount) return true

    const rawSpecKey = buildRawSpecKey(candidate)
    const alreadySelected = selectedRawSpecKeys.has(rawSpecKey)
    if (!alreadySelected && maxRawSpecCount !== null && selectedRawSpecKeys.size >= maxRawSpecCount) {
      return false
    }

    selected.push(candidate)
    selectedRawSpecKeys.add(rawSpecKey)
    return false
  })

  return selected
}

/**
 * 根据方案策略，为每个材质分组挑选具体的原片/余料候选，最终汇总为该方案的全部用板列表。
 *
 * 三种策略：
 * - offcut-first（余料优先）：先用 takeWithAreaTarget 按目标面积挑余料，不足时少量补原片。
 * - mix（混用）：先取前若干条余料，再补若干条原片。
 * - raw-first（原片优先）：优先选原片，仅在无原片可用时退回余料。
 * 每个分组若原片、余料都为空，会抛出异常说明「该品类+厚度无可用库存」。
 */
const createSchemeSheets = (
  kind: SchemeKind,
  profiles: GroupDemandProfile[],
  groupCandidateMap: Map<number, {
    raws: InventorySheetCandidate[]
    offcuts: InventorySheetCandidate[]
  }>,
  maxRawSpecCount: number | null
) => {
  const sheets: InventorySheetCandidate[] = []

  profiles.forEach((profile) => {
    const candidates = groupCandidateMap.get(profile.group.glass_type)
    const raws = candidates?.raws || []
    const offcuts = candidates?.offcuts || []
    // 原片规格数限制按“当前材质分组”单独生效，避免前序分组占用后续分组的规格名额。
    const selectedRawSpecKeys = new Set<string>()

    if (!raws.length && !offcuts.length) {
      throw new Error(`${ profile.group.category } ${ profile.group.thickness }mm 没有可用于排版的本地原片或余料库存`)
    }

    if (kind === 'offcut-first') {
      const targetArea = profile.totalArea * 1.15
      const selectedOffcuts = takeWithAreaTarget(offcuts, targetArea, 6)
      const selectedOffcutArea = selectedOffcuts.reduce((sum, item) => sum + item.width * item.height * item.quantity, 0)
      const desiredRawCount = selectedOffcuts.length
        ? (selectedOffcutArea >= targetArea ? 0 : Math.min(raws.length, 2))
        : Math.min(raws.length, 1)
      const selectedRaws = takeRawCandidatesWithLimit(
        raws,
        desiredRawCount,
        selectedRawSpecKeys,
        maxRawSpecCount
      )

      logLayoutDebug('scheme-offcut-first-selection', {
        category: profile.group.category,
        thickness: profile.group.thickness,
        glassType: profile.group.glass_type,
        targetArea,
        totalDemandArea: profile.totalArea,
        selectedOffcutArea,
        selectedOffcutCount: selectedOffcuts.length,
        desiredRawCount,
        selectedRawCount: selectedRaws.length,
        selectedOffcuts: summarizeCandidateSheets(selectedOffcuts),
        selectedRaws: summarizeCandidateSheets(selectedRaws)
      })

      if (!selectedOffcuts.length && !selectedRaws.length) {
        throw new Error(`${ profile.group.category } ${ profile.group.thickness }mm 在当前“原片最多使用规格数”限制下无法生成可用候选原片方案`)
      }

      sheets.push(...selectedOffcuts)
      sheets.push(...selectedRaws)
      return
    }

    if (kind === 'mix') {
      sheets.push(...offcuts.slice(0, Math.min(offcuts.length, 4)))
      const desiredRawCount = !offcuts.length && raws.length ? Math.min(raws.length, 3) : Math.min(raws.length, 2)
      const selectedRaws = takeRawCandidatesWithLimit(
        raws,
        desiredRawCount,
        selectedRawSpecKeys,
        maxRawSpecCount
      )

      sheets.push(...selectedRaws)
      if (!offcuts.length && raws.length && !selectedRaws.length) {
        throw new Error(`${ profile.group.category } ${ profile.group.thickness }mm 在当前“原片最多使用规格数”限制下无法生成混用方案`)
      }
      return
    }

    if (raws.length) {
      const selectedRaws = takeRawCandidatesWithLimit(
        raws,
        Math.min(raws.length, 3),
        selectedRawSpecKeys,
        maxRawSpecCount
      )
      if (!selectedRaws.length) {
        throw new Error(`${ profile.group.category } ${ profile.group.thickness }mm 在当前“原片最多使用规格数”限制下无法生成原片优先方案`)
      }

      sheets.push(...selectedRaws)
      return
    }

    sheets.push(...offcuts.slice(0, Math.min(offcuts.length, 3)))
  })

  return sheets
}

/**
 * 将一套方案的库存候选，组装成可直接调用排版接口的 LayoutSchemeCandidate。
 *
 * 步骤：
 * 1. 去重：按 source+glassType+宽+高 去掉重复规格（同规格多张只保留一条，数量已在聚合阶段累加）。
 * 2. 生成 sheet_infos：为每个规格分配递增 id，并建立 id → 候选 的 sheetMap，供排版结果回查真实业务信息。
 * 3. 生成独立 task_id：在基础 task_id 后追加时间戳与方案名，避免多方案请求互相覆盖。
 */
const buildLayoutParamsForScheme = (
  baseParams: LayoutParams,
  schemeDefinition: LayoutSchemeDefinition,
  sheets: InventorySheetCandidate[],
  groupProfiles: GroupDemandProfile[]
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
    name: schemeDefinition.name,
    kind: schemeDefinition.kind,
    description: schemeDefinition.description,
    sheets: normalizedSheets,
    params: {
      ...baseParams,
      task_id: `${ baseParams.task_id }-${ Date.now() }-${ schemeDefinition.name }`,
      sheet_infos: sheetInfos
    },
    sheetMap,
    groupProfiles
  }
}

/**
 * 构建所有候选方案。
 *
 * 遍历 LAYOUT_SCHEME_DEFINITIONS 逐个方案尝试：
 * - 单个方案构建失败（如某品类无库存）时，不中断整体，而是记录错误继续构建其他方案。
 * - 构建完成后按「用板组合」去重（多个方案可能选出相同的库存组合）。
 * 若最终没有任何可试排的方案，抛出汇总错误。
 */
const createSchemeCandidates = async (
  resolution: LayoutParamsResolution
): Promise<SchemeCandidateBuildResult> => {
  const profiles = getGroupDemandProfiles(resolution.material_groups, resolution.params.glass_infos)
  const groupCandidateMap = await getInventoryCandidatesByGroup(profiles)
  const maxRawSpecCount = normalizeMaxRawSpecCount(resolution.max_raw_spec_count)
  const schemes: LayoutSchemeCandidate[] = []
  const errors: string[] = []

  LAYOUT_SCHEME_DEFINITIONS.forEach((schemeDefinition) => {
    try {
      schemes.push(buildLayoutParamsForScheme(
        resolution.params,
        schemeDefinition,
        createSchemeSheets(schemeDefinition.kind, profiles, groupCandidateMap, maxRawSpecCount),
        profiles
      ))
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误'
      errors.push(`${ schemeDefinition.name }：${ errorMessage }`)
    }
  })

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

  const builtSchemes = [...uniqueSchemes.values()]
  if (!builtSchemes.length) {
    throw new Error(`未生成任何可试排的候选方案：${ errors.join('；') || '当前约束下未生成任何候选方案' }`)
  }

  return {
    schemes: builtSchemes,
    errors
  }
}

/**
 * 调用外部排版接口，传入一套方案的完整参数，返回排版结果。
 * 超时 60 秒；非 2xx 响应抛出异常，由上层捕获后记录为「该方案试排失败」。
 */
const requestLayout = async (
  params: LayoutParams,
  debugContext?: string
) => {
  logLayoutDebug('layout-request', {
    context: debugContext || params.task_id,
    taskId: params.task_id,
    minCuttingRate: params.min_cutting_rate,
    cuttingMargin: params.cutting_margin,
    sheetCount: params.sheet_infos.length,
    glassCount: params.glass_infos.length,
    sheets: summarizeSheetInfosForDebug(params.sheet_infos),
    glasses: summarizeGlassInfosForDebug(params.glass_infos)
  })

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

  const responseText = await response.text()
  try {
    const parsed = JSON.parse(responseText) as LayoutResult
    logLayoutDebug('layout-response', {
      context: debugContext || params.task_id,
      taskId: params.task_id,
      status: parsed?.status,
      msg: parsed?.msg,
      ratio: parsed?.data?.Ratio,
      specPlateAreaCount: Array.isArray(parsed?.data?.SpecPlateAreas) ? parsed.data.SpecPlateAreas.length : null
    })
    return parsed
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : '未知错误'
    throw new Error(`排版接口返回结果解析失败：${ errorMessage }`)
  }
}

/**
 * 校验排版接口返回体是否可用于后续流程。
 * 仅 HTTP 200 不代表业务成功，因此这里额外校验业务 status、data 以及 SpecPlateAreas。
 */
const assertLayoutResponse = (
  layout: LayoutResult | null | undefined,
  contextLabel: string
) => {
  if (!layout || typeof layout !== 'object') {
    throw new Error(`${ contextLabel }排版接口未返回有效结果`)
  }

  if (Number(layout.status) !== 200) {
    throw new Error(`${ contextLabel }${ layout.msg || `排版接口业务失败（status=${ String(layout.status || '-') }）` }`)
  }

  if (!layout.data) {
    throw new Error(`${ contextLabel }${ layout.msg || '排版接口返回空数据（data=null）' }`)
  }

  if (!Array.isArray(layout.data.SpecPlateAreas)) {
    throw new Error(`${ contextLabel }排版接口返回结构异常：缺少 SpecPlateAreas`)
  }

  return layout
}

/**
 * 从一套候选方案中，裁出某个「品类 + 厚度」分组的独立排版请求。
 * 这里显式只保留当前 glass_type 对应的成品与板材，避免不同厚度被混入同一次接口试排。
 */
const buildGroupLayoutParams = (
  scheme: LayoutSchemeCandidate,
  profile: GroupDemandProfile
) => {
  const groupGlassType = profile.group.glass_type
  const glassInfos = scheme.params.glass_infos.filter(item => item.glass_type === groupGlassType)
  const sheetInfos = scheme.params.sheet_infos.filter(item => item.glass_type === groupGlassType)

  if (!glassInfos.length) {
    throw new Error(`${ profile.group.category } ${ profile.group.thickness }mm 缺少可试排的成品规格`)
  }

  if (!sheetInfos.length) {
    throw new Error(`${ profile.group.category } ${ profile.group.thickness }mm 缺少可试排的原片或余料候选`)
  }

  return {
    ...scheme.params,
    task_id: `${ scheme.params.task_id }-group-${ groupGlassType }`,
    sheet_infos: sheetInfos,
    glass_infos: glassInfos,
    layout_result: null
  }
}

/**
 * 校验单个分组试排结果是否仍然命中了当前分组的板材。
 * 理论上独立请求后不会跨组，但这里再做一次硬校验，便于尽早暴露外部接口异常行为。
 */
const assertGroupLayoutMatchesProfile = (
  layout: LayoutResult,
  scheme: LayoutSchemeCandidate,
  profile: GroupDemandProfile
) => {
  const invalidPlate = layout.data.SpecPlateAreas.find((plate) => {
    if (typeof plate.OriginalId !== 'number') return false

    const source = scheme.sheetMap.get(plate.OriginalId)
    return Boolean(source && source.glassType !== profile.group.glass_type)
  })

  if (invalidPlate) {
    throw new Error(`${ profile.group.category } ${ profile.group.thickness }mm 试排结果命中了非当前分组板材`)
  }
}

/**
 * 将各材质分组的独立试排结果合并回同一个方案结果。
 * 综合利用率按「各原片有效面积 / 各原片总面积」重新计算，保证多分组汇总后口径稳定。
 */
const mergeGroupLayouts = (
  layouts: Array<{
    profile: GroupDemandProfile
    layout: LayoutResult
  }>
): LayoutResult => {
  const specPlateAreas = layouts.flatMap(({ profile, layout }, groupIndex) => {
    const groupPrefix = `${ profile.group.category }-${ profile.group.thickness }mm-${ groupIndex + 1 }`

    return layout.data.SpecPlateAreas.map((plate, plateIndex) => ({
      ...plate,
      DuplicateMark: plate.DuplicateMark
        ? `${ groupPrefix }-${ plate.DuplicateMark }`
        : `${ groupPrefix }-plate-${ plateIndex + 1 }`,
      ParentDuplicateMark: plate.ParentDuplicateMark
        ? `${ groupPrefix }-${ plate.ParentDuplicateMark }`
        : plate.ParentDuplicateMark
    }))
  })

  const totalPlateArea = specPlateAreas.reduce((sum, plate) => sum + plate.Width * plate.Height, 0)
  const usedPlateArea = specPlateAreas.reduce((sum, plate) => sum + plate.Width * plate.Height * plate.Ratio, 0)
  const origin = layouts
    .map(item => item.layout.data.Origin)
    .filter(Boolean)
    .join(' | ')
  const msg = layouts
    .map(item => item.layout.msg)
    .filter(Boolean)
    .join('；')

  return {
    status: layouts[0]?.layout.status ?? 0,
    msg: msg || '排版成功',
    data: {
      Ratio: totalPlateArea > 0 ? usedPlateArea / totalPlateArea : 0,
      SpecPlateAreas: specPlateAreas,
      Origin: origin || 'group-merged'
    }
  }
}

/**
 * 统计某块套版区域对应的「实际用板张数」。
 * 接口文档将 DuplicateMark 定义为“唯一标记”，无法再按字符串长度推导张数，
 * 因此统一按「每个 SpecPlateArea 代表 1 张实际用板」统计，避免数量口径失真。
 */
const countPlateUsage = () => {
  // 接口文档将 DuplicateMark 定义为“唯一标记”，不能再按字符串长度推导张数。
  // 当前先按每个 SpecPlateArea 代表 1 张实际用板统一统计，避免数量口径失真。
  return 1
}

/**
 * 生成候选方案的「已匹配库存」摘要（方案试排前用于展示命中了哪些候选规格）。
 * 余料、原片分别取前 3 条规格，标注库存张数。
 */
const formatCandidateMaterialSummary = (scheme: LayoutSchemeCandidate) => {
  const offcutSpecs = scheme.sheets.filter(item => item.source === 'offcut')
  const rawSpecs = scheme.sheets.filter(item => item.source === 'raw')
  const offcutSummary = offcutSpecs.length
    ? `余料 ${ offcutSpecs.slice(0, 3).map(item => `${ item.width }×${ item.height }(库存 ${ item.quantity }张)`).join('、') }`
    : '未纳入余料'
  const rawSummary = rawSpecs.length
    ? `原片 ${ rawSpecs.slice(0, 3).map(item => `${ item.width }×${ item.height }(库存 ${ item.quantity }张)`).join('、') }`
    : '未纳入原片'

  return `${ offcutSummary }；${ rawSummary }`
}

/**
 * 生成候选方案的「实际用料」摘要（方案试排成功后，按排版结果统计真实用到的原片/余料）。
 * 通过排版结果中的 OriginalId 反查 sheetMap，累计同规格实际用量。
 */
const formatActualMaterialSummary = (result: LayoutSchemeResult) => {
  const usageMap = new Map<string, {
    source: 'offcut' | 'raw'
    width: number
    height: number
    count: number
  }>()

  result.layout.data.SpecPlateAreas.forEach((plate) => {
    const source = typeof plate.OriginalId === 'number' ? result.scheme.sheetMap.get(plate.OriginalId) : null
    if (!source) return

    const key = `${ source.source }:${ source.width }:${ source.height }`
    const current = usageMap.get(key)
    if (current) {
      current.count += 1
      return
    }

    usageMap.set(key, {
      source: source.source,
      width: source.width,
      height: source.height,
      count: 1
    })
  })

  const usageList = [...usageMap.values()]
  const offcutSummary = usageList.filter(item => item.source === 'offcut')
  const rawSummary = usageList.filter(item => item.source === 'raw')
  const formatItems = (items: typeof usageList) => items.length
    ? items.map(item => `${ item.width }×${ item.height }(${ item.count }张)`).join('、')
    : ''

  return [
    offcutSummary.length ? `余料 ${ formatItems(offcutSummary) }` : '未使用余料',
    rawSummary.length ? `原片 ${ formatItems(rawSummary) }` : '未使用原片'
  ].join('；')
}

/**
 * 对一套试排成功的方案进行评分。
 *
 * 评分公式：score = 综合利用率 × 1000 + 余料用板数 × 18 - 原片用板数 × 3 + 策略加分。
 * 设计意图：
 * - 综合利用率是主导项（权重最大）。
 * - 余料用板越多得分越高（鼓励消化余料、降低成本）。
 * - 原片用板越多得分越低（原片需要额外采购/成本更高）。
 * - 策略加分：余料优先 +8、混用 +4、原片优先 +0，体现业务对余料消化的偏好。
 * 同时统计该方案的余料/原片/总用板张数，供前端展示与摘要输出。
 */
const scoreLayoutScheme = (result: LayoutSchemeCandidate, layout: LayoutResult): LayoutSchemeResult => {
  let usedOffcutCount = 0
  let usedRawCount = 0
  let totalPlateCount = 0

  layout.data.SpecPlateAreas.forEach((plate) => {
    const count = countPlateUsage()
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

/**
 * 给排版结果中的每块套版区域回填真实原片/余料业务信息。
 * 通过 OriginalId 反查 sheetMap，将原片名称、品类、厚度、规格写入 Original* 字段，
 * 使前端能显示真实原片信息，而不是退化成「原片1/原片2」这类无业务含义的标题。
 */
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

/** 生成方案的唯一键，用于前端标识与「是否为最佳方案」比对。 */
const buildSchemeResultKey = (scheme: LayoutSchemeCandidate) => {
  return `${ scheme.kind }-${ scheme.name }`
}

/** 将评分结果转换为前端可直接消费的方案展示结构。 */
const toLayoutSchemeDisplay = (result: LayoutSchemeResult, bestSchemeKey: string): LayoutSchemeDisplay => {
  const key = buildSchemeResultKey(result.scheme)

  return {
    key,
    name: result.scheme.name,
    description: result.scheme.description,
    materialSummary: formatActualMaterialSummary(result),
    score: Number(result.score.toFixed(2)),
    usedOffcutCount: result.usedOffcutCount,
    usedRawCount: result.usedRawCount,
    totalPlateCount: result.totalPlateCount,
    isBest: key === bestSchemeKey,
    layout: result.layout.data
  }
}

/**
 * 生成多方案试排结果的文本对比摘要，供大模型写入最终回复。
 * 按评分降序排列，每个方案列出：已匹配库存、实际用料、综合利用率、用板结构、方案特征。
 * 评分最高者标注「（当前推荐）」。
 */
const createSchemeComparisonSummary = (results: LayoutSchemeResult[]) => {
  const sortedResults = [...results].sort((left, right) => right.score - left.score)

  return [
    '多方案试排结果：',
    ...sortedResults.map((item, index) => {
      return [
        `- ${ item.scheme.name }${ index === 0 ? '（当前推荐）' : '' }`,
        `  已匹配库存：${ formatCandidateMaterialSummary(item.scheme) }`,
        `  实际用料：${ formatActualMaterialSummary(item) }`,
        `  综合利用率：${ (item.layout.data.Ratio * 100).toFixed(2) }%`,
        `  实际用板：共 ${ item.totalPlateCount } 张，其中余料 ${ item.usedOffcutCount } 张，原片 ${ item.usedRawCount } 张`,
        `  方案特征：${ item.scheme.description }`
      ].join('\n')
    })
  ].join('\n')
}

/**
 * 生成最佳方案的「关键库存匹配项」摘要。
 * 突出方案命中的候选库存、实际用料与用板结构，供大模型在「推荐方案 / 方案优势」模块中引用。
 */
const createBestSchemeInventoryMatchSummary = (result: LayoutSchemeResult) => {
  return [
    '最佳方案命中的关键库存匹配项：',
    `- 方案名称：${ result.scheme.name }`,
    `- 候选库存：${ formatCandidateMaterialSummary(result.scheme) }`,
    `- 实际用料：${ formatActualMaterialSummary(result) }`,
    `- 用板结构：余料 ${ result.usedOffcutCount } 张，原片 ${ result.usedRawCount } 张，共 ${ result.totalPlateCount } 张`
  ].join('\n')
}

/**
 * 对一组候选方案逐个调用排版接口试排，并收集成功/失败结果。
 *
 * - 每个候选独立 try/catch，单方案失败不中断其余方案。
 * - 试排成功后先用 enrichLayoutPlateMeta 回填业务信息，再 scoreLayoutScheme 评分。
 * - 若所有方案都失败，抛出汇总错误。
 * 返回评分最高的 best 方案、完整结果列表、以及失败方案错误信息。
 */
const resolveSchemeLayouts = async (
  schemeCandidates: LayoutSchemeCandidate[],
  onProgress?: (message: string) => void
) => {
  const results: LayoutSchemeResult[] = []
  const errors: string[] = []

  for (const candidate of schemeCandidates) {
    try {
      const groupLayouts: Array<{
        profile: GroupDemandProfile
        layout: LayoutResult
      }> = []

      for (const profile of candidate.groupProfiles) {
        const groupLabel = `${ profile.group.category } ${ profile.group.thickness }mm`
        onProgress?.(`正在试排${ candidate.name }（${ groupLabel }）…`)

        const contextLabel = `${ candidate.name }（${ groupLabel }）：`
        const groupParams = buildGroupLayoutParams(candidate, profile)
        const layout = enrichLayoutPlateMeta(
          assertLayoutResponse(
            await requestLayout(groupParams, contextLabel),
            contextLabel
          ),
          candidate
        )

        assertGroupLayoutMatchesProfile(layout, candidate, profile)
        groupLayouts.push({
          profile,
          layout
        })
      }

      results.push(scoreLayoutScheme(candidate, mergeGroupLayouts(groupLayouts)))
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误'
      logLayoutDebug('scheme-layout-failed', {
        schemeName: candidate.name,
        errorMessage
      })
      errors.push(`${ candidate.name }：${ errorMessage }`)
    }
  }

  if (!results.length) {
    throw new Error(`候选方案全部试排失败：${ errors.join('；') || '未获取到成功试排结果' }`)
  }

  return {
    best: [...results].sort((left, right) => right.score - left.score)[0],
    results,
    errors
  }
}

/**
 * 排版主流程入口。当 shouldGenerateLayout 判定为排版请求时，由 chat 路由调用。
 *
 * 完整链路：
 * 1. 非排版请求直接原样返回（不注入任何排版提示词）。
 * 2. 识别订单号：若仅给了订单号但无结构化订单规格（纯订单号查询），
 *    当前项目已停用 SaaS 订单接入，直接提示无本地订单数据，不再走参数抽取。
 * 3. 调大模型抽取订单规格与材质分组；参数缺失时返回「追问」提示。
 * 4. 匹配本地原片/余料库存，构建候选方案，逐个调用排版接口试算并评分。
 * 5. 汇总最佳方案 + 多方案对比摘要，注入系统提示词让大模型输出 4 模块结论。
 * 任一步骤失败都会被 catch 捕获，返回带具体错误信息的「排版失败」提示。
 */
export const resolveLayoutMessages = async (
  _request: FastifyRequest,
  messages: ChatMessage[],
  isLayoutRequest: boolean,
  onProgress?: (message: string) => void
): Promise<LayoutResolutionResult> => {
  // 非排版请求：不干预消息，也不触发任何工具调用。
  if (!isLayoutRequest) {
    return {
      messages,
      toolCalls: []
    }
  }

  const lastUserText = extractLastUserText(messages)
  const orderNumber = extractOrderNumber(lastUserText)
  // 仅当「有订单号」且「不是结构化订单（未带完整规格）」时，才走「纯订单号查询」分支。
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

    // 纯订单号查询：项目已停用 SaaS 订单接入，本地也无对应 mock 数据，直接提示用户改为手工提供规格。
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
    // 若用户给出了「原片最多使用规格数」约束，生成一句话说明，随最终摘要一起回传给大模型。
    const rawSpecLimitSummary = resolution.max_raw_spec_count
      ? `用户约束：原片最多使用 ${ resolution.max_raw_spec_count } 种规格，候选方案筛选时已按该上限控制原片规格数。`
      : ''
    // 参数不完整：返回追问提示，让大模型逐项询问缺失信息，不猜测、不声称已调用排版接口。
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
    const schemeCandidateBuildResult = await createSchemeCandidates(resolution)
    onProgress?.('正在生成候选方案并调用排版接口试算…')
    const schemeEvaluation = await resolveSchemeLayouts(schemeCandidateBuildResult.schemes, onProgress)
    const schemeSummary = createSchemeComparisonSummary(schemeEvaluation.results)
    // 汇总「方案构建阶段 + 试排阶段」的全部失败信息，用于最终回复的风险提示。
    const schemeErrors = [
      ...schemeCandidateBuildResult.errors,
      ...schemeEvaluation.errors
    ]
    const failureSummary = schemeErrors.length
      ? `未成功的候选方案：${ schemeErrors.join('；') }`
      : ''
    const bestSchemeKey = buildSchemeResultKey(schemeEvaluation.best.scheme)
    const displaySchemes = schemeEvaluation.results
      .sort((left, right) => right.score - left.score)
      .map(item => toLayoutSchemeDisplay(item, bestSchemeKey))

    return {
      // 把最佳方案信息与多方案列表一起回传给前端，前端据此渲染排版图卡片与方案切换。
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
            '推荐方案或方案优势模块中，必须明确写出本轮命中的关键库存匹配项，包括优先采用的余料规格、补充使用的原片规格及大致数量结构。',
            '推荐方案模块需突出综合利用率；风险预警模块若存在库存缺口，请明确写出需求数量与可用库存数量。',
            '禁止输出、尝试生成或描述任何图片、SVG、Mermaid、ASCII 图、坐标点位、HTML 表格或原始 JSON。',
            '如需提及图，请明确说明“系统已在下方展示多方案排版图，并默认选中最佳方案”。',
            rawSpecLimitSummary,
            schemeSummary,
            failureSummary,
            createBestSchemeInventoryMatchSummary(schemeEvaluation.best),
            createLayoutSummary(schemeEvaluation.best.layout, schemeEvaluation.best.scheme.name)
          ].filter(Boolean).join('\n\n')
        }
      ],
      toolCalls: ['layout-generate-multi-scheme']
    }
  } catch (error) {
    // 任意一步失败统一在此兜底：返回带具体错误与失败步骤的提示，避免把内部堆栈/历史订单信息泄露给用户。
    const errorMessage = error instanceof Error ? error.message : '未知错误'
    const orderContext = orderNumber ? `订单 ${ orderNumber }` : '本轮请求'
    return {
      messages: [
        ...layoutPromptMessages,
        {
          role: 'system',
          content: buildLayoutFailureSystemContent(orderContext, errorMessage)
        }
      ],
      toolCalls: ['layout-generate-error']
    }
  }
}
