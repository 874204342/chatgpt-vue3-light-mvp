type LayoutEdgingValue = string | {
  leftValue?: number | string
  rightValue?: number | string
  topValue?: number | string
  downValue?: number | string
}

export type LayoutPromptOrderItem = {
  name: string
  width: number | string
  height: number | string
  quantity: number | string
  glassType: string
  thickness?: number | string
  isNew?: boolean | string
  edging?: LayoutEdgingValue
  orderNumber?: string
  productName?: string
  selfCode?: string
  flowCardNumber?: string
  rackNumber?: string
  processingRequirements?: string
  specialCraft?: string
  remark?: string
  orderSpecId?: string | number
  uniqueIndex?: string
}

export type LayoutPromptStockItem = {
  name: string
  width: number | string
  height: number | string
  quantity: number | string
  glassType: string
  thickness?: number | string
  edging?: LayoutEdgingValue
}

export type LayoutPromptRequirements = {
  minCutRate?: string | number
  breakDistance?: string | number
  rotationAllowed?: boolean | string | number
  otherRequirements?: string
}

export type LayoutPromptPayload = {
  orders?: LayoutPromptOrderItem[]
  stocks?: LayoutPromptStockItem[]
  requirements?: LayoutPromptRequirements
}

export type CloudOptimizationOrderSourceItem = {
  mergdeList?: CloudOptimizationOrderSourceItem[]
  productName?: string
  glassName?: string
  pieceName?: string
  selfCode?: string
  flowCardNumber?: string
  rackNumber?: string
  width?: number | string
  height?: number | string
  unPlateQuantity?: number | string
  num?: number | string
  categoryName?: string
  glassCategory?: string
  thickness?: number | string
  productEdgingConfig?: LayoutEdgingValue
  productEdgingName?: string
  processingRequirements?: string
  specialCraft?: string
  remark?: string
  orderNumber?: string
  orderSpecId?: string | number
  uniqueIndex?: string
  inputMode?: number | string
}

export type CloudOptimizationGlassSourceItem = {
  glassName?: string
  name?: string
  width?: number | string
  height?: number | string
  quantity?: number | string
  num?: number | string
  stock?: number | string
  categoryName?: string
  glassCategory?: string
  thickness?: number | string
  glassTrimmingConfig?: LayoutEdgingValue
  glassTrimmingName?: string
}

export type CloudOptimizationStrategicConfig = {
  rotationAllowed?: boolean | string | number
  minCutRate?: string | number
  breakDistance?: string | number
  otherRequirements?: string
}

const DEFAULT_OTHER_REQUIREMENTS = '请尽量提高原片利用率，减少废料。'

const formatPrimitiveValue = (value: unknown, fallback = '0') => {
  if (value === null || value === undefined) return fallback
  const text = String(value).trim()
  return text || fallback
}

const formatOptionalText = (value: unknown) => String(value ?? '').trim()

const hasValidEdgingConfig = (value?: LayoutEdgingValue) => {
  if (!value || typeof value === 'string') return false
  return ['leftValue', 'rightValue', 'topValue', 'downValue'].every((key) => {
    const currentValue = value[key as keyof typeof value]
    return currentValue === '' || currentValue === undefined || Number.isFinite(Number(currentValue))
  })
}

const formatEdgingValue = (value?: LayoutEdgingValue) => {
  if (!value) return '0|0|0|0'
  if (typeof value === 'string') {
    const normalizedValue = value.trim()
    return normalizedValue || '0|0|0|0'
  }

  return [
    formatPrimitiveValue(value.leftValue),
    formatPrimitiveValue(value.rightValue),
    formatPrimitiveValue(value.topValue),
    formatPrimitiveValue(value.downValue)
  ].join('|')
}

const getSourceEdgingValue = (configValue?: LayoutEdgingValue, textValue?: string) => {
  if (hasValidEdgingConfig(configValue)) return formatEdgingValue(configValue)
  return formatEdgingValue(textValue)
}

const formatSpec = (width: number | string, height: number | string) => {
  return `${ formatPrimitiveValue(width) }×${ formatPrimitiveValue(height) }`
}

const formatIsNew = (value?: boolean | string) => {
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (typeof value === 'string') {
    const normalizedValue = value.trim()
    if (!normalizedValue) return '否'
    if (normalizedValue === 'true') return '是'
    if (normalizedValue === 'false') return '否'
    return normalizedValue
  }
  return '否'
}

