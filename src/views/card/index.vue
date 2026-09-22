<script setup lang="ts">
import { jsPDF as JsPDF } from 'jspdf'
import { computed, nextTick, onMounted, ref, watch } from 'vue'

import IconifyIcon from '@/components/IconifyIcon/index.vue'
import mockLayoutResult from '@/data/layout_result'

// ===== 与后端 layout_result.json 结构对应的类型 =====
interface Point {
  X: number
  Y: number
}

interface StraightLine {
  Start: Point
  End: Point
}

interface PolygonLine {
  Type: number
  StraightLine: StraightLine | null
  ArcLine: unknown | null
}

interface PolygonPel {
  Lines: PolygonLine[]
}

interface Pel {
  Type: number
  Width: number
  Height: number
  WasteFlg: number
  GlassId: number
  GlassType: number
  DisplayName?: string
  Position: Point
  PolygonPel: PolygonPel
}

interface SpecPlateArea {
  Ratio: number
  Width: number
  Height: number
  DuplicateMark: string
  ParentDuplicateMark: string
  OriginalId: number
  OriginalType: number
  OriginalSource?: 'raw' | 'offcut'
  OriginalLabel?: string
  OriginalCategory?: string
  OriginalThickness?: number
  OriginalSpecification?: string
  PelList: Pel[]
}

interface LayoutResultData {
  Ratio: number
  SpecPlateAreas: SpecPlateArea[]
  Origin: string
}

export interface LayoutSchemeDisplay {
  key: string
  name: string
  description: string
  // 后端已统一为“本次试排的实际用料汇总”，不再展示候选库存池数量。
  materialSummary: string
  estimatedRawMaterialCost?: number
  score: number
  usedOffcutCount: number
  usedRawCount: number
  totalPlateCount: number
  isBest: boolean
  layout: LayoutResultData
}

export interface LayoutResult {
  status: number
  data: LayoutResultData
  msg: string
  schemeKey?: string
  schemeName?: string
  schemeDescription?: string
  bestSchemeKey?: string
  schemes?: LayoutSchemeDisplay[]
}

interface Props {
  data?: LayoutResult | null
  useMock?: boolean
}
const props = withDefaults(defineProps<Props>(), {
  data: null,
  useMock: true
})

defineOptions({
  name: 'LayoutCard'
})

// ===== 配色与尺寸 =====
const GLASS_COLOR = '#AAD5E2'
const WASTE_COLOR = '#9C9C9C'
const STROKE_COLOR = '#333333'
const BACKGROUND_COLOR = '#FFFFFF'
const TEXT_COLOR = '#000000'

// 屏幕显示宽度（px）；导出分辨率独立设置
const DISPLAY_WIDTH = 720
const EXPORT_WIDTH = 2400
const PLATE_PADDING = 42
// 仅用于预览画布，增加左右留白，不改变原片本体的绘制尺寸。
const DISPLAY_CANVAS_SIDE_GUTTER = 72
const PLATE_HEADER_HEIGHT = 88
const DISPLAY_REFERENCE_PLATE_WIDTH = 2440
const DISPLAY_REFERENCE_PLATE_HEIGHT = 1830
const DISPLAY_PLATE_MAX_HEIGHT = Math.round(DISPLAY_WIDTH * (DISPLAY_REFERENCE_PLATE_HEIGHT / DISPLAY_REFERENCE_PLATE_WIDTH))
const PDF_PAGE_WIDTH = 1240
const PDF_PAGE_HEIGHT = 1754
const PDF_PAGE_PADDING = 72
const PDF_EXPORT_SCALE = 2
const PDF_FONT_FAMILY = '"Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", sans-serif'

// 无外部数据时回退到本地演示数据，便于直接预览
const sourceData = computed<LayoutResult | null>(
  () => props.data ?? (props.useMock ? (mockLayoutResult as unknown as LayoutResult) : null)
)

const message = useMessage()
const selectedSchemeKey = ref('')
const schemes = computed<LayoutSchemeDisplay[]>(() => sourceData.value?.schemes ?? [])
const activeScheme = computed<LayoutSchemeDisplay | null>(() => {
  return schemes.value.find(item => item.key === selectedSchemeKey.value)
    ?? schemes.value.find(item => item.isBest)
    ?? schemes.value[0]
    ?? null
})
const displayData = computed<LayoutResultData | null>(() => activeScheme.value?.layout ?? sourceData.value?.data ?? null)
const plates = computed<SpecPlateArea[]>(() => displayData.value?.SpecPlateAreas ?? [])

interface PlateGroup {
  plate: SpecPlateArea
  count: number
  key: string
}

interface PlateTitle {
  line1: string
  line2: string
}

interface PlateProductSummary {
  name: string
  size: string
  count: number
}

interface PlateSheetSummary {
  name: string
  material: string
  size: string
  count: number
}

function getPlateLayoutKey(plate: SpecPlateArea) {
  return JSON.stringify({
    ratio: plate.Ratio,
    width: plate.Width,
    height: plate.Height,
    pelList: plate.PelList.map((pel) => ({
      type: pel.Type,
      width: pel.Width,
      height: pel.Height,
      wasteFlg: pel.WasteFlg,
      glassType: pel.GlassType,
      position: pel.Position
    }))
  })
}

const plateGroups = computed<PlateGroup[]>(() => {
  const groupMap = new Map<string, PlateGroup>()

  plates.value.forEach((plate) => {
    const key = getPlateLayoutKey(plate)
    const group = groupMap.get(key)

    if (group) {
      group.count += 1
      return
    }

    groupMap.set(key, {
      plate,
      count: 1,
      key
    })
  })

  return [...groupMap.values()]
})

const overallRatio = computed(() => {
  const ratio = displayData.value?.Ratio
  return ratio === null || ratio === undefined ? null : `${ (ratio * 100).toFixed(2) }%`
})

const activePlateIndex = ref(0)
const activeCanvasRef = ref<HTMLCanvasElement | null>(null)

const hasMultipleSchemes = computed(() => schemes.value.length > 1)
const hasMultiplePlates = computed(() => plateGroups.value.length > 1)
const activePlateGroup = computed<PlateGroup | null>(() => plateGroups.value[activePlateIndex.value] ?? null)
const activeSchemeName = computed(() => activeScheme.value?.name || sourceData.value?.schemeName || '当前方案')
const activeSchemeDescription = computed(() => activeScheme.value?.description || sourceData.value?.schemeDescription || '')
const exportButtonLabel = computed(() => hasMultipleSchemes.value ? '导出优化排版图' : '导出全部')
const pdfExporting = ref(false)

function setCanvasRef(el: unknown) {
  activeCanvasRef.value = el instanceof HTMLCanvasElement ? el : null
}

function formatPercent(ratio: number) {
  return `${ (ratio * 100).toFixed(2) }%`
}

function formatCurrency(amount: number) {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amount)
}

