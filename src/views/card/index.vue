<script setup lang="ts">
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

// 无外部数据时回退到本地演示数据，便于直接预览
const sourceData = computed<LayoutResult | null>(
  () => props.data ?? (props.useMock ? (mockLayoutResult as unknown as LayoutResult) : null)
)

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
const exportButtonLabel = computed(() => hasMultipleSchemes.value ? '导出当前方案' : '导出全部')

function setCanvasRef(el: unknown) {
  activeCanvasRef.value = el instanceof HTMLCanvasElement ? el : null
}

function formatPercent(ratio: number) {
  return `${ (ratio * 100).toFixed(2) }%`
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
  const canvasWidth = width + padding * 2 + canvasSideGutter * 2
  const canvasHeight = height + padding * 2 + headerHeight
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

  const plateFontSize = Math.max(12, Math.round(height * 0.025))

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
  ctx.fillText(`${ plate.Width }mm`, plateX + width / 2, plateY + height + padding / 3)

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

  const scale = getDisplayScale(group.plate)
  canvas.width = Math.round(group.plate.Width * scale) + PLATE_PADDING * 2 + DISPLAY_CANVAS_SIDE_GUTTER * 2
  canvas.height = Math.round(group.plate.Height * scale) + PLATE_PADDING * 2 + PLATE_HEADER_HEIGHT

  const ctx = canvas.getContext('2d')
  if (!ctx) return

  drawPlate(ctx, group.plate, scale, {
    canvasSideGutter: DISPLAY_CANVAS_SIDE_GUTTER,
    title: getPlateTitle(group)
  })
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
  const { plate, count } = group
  const scale = EXPORT_WIDTH / plate.Width
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(plate.Width * scale) + PLATE_PADDING * 2
  canvas.height = Math.round(plate.Height * scale) + PLATE_PADDING * 2 + PLATE_HEADER_HEIGHT

  const ctx = canvas.getContext('2d')
  if (!ctx) return

  drawPlate(ctx, plate, scale, {
    lineWidth: 2,
    title: getPlateTitle(group)
  })

  canvas.toBlob((blob) => {
    if (!blob) return
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    const schemeSuffix = activeSchemeName.value.replace(/[\\/:*?\"<>|]/g, '-')
    link.download = `layout_${ schemeSuffix }_plate_${ index + 1 }_${ count }张.png`
    link.click()
    URL.revokeObjectURL(url)
  }, 'image/png')
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
          共 {{ scheme.totalPlateCount }} 张，余料 {{ scheme.usedOffcutCount }} 张，原片 {{ scheme.usedRawCount }} 张
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
      <n-button
        v-if="hasMultiplePlates || hasMultipleSchemes"
        class="layout-card__export-all"
        size="small"
        secondary
        :disabled="!plateGroups.length"
        @click="exportAll"
      >
        {{ exportButtonLabel }}
      </n-button>
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
    min-width: 88px;
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