const formatRotationAllowed = (value?: boolean | string | number) => {
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (typeof value === 'number') return value === 1 ? '是' : '否'
  if (typeof value === 'string') {
    const normalizedValue = value.trim()
    if (!normalizedValue) return '是'
    if (normalizedValue === '1' || normalizedValue.toLowerCase() === 'true') return '是'
    if (normalizedValue === '0' || normalizedValue.toLowerCase() === 'false') return '否'
    return normalizedValue
  }
  return '是'
}

const buildOrderBlock = (item: LayoutPromptOrderItem) => {
  return [
    `- 名称：${ formatPrimitiveValue(item.name, '-') }`,
    `  规格：${ formatSpec(item.width, item.height) }`,
    `  数量：${ formatPrimitiveValue(item.quantity) }片`,
    `  品类：${ formatPrimitiveValue(item.glassType, '-') }`,
    `  厚度：${ item.thickness === null || item.thickness === undefined || String(item.thickness).trim() === '' ? '-' : `${ String(item.thickness).trim() }mm` }`,
    `  是否新增：${ formatIsNew(item.isNew) }`,
    `  磨边：${ formatEdgingValue(item.edging) }`,
    formatOptionalText(item.orderNumber) ? `  订单编号：${ formatOptionalText(item.orderNumber) }` : '',
    formatOptionalText(item.productName) ? `  产品名称：${ formatOptionalText(item.productName) }` : '',
    formatOptionalText(item.selfCode) ? `  自编号：${ formatOptionalText(item.selfCode) }` : '',
    formatOptionalText(item.flowCardNumber) ? `  流程卡号：${ formatOptionalText(item.flowCardNumber) }` : '',
    formatOptionalText(item.rackNumber) ? `  架号：${ formatOptionalText(item.rackNumber) }` : '',
    formatOptionalText(item.processingRequirements) ? `  加工要求：${ formatOptionalText(item.processingRequirements) }` : '',
    formatOptionalText(item.specialCraft) ? `  特殊工艺：${ formatOptionalText(item.specialCraft) }` : '',
    formatOptionalText(item.remark) ? `  备注：${ formatOptionalText(item.remark) }` : ''
  ].filter(Boolean).join('\n')
}

const buildStockBlock = (item: LayoutPromptStockItem) => {
  return [
    `- 名称：${ formatPrimitiveValue(item.name, '-') }`,
    `  规格：${ formatSpec(item.width, item.height) }`,
    `  库存：${ formatPrimitiveValue(item.quantity) }片`,
    `  品类：${ formatPrimitiveValue(item.glassType, '-') }`,
    `  厚度：${ item.thickness === null || item.thickness === undefined || String(item.thickness).trim() === '' ? '-' : `${ String(item.thickness).trim() }mm` }`,
    `  修边：${ formatEdgingValue(item.edging) }`
  ].join('\n')
}

// 云优化“订单导入”会返回一层外层记录，真实单片数据通常挂在 mergdeList 中。
// 这里统一拍平，后续生成模板时只处理标准化后的单片明细。
export const flattenCloudOptimizationOrderItems = (
  rows: CloudOptimizationOrderSourceItem[] = []
) => {
  return rows.flatMap((row) => {
    if (Array.isArray(row.mergdeList) && row.mergdeList.length) {
      return row.mergdeList
    }
    return [row]
  })
}

export const mapCloudOptimizationOrderToLayoutPromptItem = (
  item: CloudOptimizationOrderSourceItem
): LayoutPromptOrderItem => {
  return {
    name: item.glassName || item.pieceName || item.productName || '',
    width: item.width ?? '',
    height: item.height ?? '',
    quantity: item.unPlateQuantity ?? item.num ?? '',
    glassType: item.categoryName || item.glassCategory || '',
    thickness: item.thickness,
    isNew: false,
    edging: getSourceEdgingValue(item.productEdgingConfig, item.productEdgingName),
    orderNumber: item.orderNumber || '',
    productName: item.productName || '',
    selfCode: item.selfCode || '',
    flowCardNumber: item.flowCardNumber || '',
    rackNumber: item.rackNumber || '',
    processingRequirements: item.processingRequirements || '',
    specialCraft: item.specialCraft || '',
    remark: item.remark || '',
    orderSpecId: item.orderSpecId,
    uniqueIndex: item.uniqueIndex || ''
  }
}