function selectScheme(schemeKey: string) {
  if (!schemeKey || schemeKey === selectedSchemeKey.value) return
  selectedSchemeKey.value = schemeKey
}

function getPlateTitle(group: PlateGroup): PlateTitle {
  const specification = group.plate.OriginalSpecification || `${ group.plate.Width } × ${ group.plate.Height }`
  const label = group.plate.OriginalLabel || `原片 ${ specification }`
  const category = group.plate.OriginalCategory || '-'
  const thickness = group.plate.OriginalThickness ? `${ group.plate.OriginalThickness }mm` : '-'

  return {
    line1: `${ label } | ${ category } | ${ thickness } | ${ specification }`,
    line2: `利用率 ${ (group.plate.Ratio * 100).toFixed(2) }% | 张数 ${ group.count }`
  }
}

// 统一导出文件名，避免 PDF 与图片的命名规则不一致。
function getExportFileNameBase() {
  const schemeName = activeSchemeName.value.replace(/[\\/:*?"<>|]/g, '-')
  const today = new Date()
  const dateLabel = `${ today.getFullYear() }-${ String(today.getMonth() + 1).padStart(2, '0') }-${ String(today.getDate()).padStart(2, '0') }`

  return `套版图_${ schemeName }_${ dateLabel }`
}

function createPlateCanvas(
  group: PlateGroup,
  options: {
    width: number
    lineWidth?: number
    canvasSideGutter?: number
  }
) {
  const scale = options.width / group.plate.Width
  const outerLabelMetrics = getPlateOuterLabelMetrics(group.plate, scale)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(group.plate.Width * scale) + PLATE_PADDING * 2 + (options.canvasSideGutter ?? 0) * 2
  canvas.height = Math.round(group.plate.Height * scale) + PLATE_PADDING + outerLabelMetrics.bottomSpace + PLATE_HEADER_HEIGHT

  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  drawPlate(ctx, group.plate, scale, {
    canvasSideGutter: options.canvasSideGutter,
    lineWidth: options.lineWidth,
    title: getPlateTitle(group)
  })

  return canvas
}

function getPlateProducts(group: PlateGroup) {
  const productMap = new Map<string, PlateProductSummary>()

  group.plate.PelList.forEach((pel) => {
    if (pel.WasteFlg === 1) return
    const name = pel.DisplayName || '未命名产品'
    const size = `${ pel.Width } × ${ pel.Height }`
    const key = `${ name }__${ size }`
    const current = productMap.get(key)

    if (current) {
      current.count += 1
      return
    }

    productMap.set(key, {
      name,
      size,
      count: 1
    })
  })

  return [...productMap.values()]
}

function resolvePlateSource(plate: SpecPlateArea) {
  if (plate.OriginalSource) return plate.OriginalSource
  if (plate.OriginalLabel?.includes('余料')) return 'offcut'
  return 'raw'
}

function getSchemeSheetRows(sourceType: 'raw' | 'offcut') {
  const sheetMap = new Map<string, PlateSheetSummary>()

  plates.value.forEach((plate) => {
    if (resolvePlateSource(plate) !== sourceType) return

    const name = plate.OriginalLabel || `${ sourceType === 'raw' ? '原片' : '余料' } ${ plate.Width }×${ plate.Height }`
    const material = plate.OriginalCategory || '-'
    const size = plate.OriginalSpecification || `${ plate.Width } × ${ plate.Height }`
    const key = `${ name }__${ material }__${ size }`
    const current = sheetMap.get(key)

    if (current) {
      current.count += 1
      return
    }

    sheetMap.set(key, {
      name,
      material,
      size,
      count: 1
    })
  })

  return [...sheetMap.values()]
}

function getSchemeProductRows() {
  const productMap = new Map<string, PlateProductSummary>()

  plates.value.forEach((plate) => {
    plate.PelList.forEach((pel) => {
      if (pel.WasteFlg === 1) return

      const name = pel.DisplayName || '未命名产品'
      const size = `${ pel.Width } × ${ pel.Height }`
      const key = `${ name }__${ size }`
      const current = productMap.get(key)

      if (current) {
        current.count += 1
        return
      }

      productMap.set(key, {
        name,
        size,
        count: 1
      })
    })
  })

  return [...productMap.values()]
}

function getPlateOuterLabelMetrics(plate: SpecPlateArea, scale: number) {
  const plateHeight = Math.round(plate.Height * scale)
  const fontSize = Math.max(12, Math.round(plateHeight * 0.025))

  return {
    fontSize,
    // 为底部原片规格额外预留空间，避免高比例画板导出时文字贴边被裁切。
    bottomSpace: Math.max(PLATE_PADDING, fontSize + 18)
  }
}

function createPageCanvas() {
  const canvas = document.createElement('canvas')
  canvas.width = PDF_PAGE_WIDTH * PDF_EXPORT_SCALE
  canvas.height = PDF_PAGE_HEIGHT * PDF_EXPORT_SCALE

  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  // 通过高分辨率画布提升 PDF 内中文标题、表格线和细节图的输出清晰度。
  ctx.scale(PDF_EXPORT_SCALE, PDF_EXPORT_SCALE)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.fillStyle = '#eef3f9'
  ctx.fillRect(0, 0, PDF_PAGE_WIDTH, PDF_PAGE_HEIGHT)
  fillRoundedRect(ctx, 24, 24, PDF_PAGE_WIDTH - 48, PDF_PAGE_HEIGHT - 48, 22, '#ffffff')
  strokeRoundedRect(ctx, 24, 24, PDF_PAGE_WIDTH - 48, PDF_PAGE_HEIGHT - 48, 22, 'rgba(121, 141, 185, 0.24)')
  ctx.fillStyle = '#33518e'
  ctx.fillRect(24, 24, PDF_PAGE_WIDTH - 48, 10)

  return {
    canvas,
    ctx
  }
}

function fillRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  fillStyle: string
) {
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + width, y, x + width, y + height, radius)
  ctx.arcTo(x + width, y + height, x, y + height, radius)
  ctx.arcTo(x, y + height, x, y, radius)
  ctx.arcTo(x, y, x + width, y, radius)
  ctx.closePath()
  ctx.fillStyle = fillStyle
  ctx.fill()
}

function strokeRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  strokeStyle: string
) {
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + width, y, x + width, y + height, radius)
  ctx.arcTo(x + width, y + height, x, y + height, radius)
  ctx.arcTo(x, y + height, x, y, radius)
  ctx.arcTo(x, y, x + width, y, radius)
  ctx.closePath()
  ctx.strokeStyle = strokeStyle
  ctx.stroke()
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
  if (!text) return []

  const segments = text.split('\n')
  const lines: string[] = []

  segments.forEach((segment) => {
    let current = ''

    for (const char of segment) {
      const next = `${ current }${ char }`
      if (ctx.measureText(next).width <= maxWidth) {
        current = next
        continue
      }

      if (current) {
        lines.push(current)
      }
      current = char
    }

    lines.push(current || ' ')
  })

  return lines
}