export const mapCloudOptimizationOrdersToLayoutPromptItems = (
  rows: CloudOptimizationOrderSourceItem[] = []
) => {
  return flattenCloudOptimizationOrderItems(rows).map(mapCloudOptimizationOrderToLayoutPromptItem)
}

export const mapCloudOptimizationGlassToLayoutPromptItem = (
  item: CloudOptimizationGlassSourceItem
): LayoutPromptStockItem => {
  return {
    name: item.name || item.glassName || '原片',
    width: item.width ?? '',
    height: item.height ?? '',
    quantity: item.quantity ?? item.num ?? item.stock ?? '',
    glassType: item.categoryName || item.glassCategory || '',
    thickness: item.thickness,
    edging: getSourceEdgingValue(item.glassTrimmingConfig, item.glassTrimmingName)
  }
}

export const mapCloudOptimizationGlassesToLayoutPromptItems = (
  rows: CloudOptimizationGlassSourceItem[] = []
) => {
  return rows.map(mapCloudOptimizationGlassToLayoutPromptItem)
}

export const mapStrategicConfigToLayoutPromptRequirements = (
  config: CloudOptimizationStrategicConfig = {}
): LayoutPromptRequirements => {
  return {
    minCutRate: config.minCutRate ?? '不限制',
    breakDistance: config.breakDistance ?? 0,
    rotationAllowed: config.rotationAllowed,
    otherRequirements: config.otherRequirements || DEFAULT_OTHER_REQUIREMENTS
  }
}

export const buildLayoutGenerateQuestionTemplate = ({
  orders = [],
  stocks = [],
  requirements = {}
}: LayoutPromptPayload = {}) => {
  const orderText = orders.length
    ? orders.map(buildOrderBlock).join('\n\n')
    : '暂未提供成品订单，请按以下规范补充待生产玻璃信息：\n- 名称：白玻1\n  规格：1100×1000\n  数量：135片\n  品类：白玻\n  厚度：8mm\n  是否新增：否\n  磨边：0|0|0|0'

  const stockText = stocks.length
    ? stocks.map(buildStockBlock).join('\n\n')
    : '请先结合本地原片库存与余料库存数据，按照成品订单的品类、厚度、规格进行初步筛选，优先判断可直接利用的余料，其次推荐适合的原片规格，并在进入正式排版前说明选料依据、备料建议与预估利用方向。'

  const minCutRate = requirements.minCutRate ?? '不限制'
  const breakDistance = requirements.breakDistance ?? 0
  const rotationAllowed = formatRotationAllowed(requirements.rotationAllowed)
  const otherRequirements = requirements.otherRequirements?.trim() || DEFAULT_OTHER_REQUIREMENTS

  // 输入框只保留用户可见的业务事实与约束条件，执行流程规则统一收敛到后端隐藏提示词中。
  return `请基于以下业务数据进行玻璃套料排版分析，并给出排版建议。

【成品订单】
${ orderText }

【库存匹配参考】
${ stockText }

【套版要求】
- 最低切裁率：${ minCutRate }
- 掰片距离：${ breakDistance }
- 是否允许旋转：${ rotationAllowed }
- 其他要求：${ otherRequirements }

请结合以上信息，给出推荐选料方向、排版建议和风险提示。`
}

export const layoutGenerateQuestionTemplate = buildLayoutGenerateQuestionTemplate({
  orders: [
    {
      name: '白玻1',
      width: 1100,
      height: 1000,
      quantity: 135,
      glassType: '白玻',
      isNew: false,
      edging: '0|0|0|0'
    },
    {
      name: '白玻2',
      width: 800,
      height: 950,
      quantity: 23,
      glassType: '白玻',
      isNew: false,
      edging: '0|0|0|0'
    }
  ],
  stocks: [
    {
      name: '原片1',
      width: 3660,
      height: 2140,
      quantity: 327,
      glassType: '白玻',
      edging: '0|0|0|0'
    },
    {
      name: '原片2',
      width: 3660,
      height: 2240,
      quantity: 300,
      glassType: '白玻',
      edging: '0|0|0|0'
    }
  ],
  requirements: {
    minCutRate: '不限制',
    breakDistance: 0,
    rotationAllowed: true,
    otherRequirements: DEFAULT_OTHER_REQUIREMENTS
  }
})

export const inventoryQuestionTemplate = '帮我查一下原片库存'
export const remainderQuestionTemplate = '帮我查一下余料库存'
export const orderQuestionTemplate = '帮我查一下近一个月的订单信息'