function truncateTextToWidth(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
  if (!text) return ''
  if (ctx.measureText(text).width <= maxWidth) return text

  const ellipsis = '...'
  let result = text

  while (result && ctx.measureText(`${ result }${ ellipsis }`).width > maxWidth) {
    result = result.slice(0, -1)
  }

  return result ? `${ result }${ ellipsis }` : ellipsis
}

function drawPdfHeader(
  ctx: CanvasRenderingContext2D,
  options: {
    title: string
    pageIndex: number
    totalPages: number
    exportedAt: string
  }
) {
  const left = PDF_PAGE_PADDING

  ctx.fillStyle = '#1d2f4f'
  ctx.font = `700 42px ${ PDF_FONT_FAMILY }`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillText(options.title, left, 56)

  ctx.strokeStyle = 'rgba(121, 141, 185, 0.34)'
  ctx.beginPath()
  ctx.moveTo(left, 150)
  ctx.lineTo(PDF_PAGE_WIDTH - PDF_PAGE_PADDING, 150)
  ctx.stroke()
}

function drawPdfFooter(ctx: CanvasRenderingContext2D) {
  const left = PDF_PAGE_PADDING
  const footerY = PDF_PAGE_HEIGHT - 92

  ctx.strokeStyle = 'rgba(121, 141, 185, 0.30)'
  ctx.beginPath()
  ctx.moveTo(left, footerY - 18)
  ctx.lineTo(PDF_PAGE_WIDTH - PDF_PAGE_PADDING, footerY - 18)
  ctx.stroke()
}

function drawSummaryMetricCell(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  label: string,
  value: string,
  highlight = false
) {
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(x, y, width, height)
  ctx.strokeStyle = 'rgba(121, 141, 185, 0.20)'
  ctx.strokeRect(x, y, width, height)

  ctx.fillStyle = '#71809d'
  ctx.font = '500 20px sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillText(label, x + 24, y + 18)

  ctx.fillStyle = highlight ? '#33518e' : '#223452'
  ctx.font = highlight ? '700 34px sans-serif' : '600 30px sans-serif'
  ctx.fillText(truncateTextToWidth(ctx, value, width - 48), x + 24, y + 56)
}

function drawDataTable<T>(
  ctx: CanvasRenderingContext2D,
  options: {
    x: number
    y: number
    width: number
    title: string
    rows: T[]
    maxRows?: number
    emptyRow: T
    columns: Array<{
      title: string
      width: number
      align?: 'left' | 'center' | 'right'
      render: (row: T) => string
    }>
  }
) {
  const { x, y, width, title, rows, emptyRow, columns } = options
  const headerHeight = 54
  const tableHeaderHeight = 48
  const rowHeight = 42
  const tableX = x
  const tableY = y + headerHeight
  const totalWidthWeight = columns.reduce((sum, column) => sum + column.width, 0)
  const colWidths = columns.map((column, index) => {
    if (index === columns.length - 1) {
      const usedWidth = columns
        .slice(0, index)
        .reduce((sum, item) => sum + Math.round((item.width / totalWidthWeight) * width), 0)
      return width - usedWidth
    }

    return Math.round((column.width / totalWidthWeight) * width)
  })
  const visibleRows = rows.slice(0, options.maxRows ?? 5)
  const contentRows = visibleRows.length ? visibleRows : [emptyRow]
  const tableHeight = tableHeaderHeight + contentRows.length * rowHeight

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(x, y, width, headerHeight + tableHeight)
  ctx.strokeStyle = 'rgba(121, 141, 185, 0.22)'
  ctx.strokeRect(x, y, width, headerHeight + tableHeight)

  ctx.fillStyle = '#f6f8fc'
  ctx.fillRect(x, y, width, headerHeight)
  ctx.strokeStyle = 'rgba(121, 141, 185, 0.16)'
  ctx.strokeRect(x, y, width, headerHeight)

  ctx.fillStyle = '#1d2f4f'
  ctx.font = '600 24px sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(title, x + 22, y + headerHeight / 2)

  ctx.fillStyle = '#eef3fb'
  ctx.fillRect(tableX, tableY, width, tableHeaderHeight)
  ctx.strokeStyle = 'rgba(121, 141, 185, 0.18)'
  ctx.strokeRect(tableX, tableY, width, tableHeaderHeight)

  let cursorX = tableX
  columns.forEach((item, index) => {
    const colWidth = colWidths[index]
    ctx.strokeStyle = 'rgba(121, 141, 185, 0.16)'
    ctx.strokeRect(cursorX, tableY, colWidth, tableHeaderHeight)
    ctx.fillStyle = '#5d6d89'
    ctx.font = '600 20px sans-serif'
    ctx.textAlign = item.align === 'center' ? 'center' : item.align === 'right' ? 'right' : 'left'
    ctx.fillText(
      item.title,
      item.align === 'center'
        ? cursorX + colWidth / 2
        : item.align === 'right'
          ? cursorX + colWidth - 18
          : cursorX + 18,
      tableY + 24
    )
    cursorX += colWidth
  })

  contentRows.forEach((row, rowIndex) => {
    const currentY = tableY + tableHeaderHeight + rowIndex * rowHeight
    let cellX = tableX
    columns.forEach((column, cellIndex) => {
      const colWidth = colWidths[cellIndex]
      const align = column.align ?? 'left'
      const cell = truncateTextToWidth(ctx, column.render(row), colWidth - 28)
      ctx.strokeStyle = 'rgba(121, 141, 185, 0.14)'
      ctx.strokeRect(cellX, currentY, colWidth, rowHeight)
      ctx.fillStyle = '#2c3d59'
      ctx.font = '400 19px sans-serif'
      ctx.textAlign = align === 'center' ? 'center' : align === 'right' ? 'right' : 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText(
        cell,
        align === 'center'
          ? cellX + colWidth / 2
          : align === 'right'
            ? cellX + colWidth - 18
            : cellX + 18,
        currentY + rowHeight / 2
      )
      cellX += colWidth
    })
  })

  if (rows.length > visibleRows.length) {
    ctx.fillStyle = '#7a88a3'
    ctx.font = '400 18px sans-serif'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'top'
    ctx.fillText(`其余 ${ rows.length - visibleRows.length } 项未展开`, x + width - 18, y + headerHeight + tableHeight + 14)
  }
}

function createSummaryPageCanvas(exportedAt: string) {
  const page = createPageCanvas()
  if (!page) return null

  const { canvas, ctx } = page
  const scheme = activeScheme.value
  const totalPages = plateGroups.value.length + 1
  const contentX = PDF_PAGE_PADDING
  const contentWidth = PDF_PAGE_WIDTH - PDF_PAGE_PADDING * 2
  const rawSheetRows = getSchemeSheetRows('raw')
  const offcutSheetRows = getSchemeSheetRows('offcut')
  const productRows = getSchemeProductRows()

  drawPdfHeader(ctx, {
    title: '优化排版方案报告',
    pageIndex: 1,
    totalPages,
    exportedAt
  })

  ctx.fillStyle = '#1d2f4f'
  ctx.font = `700 44px ${ PDF_FONT_FAMILY }`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillText(truncateTextToWidth(ctx, activeSchemeName.value, contentWidth), contentX, 196)

  const summaryTableY = 278
  const cellWidth = contentWidth / 2
  const cellHeight = 108
  const summaryRows = [
    ['综合利用率', overallRatio.value ?? '--', true],
    ['原片张数', typeof scheme?.usedRawCount === 'number' ? `${ scheme.usedRawCount } 张` : '--', false],
    ['余料张数', typeof scheme?.usedOffcutCount === 'number' ? `${ scheme.usedOffcutCount } 张` : '--', false],
    ['总板数', typeof scheme?.totalPlateCount === 'number' ? `${ scheme?.totalPlateCount } 张` : `${ plates.value.length } 张`, false],
    ['排版种类', `${ plateGroups.value.length } 种`, false]
  ] as const

  summaryRows.forEach(([label, value, highlight], index) => {
    const row = Math.floor(index / 2)
    const col = index % 2
    drawSummaryMetricCell(
      ctx,
      contentX + col * cellWidth,
      summaryTableY + row * cellHeight,
      cellWidth,
      cellHeight,
      label,
      value,
      highlight
    )
  })

  drawDataTable<PlateSheetSummary>(ctx, {
    x: contentX,
    y: 632,
    width: contentWidth,
    title: '原片列表',
    rows: rawSheetRows,
    maxRows: 4,
    emptyRow: {
      name: '当前方案未使用原片',
      material: '-',
      size: '-',
      count: 0
    },
    columns: [
      {
        title: '名称',
        width: 2.2,
        render: row => row.name
      },
      {
        title: '品类',
        width: 1.2,
        render: row => row.material
      },
      {
        title: '规格',
        width: 1.7,
        render: row => row.size
      },
      {
        title: '张数',
        width: 0.9,
        align: 'center',
        render: row => row.count > 0 ? `${ row.count } 张` : '-'
      }
    ]
  })

  drawDataTable<PlateSheetSummary>(ctx, {
    x: contentX,
    y: 942,
    width: contentWidth,
    title: '余料列表',
    rows: offcutSheetRows,
    maxRows: 4,
    emptyRow: {
      name: '当前方案未使用余料',
      material: '-',
      size: '-',
      count: 0
    },
    columns: [
      {
        title: '名称',
        width: 2.2,
        render: row => row.name
      },
      {
        title: '品类',
        width: 1.2,
        render: row => row.material
      },
      {
        title: '规格',
        width: 1.7,
        render: row => row.size
      },
      {
        title: '张数',
        width: 0.9,
        align: 'center',
        render: row => row.count > 0 ? `${ row.count } 张` : '-'
      }
    ]
  })

  drawDataTable<PlateProductSummary>(ctx, {
    x: contentX,
    y: 1252,
    width: contentWidth,
    title: '成品列表',
    rows: productRows,
    maxRows: 5,
    emptyRow: {
      name: '当前方案未解析出成品信息',
      size: '-',
      count: 0
    },
    columns: [
      {
        title: '产品名称',
        width: 2.9,
        render: row => row.name
      },
      {
        title: '规格',
        width: 1.8,
        render: row => row.size
      },
      {
        title: '数量',
        width: 1,
        align: 'center',
        render: row => row.count > 0 ? `${ row.count } 件` : '-'
      }
    ]
  })

  drawPdfFooter(ctx)

  return canvas
}

function createPlateDetailPageCanvas(group: PlateGroup, index: number, exportedAt: string) {
  const page = createPageCanvas()
  if (!page) return null

  const { canvas, ctx } = page
  const products = getPlateProducts(group)
  const title = getPlateTitle(group)
  const totalPages = plateGroups.value.length + 1
  const pageIndex = index + 2
  const contentX = PDF_PAGE_PADDING
  const contentWidth = PDF_PAGE_WIDTH - PDF_PAGE_PADDING * 2
  const plateCanvas = createPlateCanvas(group, {
    width: EXPORT_WIDTH,
    lineWidth: 2
  })
  if (!plateCanvas) return null

  drawPdfHeader(ctx, {
    title: `排版明细 ${ index + 1 }`,
    pageIndex,
    totalPages,
    exportedAt
  })

  ctx.fillStyle = '#1d2f4f'
  ctx.font = '600 24px sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillText('明细概览', contentX, 184)

  const infoY = 224
  const infoHeight = 108
  const infoWidth = contentWidth / 3
  const infoItems = [
    ['原片规格', group.plate.OriginalSpecification || `${ group.plate.Width } × ${ group.plate.Height }`],
    ['类别 / 厚度', `${ group.plate.OriginalCategory || '-' } / ${ group.plate.OriginalThickness ? `${ group.plate.OriginalThickness }mm` : '-' }`],
    ['利用率 / 张数', `${ formatPercent(group.plate.Ratio) } / ${ group.count } 张`]
  ] as const

  infoItems.forEach(([label, value], idx) => {
    drawSummaryMetricCell(
      ctx,
      contentX + idx * infoWidth,
      infoY,
      infoWidth,
      infoHeight,
      label,
      value,
      idx === 2
    )
  })

  const imageBoxY = 374
  const imageBoxHeight = 838
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(contentX, imageBoxY, contentWidth, imageBoxHeight)
  ctx.strokeStyle = 'rgba(121, 141, 185, 0.22)'
  ctx.strokeRect(contentX, imageBoxY, contentWidth, imageBoxHeight)
  ctx.fillStyle = '#f6f8fc'
  ctx.fillRect(contentX, imageBoxY, contentWidth, 58)
  ctx.strokeStyle = 'rgba(121, 141, 185, 0.16)'
  ctx.strokeRect(contentX, imageBoxY, contentWidth, 58)

  ctx.fillStyle = '#1d2f4f'
  ctx.font = `700 26px ${ PDF_FONT_FAMILY }`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText('排版图', contentX + 22, imageBoxY + 29)

  ctx.fillStyle = '#5d6d89'
  ctx.font = `500 20px ${ PDF_FONT_FAMILY }`
  ctx.textAlign = 'right'
  ctx.fillText(truncateTextToWidth(ctx, title.line2, 380), contentX + contentWidth - 22, imageBoxY + 29)

  ctx.fillStyle = '#223452'
  ctx.font = `700 28px ${ PDF_FONT_FAMILY }`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  const titleLines = wrapText(ctx, title.line1, contentWidth - 44).slice(0, 2)
  titleLines.forEach((line, lineIndex) => {
    ctx.fillText(line, contentX + 22, imageBoxY + 80 + lineIndex * 32)
  })

  const imageFrameX = contentX + 28
  const imageFrameY = imageBoxY + 156
  const imageFrameWidth = contentWidth - 56
  const imageFrameHeight = 618
  ctx.fillStyle = '#fbfcfe'
  ctx.fillRect(imageFrameX, imageFrameY, imageFrameWidth, imageFrameHeight)
  ctx.strokeStyle = 'rgba(121, 141, 185, 0.18)'
  ctx.strokeRect(imageFrameX, imageFrameY, imageFrameWidth, imageFrameHeight)

  const imageScale = Math.min(
    (imageFrameWidth - 36) / plateCanvas.width,
    (imageFrameHeight - 36) / plateCanvas.height
  )
  const imageWidth = plateCanvas.width * imageScale
  const imageHeight = plateCanvas.height * imageScale
  const imageX = imageFrameX + (imageFrameWidth - imageWidth) / 2
  const imageY = imageFrameY + (imageFrameHeight - imageHeight) / 2
  ctx.drawImage(plateCanvas, imageX, imageY, imageWidth, imageHeight)

  drawDataTable<PlateProductSummary>(ctx, {
    x: contentX,
    y: 1254,
    width: contentWidth,
    title: '成品清单',
    rows: products,
    maxRows: 5,
    emptyRow: {
      name: '当前排版未解析出成品信息',
      size: '-',
      count: 0
    },
    columns: [
      {
        title: '产品名称',
        width: 2.9,
        render: row => row.name
      },
      {
        title: '规格',
        width: 1.8,
        render: row => row.size
      },
      {
        title: '数量',
        width: 1,
        align: 'center',
        render: row => row.count > 0 ? `${ row.count } 件` : '-'
      }
    ]
  })

  drawPdfFooter(ctx)

  return canvas
}


function drawCenteredFittedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  centerX: number,
  y: number,
  maxWidth: number,
  maxFontSize: number,
  minFontSize: number,
  fontWeight = 600
) {
  let fontSize = maxFontSize

  // 标题可能带有较长的原片名称，这里根据可用宽度自动收缩字号，保证导出和预览都稳定。
  while (fontSize > minFontSize) {
    ctx.font = `${ fontWeight } ${ fontSize }px sans-serif`
    if (ctx.measureText(text).width <= maxWidth) break
    fontSize -= 1
  }

  ctx.font = `${ fontWeight } ${ fontSize }px sans-serif`
  ctx.fillText(text, centerX, y)
}

function drawClippedPelName(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  width: number,
  height: number,
  fontSize: number
) {
  if (!text || width <= 18 || height <= 18) return

  const insetX = Math.max(6, Math.min(width * 0.12, 18))
  const insetY = Math.max(6, Math.min(height * 0.16, 20))
  const clipWidth = width - insetX * 2
  const clipHeight = height - insetY * 2

  if (clipWidth <= 0 || clipHeight <= 0) return

  // 产品名称只在当前成品块内部可见，超出部分直接裁切，不影响相邻块。
  ctx.save()
  ctx.beginPath()
  ctx.rect(x + insetX, y + insetY, clipWidth, clipHeight)
  ctx.clip()
  ctx.fillStyle = '#1f2d45'
  ctx.font = `600 ${ fontSize }px sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, x + width / 2, y + height / 2)
  ctx.restore()
}

function getDisplayScale(plate: SpecPlateArea) {
  const widthScale = DISPLAY_WIDTH / plate.Width
  const heightScale = DISPLAY_PLATE_MAX_HEIGHT / plate.Height

  // 展示尺寸同时受宽度和高度限制，避免高比例原片把消息区撑得过长。
  // 这里用 2440 × 1830 作为常见原片参考比例，让页面上的画布高度更稳定。
  return Math.min(widthScale, heightScale)
}

function goPrevPlate() {
  if (!plateGroups.value.length) return
  activePlateIndex.value = activePlateIndex.value === 0
    ? plateGroups.value.length - 1
    : activePlateIndex.value - 1
}

function goNextPlate() {
  if (!plateGroups.value.length) return
  activePlateIndex.value = activePlateIndex.value === plateGroups.value.length - 1
    ? 0
    : activePlateIndex.value + 1
}

// 绘制单块板。后端坐标系原点在左下角（Origin: left_bottom），
// Canvas 原点在左上角且 Y 轴向下，因此这里对 Y 做翻转。
function drawPlate(
  ctx: CanvasRenderingContext2D,
  plate: SpecPlateArea,
  scale: number,
  options: {
    canvasSideGutter?: number
    lineWidth?: number
    title?: PlateTitle
  } = {}
) {
  const lineWidth = options.lineWidth ?? 1
  const canvasSideGutter = options.canvasSideGutter ?? 0
  const width = Math.round(plate.Width * scale)
  const height = Math.round(plate.Height * scale)
  const padding = PLATE_PADDING
  const headerHeight = options.title ? PLATE_HEADER_HEIGHT : 0
  const outerLabelMetrics = getPlateOuterLabelMetrics(plate, scale)
  const canvasWidth = width + padding * 2 + canvasSideGutter * 2
  const canvasHeight = height + padding + outerLabelMetrics.bottomSpace + headerHeight
  const plateX = padding + canvasSideGutter
  const plateY = padding + headerHeight

  ctx.fillStyle = BACKGROUND_COLOR
  ctx.fillRect(0, 0, canvasWidth, canvasHeight)

  if (options.title) {
    const headerLine1Y = Math.max(23, Math.round(headerHeight * 0.32))
    const headerLine2Y = headerLine1Y + Math.max(20, Math.round(headerHeight * 0.24))
    const headerTextWidth = canvasWidth - padding * 2
    ctx.fillStyle = '#1b2c48'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    drawCenteredFittedText(
      ctx,
      options.title.line1,
      canvasWidth / 2,
      headerLine1Y,
      headerTextWidth,
      Math.max(14, Math.min(24, Math.round(width * 0.018))),
      11,
      600
    )

    ctx.fillStyle = '#53627c'
    drawCenteredFittedText(
      ctx,
      options.title.line2,
      canvasWidth / 2,
      headerLine2Y,
      headerTextWidth,
      Math.max(13, Math.min(18, Math.round(width * 0.015))),
      11,
      500
    )

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)'
    ctx.lineWidth = Math.max(1, Math.round(scale * 0.6))
    ctx.beginPath()
    ctx.moveTo(padding, headerHeight - 9)
    ctx.lineTo(canvasWidth - padding, headerHeight - 9)
    ctx.stroke()
  }

  // 原片未排版区域使用废料色，产品区域使用玻璃色
  ctx.fillStyle = WASTE_COLOR
  ctx.fillRect(plateX, plateY, width, height)

  ctx.strokeStyle = STROKE_COLOR
  ctx.lineWidth = lineWidth

  const plateFontSize = outerLabelMetrics.fontSize

  plate.PelList.forEach((pel) => {
    const x = plateX + pel.Position.X * scale
    const y = plateY + (plate.Height - pel.Position.Y - pel.Height) * scale
    const w = pel.Width * scale
    const h = pel.Height * scale

    ctx.fillStyle = pel.WasteFlg === 1 ? WASTE_COLOR : GLASS_COLOR
    ctx.fillRect(x, y, w, h)
    ctx.strokeRect(x, y, w, h)

    if (pel.WasteFlg !== 1 && Math.min(w, h) > 20) {
      const fontSize = Math.min(
        plateFontSize,
        Math.max(8, Math.round(Math.min(pel.Width, pel.Height) * scale * 0.12))
      )
      const labelFontSize = Math.min(
        Math.max(9, Math.round(fontSize * 0.95)),
        Math.max(10, Math.round(Math.min(w, h) * 0.16))
      )

      if (pel.DisplayName && w > 56 && h > 28) {
        drawClippedPelName(ctx, pel.DisplayName, x, y, w, h, labelFontSize)
      }

      ctx.fillStyle = TEXT_COLOR
      ctx.font = `${ fontSize }px sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'

      // 横向边显示长度
      ctx.fillText(`${ pel.Width }`, x + w / 2, y + h - Math.max(8, fontSize))

      // 纵向边显示宽度
      ctx.save()
      ctx.translate(x + Math.max(8, fontSize), y + h / 2)
      ctx.rotate(-Math.PI / 2)
      ctx.fillText(`${ pel.Height }`, 0, 0)
      ctx.restore()
    }
  })

  // 原片宽高标注放在画板外侧
  ctx.fillStyle = TEXT_COLOR
  ctx.font = `bold ${ plateFontSize }px sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.fillText(
    `${ plate.Width }mm`,
    plateX + width / 2,
    plateY + height + Math.max(8, Math.round((outerLabelMetrics.bottomSpace - plateFontSize) / 2))
  )

  ctx.save()
  ctx.translate(plateX / 2, plateY + height / 2)
  ctx.rotate(-Math.PI / 2)
  ctx.textBaseline = 'middle'
  ctx.fillText(`${ plate.Height }mm`, 0, 0)
  ctx.restore()
}

function renderActivePlate() {
  const canvas = activeCanvasRef.value
  const group = activePlateGroup.value
  if (!canvas || !group) return

  const displayCanvas = createPlateCanvas(group, {
    width: Math.round(group.plate.Width * getDisplayScale(group.plate)),
    canvasSideGutter: DISPLAY_CANVAS_SIDE_GUTTER
  })
  if (!displayCanvas) return

  canvas.width = displayCanvas.width
  canvas.height = displayCanvas.height

  const ctx = canvas.getContext('2d')
  if (!ctx) return

  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(displayCanvas, 0, 0)
}

function downloadUrl(url: string, fileName: string) {
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
}

function exportCanvasAsPng(canvas: HTMLCanvasElement, fileName: string) {
  canvas.toBlob((blob) => {
    if (!blob) return
    const url = URL.createObjectURL(blob)
    downloadUrl(url, fileName)
    URL.revokeObjectURL(url)
  }, 'image/png')
}

async function exportCurrentSchemePdf() {
  if (!plateGroups.value.length || pdfExporting.value) return

  pdfExporting.value = true

  try {
    const exportedAt = new Date().toLocaleString('zh-CN')
    const pdf = new JsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: 'a4',
      compress: true
    })
    const pageWidth = pdf.internal.pageSize.getWidth()
    const pageHeight = pdf.internal.pageSize.getHeight()

    const summaryCanvas = createSummaryPageCanvas(exportedAt)
    if (!summaryCanvas) {
      throw new Error('摘要页生成失败')
    }

    pdf.addImage(summaryCanvas.toDataURL('image/png'), 'PNG', 0, 0, pageWidth, pageHeight, undefined, 'FAST')

    plateGroups.value.forEach((group, index) => {
      const pageCanvas = createPlateDetailPageCanvas(group, index, exportedAt)
      if (!pageCanvas) return
      pdf.addPage()
      pdf.addImage(pageCanvas.toDataURL('image/png'), 'PNG', 0, 0, pageWidth, pageHeight, undefined, 'FAST')
    })

    pdf.save(`${ getExportFileNameBase() }.pdf`)
    message.success('当前方案 PDF 已开始导出')
  } catch (error) {
    console.error(error)
    message.error('导出当前方案 PDF 失败，请稍后重试')
  } finally {
    pdfExporting.value = false
  }
}

onMounted(renderActivePlate)

watch(plateGroups, async (groups) => {
  if (!groups.length) {
    activePlateIndex.value = 0
  } else if (activePlateIndex.value > groups.length - 1) {
    activePlateIndex.value = 0
  }
  await nextTick()
  renderActivePlate()
})

watch(activePlateIndex, async () => {
  await nextTick()
  renderActivePlate()
})

// 导出单种排版为 PNG
function exportPlate(group: PlateGroup, index: number) {
  const canvas = createPlateCanvas(group, {
    width: EXPORT_WIDTH,
    lineWidth: 2
  })
  if (!canvas) return

  exportCanvasAsPng(canvas, `${ getExportFileNameBase() }_排版图${ index + 1 }_${ group.count }张.png`)
}

function exportAll() {
  plateGroups.value.forEach(exportPlate)
}

function exportCurrentPlate() {
  const group = activePlateGroup.value
  if (!group) return
  exportPlate(group, activePlateIndex.value)
}

watch(schemes, (items) => {
  selectedSchemeKey.value = items.find(item => item.isBest)?.key
    || sourceData.value?.bestSchemeKey
    || sourceData.value?.schemeKey
    || items[0]?.key
    || ''
}, {
  immediate: true
})

watch(activeScheme, () => {
  activePlateIndex.value = 0
})
</script>

<template>
  <div class="layout-card">
    <div
      v-if="overallRatio"
      class="layout-card__ratio"
    >
      <span class="layout-card__ratio-label">{{ activeSchemeName }}</span>
      <span class="layout-card__ratio-value">{{ overallRatio }}</span>
    </div>

    <div
      v-if="activeSchemeDescription"
      class="layout-card__summary"
    >
      {{ activeSchemeDescription }}
    </div>

    <div
      v-if="schemes.length"
      class="layout-card__scheme-list"
    >
      <button
        v-for="scheme in schemes"
        :key="scheme.key"
        type="button"
        class="layout-card__scheme"
        :class="{ 'layout-card__scheme--active': scheme.key === (activeScheme?.key || '') }"
        @click="selectScheme(scheme.key)"
      >
        <div class="layout-card__scheme-head">
          <span class="layout-card__scheme-name">
            {{ scheme.name }}
          </span>
          <span
            v-if="scheme.isBest"
            class="layout-card__scheme-badge"
          >
            推荐
          </span>
          <span class="layout-card__scheme-ratio">
            {{ formatPercent(scheme.layout.Ratio) }}
          </span>
        </div>
        <div class="layout-card__scheme-meta">
          共 {{ scheme.totalPlateCount }} 张，原片 {{ scheme.usedRawCount }} 张，余料 {{ scheme.usedOffcutCount }} 张
        </div>
        <div
          v-if="typeof scheme.estimatedRawMaterialCost === 'number'"
          class="layout-card__scheme-cost"
        >
          预计原片成本：{{ formatCurrency(scheme.estimatedRawMaterialCost) }}
        </div>
        <div class="layout-card__scheme-material">
          实际用料：{{ scheme.materialSummary }}
        </div>
      </button>
    </div>

    <div class="layout-card__toolbar">
      <span class="layout-card__tip">
        当前方案共 {{ plates.length }} 块板，排版 {{ plateGroups.length }} 种
      </span>
      <div
        v-if="plateGroups.length"
        class="layout-card__toolbar-actions"
      >
        <n-button
          class="layout-card__export-pdf"
          size="small"
          secondary
          :loading="pdfExporting"
          :disabled="!plateGroups.length"
          @click="exportCurrentSchemePdf"
        >
          导出当前方案
        </n-button>
        <n-button
          v-if="hasMultiplePlates || hasMultipleSchemes"
          class="layout-card__export-all"
          size="small"
          secondary
          :disabled="!plateGroups.length || pdfExporting"
          @click="exportAll"
        >
          {{ exportButtonLabel }}
        </n-button>
      </div>
    </div>

    <div
      v-if="!plateGroups.length"
      class="layout-card__empty"
    >
      暂无排版数据
    </div>

    <div
      v-else
      class="layout-card__plate"
    >
      <div class="layout-card__stage">
        <div
          v-if="hasMultiplePlates"
          class="layout-card__indicator"
        >
          {{ activePlateIndex + 1 }} / {{ plateGroups.length }}
        </div>
        <button
          v-if="hasMultiplePlates"
          type="button"
          class="layout-card__nav layout-card__nav--prev"
          aria-label="查看上一张排版图"
          @click="goPrevPlate"
        >
          ‹
        </button>
        <canvas
          :ref="setCanvasRef"
          class="layout-card__canvas"
        ></canvas>
        <div class="layout-card__overlay-actions">
          <n-button
            class="layout-card__download"
            size="small"
            secondary
            strong
            circle
            title="下载当前图片"
            aria-label="下载当前图片"
            :disabled="!activePlateGroup"
            @click="exportCurrentPlate"
          >
            <template #icon>
              <IconifyIcon icon="mdi:download-outline" />
            </template>
          </n-button>
        </div>
        <button
          v-if="hasMultiplePlates"
          type="button"
          class="layout-card__nav layout-card__nav--next"
          aria-label="查看下一张排版图"
          @click="goNextPlate"
        >
          ›
        </button>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.layout-card {
  padding: 14px 14px 18px;
  border: 1px solid rgb(154 174 232 / 14%);
  border-radius: 20px;
  background:
    linear-gradient(180deg, rgb(255 255 255 / 96%), rgb(247 250 255 / 94%));
  box-shadow:
    0 18px 42px rgb(40 62 108 / 8%),
    inset 0 1px 0 rgb(255 255 255 / 88%);

  &__ratio {
    display: inline-flex;
    align-items: baseline;
    gap: 8px;
    padding: 6px 12px;
    margin-bottom: 12px;
    border: 1px solid rgb(127 150 214 / 12%);
    border-radius: 999px;
    background: rgb(255 255 255 / 78%);
    backdrop-filter: blur(12px);
  }

  &__ratio-label {
    font-size: 12px;
    color: #6b7690;
    letter-spacing: 0.04em;
  }

  &__ratio-value {
    font-size: 16px;
    font-weight: 600;
    color: #20314f;
  }

  &__summary {
    margin: -2px 0 14px;
    font-size: 13px;
    line-height: 1.7;
    color: #60708d;
  }

  &__scheme-list {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 12px;
    margin-bottom: 14px;
  }

  &__scheme {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 14px 14px 13px;
    appearance: none;
    border: 1px solid rgb(154 174 232 / 14%);
    border-radius: 18px;
    background:
      linear-gradient(180deg, rgb(255 255 255 / 96%), rgb(247 250 255 / 90%));
    box-shadow:
      0 12px 28px rgb(40 62 108 / 6%),
      inset 0 1px 0 rgb(255 255 255 / 88%);
    text-align: left;
    cursor: pointer;
    transition:
      transform 0.22s ease,
      box-shadow 0.22s ease,
      border-color 0.22s ease,
      background 0.22s ease;

    &:hover {
      transform: translateY(-1px);
      border-color: rgb(97 133 232 / 26%);
      box-shadow:
        0 14px 30px rgb(40 62 108 / 9%),
        inset 0 1px 0 rgb(255 255 255 / 92%);
    }

    &--active {
      border-color: rgb(91 129 230 / 36%);
      background:
        linear-gradient(180deg, rgb(255 255 255 / 98%), rgb(241 247 255 / 94%));
      box-shadow:
        0 16px 34px rgb(72 108 206 / 12%),
        inset 0 1px 0 rgb(255 255 255 / 94%);
    }

    &:focus-visible {
      outline: none;
      border-color: rgb(96 128 206 / 34%);
      box-shadow:
        0 0 0 4px rgb(120 149 219 / 14%),
        0 16px 34px rgb(72 108 206 / 12%),
        inset 0 1px 0 rgb(255 255 255 / 94%);
    }
  }

  &__scheme-head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 24px;
  }

  &__scheme-name {
    font-size: 14px;
    font-weight: 600;
    color: #20314f;
  }

  &__scheme-badge {
    display: inline-flex;
    align-items: center;
    height: 22px;
    padding: 0 8px;
    border: 1px solid rgb(89 126 226 / 16%);
    border-radius: 999px;
    background: rgb(87 125 228 / 10%);
    font-size: 11px;
    font-weight: 600;
    color: #4067c8;
  }

  &__scheme-ratio {
    margin-left: auto;
    font-size: 14px;
    font-weight: 600;
    color: #3154a3;
  }

  &__scheme-meta {
    font-size: 12px;
    color: #6a7690;
    line-height: 1.6;
  }

  &__scheme-cost {
    font-size: 12px;
    line-height: 1.6;
    color: #3154a3;
    font-weight: 600;
  }

  &__scheme-material {
    font-size: 12px;
    line-height: 1.7;
    color: #55647f;
  }

  &__toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 12px;
    padding: 2px 0 14px;
    margin-bottom: 12px;
  }

  &__tip {
    display: inline-flex;
    align-items: center;
    min-height: 32px;
    padding: 0 12px;
    border-radius: 999px;
    background: rgb(245 248 255 / 92%);
    font-size: 12px;
    color: #65748f;
  }

  &__toolbar-actions {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }

  // 统一导出类主按钮视觉，保持当前方案与优化排版图风格一致。
  &__export-pdf,
  &__export-all {
    --n-color: #4f7dea;
    --n-color-hover: #5d88f7;
    --n-color-pressed: #456fda;
    --n-color-focus: #5d88f7;
    --n-border: 1px solid rgb(88 124 223 / 42%);
    --n-border-hover: 1px solid rgb(97 133 232 / 52%);
    --n-border-pressed: 1px solid rgb(79 115 213 / 56%);
    --n-border-focus: 1px solid rgb(97 133 232 / 52%);
    --n-text-color: #fff;
    --n-text-color-hover: #fff;
    --n-text-color-pressed: #fff;
    --n-text-color-focus: #fff;
    --n-ripple-color: rgb(255 255 255 / 18%);
    height: 32px;
    padding: 0 14px;
    border-radius: 999px;
    background: linear-gradient(135deg, #5d88f7, #4875ec) !important;
    color: #fff !important;
    box-shadow:
      0 10px 24px rgb(72 108 206 / 22%),
      inset 0 1px 0 rgb(255 255 255 / 18%);
    font-weight: 600;
    letter-spacing: 0.01em;
    transition:
      transform 0.22s ease,
      box-shadow 0.22s ease;

    &:deep(.n-button__content) {
      font-size: 12px;
    }

    &:hover {
      background: linear-gradient(135deg, #6a92fb, #557ff0) !important;
      transform: translateY(-1px);
      box-shadow:
        0 14px 28px rgb(72 108 206 / 28%),
        inset 0 1px 0 rgb(255 255 255 / 24%);
    }

    &:active {
      background: linear-gradient(135deg, #4f7dea, #3f6add) !important;
    }
  }

  &__export-pdf {
    min-width: 104px;
  }

  &__export-all {
    min-width: 88px;
  }

  &__empty {
    padding: 48px 0;
    text-align: center;
    color: #8c97ab;
  }

  &__plate {
    margin: 0 auto;
    text-align: center;
  }

  &__stage {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: fit-content;
    max-width: 100%;
    // padding: 10px;
    padding: 0;
    border: 1px solid rgb(154 174 232 / 12%);
    border-radius: 24px;
    background:
      radial-gradient(circle at top, rgb(255 255 255 / 88%), rgb(245 248 255 / 76%));
    margin: 0 auto;
    box-shadow:
      inset 0 1px 0 rgb(255 255 255 / 92%),
      0 10px 26px rgb(57 77 125 / 6%);
  }

  &__nav {
    position: absolute;
    top: 50%;
    z-index: 2;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 46px;
    height: 46px;
    border: 1px solid rgb(154 174 232 / 18%);
    border-radius: 999px;
    background:
      linear-gradient(180deg, rgb(255 255 255 / 72%), rgb(241 246 255 / 58%));
    box-shadow:
      0 14px 28px rgb(55 73 124 / 8%),
      inset 0 1px 0 rgb(255 255 255 / 76%);
    backdrop-filter: blur(18px);
    color: rgb(58 78 116 / 88%);
    font-size: 24px;
    line-height: 1;
    cursor: pointer;
    opacity: 0.72;
    transform: translateY(-50%);
    transition:
      opacity 0.24s ease,
      transform 0.24s ease,
      box-shadow 0.24s ease,
      border-color 0.24s ease,
      background 0.24s ease,
      color 0.24s ease;

    &:hover {
      border-color: rgb(120 149 219 / 28%);
      opacity: 1;
      color: #2d4267;
      background:
        linear-gradient(180deg, rgb(255 255 255 / 88%), rgb(246 249 255 / 74%));
      box-shadow:
        0 16px 32px rgb(55 73 124 / 12%),
        inset 0 1px 0 rgb(255 255 255 / 86%);
      transform: translateY(-50%) scale(1.04);
    }

    &:active {
      transform: translateY(-50%) scale(0.98);
    }

    &:focus-visible {
      outline: none;
      opacity: 1;
      border-color: rgb(96 128 206 / 34%);
      box-shadow:
        0 0 0 4px rgb(120 149 219 / 14%),
        0 16px 32px rgb(55 73 124 / 12%),
        inset 0 1px 0 rgb(255 255 255 / 86%);
    }

    &--prev {
      left: 16px;
    }

    &--next {
      right: 16px;
    }
  }

  &__canvas {
    display: inline-block;
    max-width: 100%;
    border: 1px solid rgb(154 174 232 / 18%);
    border-radius: 20px;
    background: linear-gradient(180deg, rgb(255 255 255 / 96%), rgb(246 249 255 / 92%));
    box-shadow: 0 18px 36px rgb(44 64 116 / 8%);
  }

  &__overlay-actions {
    position: absolute;
    right: 24px;
    top: 24px;
    z-index: 3;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    background: transparent;
    box-shadow: none;
    backdrop-filter: none;
  }

  &__indicator {
    position: absolute;
    left: 24px;
    top: 24px;
    z-index: 3;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 58px;
    height: 30px;
    padding: 0 12px;
    border: 1px solid rgb(127 150 214 / 16%);
    border-radius: 999px;
    background: linear-gradient(180deg, rgb(255 255 255 / 90%), rgb(243 247 255 / 82%));
    font-size: 12px;
    font-weight: 600;
    color: #6a7690;
    backdrop-filter: blur(14px);
    box-shadow:
      0 8px 18px rgb(57 78 126 / 10%),
      inset 0 1px 0 rgb(255 255 255 / 92%);
  }

  &__download {
    width: 36px;
    height: 36px;
    border-radius: 999px;
    color: #34507f;
    background: linear-gradient(180deg, rgb(255 255 255 / 96%), rgb(244 248 255 / 88%));
    box-shadow:
      0 8px 18px rgb(57 78 126 / 12%),
      inset 0 1px 0 rgb(255 255 255 / 92%);
    transition:
      transform 0.22s ease,
      box-shadow 0.22s ease,
      color 0.22s ease,
      background 0.22s ease;

    &:hover {
      color: #223d69;
      background: linear-gradient(180deg, rgb(255 255 255 / 100%), rgb(239 245 255 / 96%));
      box-shadow:
        0 10px 22px rgb(57 78 126 / 16%),
        inset 0 1px 0 rgb(255 255 255 / 96%);
      transform: translateY(-1px);
    }

    &:focus-visible {
      outline: none;
      box-shadow:
        0 0 0 4px rgb(120 149 219 / 16%),
        0 10px 22px rgb(57 78 126 / 16%),
        inset 0 1px 0 rgb(255 255 255 / 96%);
    }
  }

  @media (max-width: 768px) {
    &__stage {
      padding: 8px;
      border-radius: 20px;
    }

    &__nav {
      width: 40px;
      height: 40px;
      font-size: 22px;

      &--prev {
        left: -4px;
      }

      &--next {
        right: -4px;
      }
    }

    &__overlay-actions {
      right: 14px;
      top: 14px;
    }

    &__indicator {
      left: 14px;
      top: 14px;
    }
  }
}
</style>
