<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'

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
  PelList: Pel[]
}

interface LayoutResultData {
  Ratio: number
  SpecPlateAreas: SpecPlateArea[]
  Origin: string
}

export interface LayoutResult {
  status: number
  data: LayoutResultData
  msg: string
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
const DISPLAY_WIDTH = 900
const EXPORT_WIDTH = 2400
const PLATE_PADDING = 42

// 无外部数据时回退到本地演示数据，便于直接预览
const displayData = computed<LayoutResult | null>(
  () => props.data ?? (props.useMock ? (mockLayoutResult as unknown as LayoutResult) : null)
)

const plates = computed<SpecPlateArea[]>(() => displayData.value?.data?.SpecPlateAreas ?? [])

interface PlateGroup {
  plate: SpecPlateArea
  count: number
  key: string
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
  const ratio = displayData.value?.data?.Ratio
  return ratio == null ? null : `${ (ratio * 100).toFixed(2) }%`
})

const canvasRefs = ref<HTMLCanvasElement[]>([])

function setCanvasRef(el: unknown, index: number) {
  if (el instanceof HTMLCanvasElement) {
    canvasRefs.value[index] = el
  }
}

// 绘制单块板。后端坐标系原点在左下角（Origin: left_bottom），
// Canvas 原点在左上角且 Y 轴向下，因此这里对 Y 做翻转。
function drawPlate(
  ctx: CanvasRenderingContext2D,
  plate: SpecPlateArea,
  scale: number,
  lineWidth = 1
) {
  const width = Math.round(plate.Width * scale)
  const height = Math.round(plate.Height * scale)
  const padding = PLATE_PADDING
  const canvasWidth = width + padding * 2
  const canvasHeight = height + padding * 2
  const plateX = padding
  const plateY = padding

  ctx.fillStyle = BACKGROUND_COLOR
  ctx.fillRect(0, 0, canvasWidth, canvasHeight)

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
  ctx.translate(padding / 2, plateY + height / 2)
  ctx.rotate(-Math.PI / 2)
  ctx.textBaseline = 'middle'
  ctx.fillText(`${ plate.Height }mm`, 0, 0)
  ctx.restore()
}

function renderPlates() {
  plateGroups.value.forEach(({ plate }, index) => {
    const canvas = canvasRefs.value[index]
    if (!canvas) return

    const scale = DISPLAY_WIDTH / plate.Width
    canvas.width = Math.round(plate.Width * scale) + PLATE_PADDING * 2
    canvas.height = Math.round(plate.Height * scale) + PLATE_PADDING * 2

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    drawPlate(ctx, plate, scale)
  })
}

onMounted(renderPlates)

watch(plateGroups, async () => {
  await nextTick()
  renderPlates()
})

// 导出单种排版为 PNG
function exportPlate(group: PlateGroup, index: number) {
  const { plate, count } = group
  const scale = EXPORT_WIDTH / plate.Width
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(plate.Width * scale) + PLATE_PADDING * 2
  canvas.height = Math.round(plate.Height * scale) + PLATE_PADDING * 2

  const ctx = canvas.getContext('2d')
  if (!ctx) return

  drawPlate(ctx, plate, scale, 2)

  canvas.toBlob((blob) => {
    if (!blob) return
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `layout_plate_${ index + 1 }_${ count }张.png`
    link.click()
    URL.revokeObjectURL(url)
  }, 'image/png')
}

function exportAll() {
  plateGroups.value.forEach(exportPlate)
}
</script>

<template>
  <div class="layout-card">
    <div
      v-if="overallRatio"
      class="layout-card__ratio"
    >
      整体利用率：{{ overallRatio }}
    </div>

    <div class="layout-card__toolbar">
      <n-button
        type="primary"
        size="small"
        :disabled="!plateGroups.length"
        @click="exportAll"
      >
        导出图片
      </n-button>
      <span class="layout-card__tip">
        共 {{ plates.length }} 块板，排版 {{ plateGroups.length }} 种，导出 {{ plateGroups.length }} 张 PNG
      </span>
    </div>

    <div
      v-if="!plateGroups.length"
      class="layout-card__empty"
    >
      暂无排版数据
    </div>

    <div
      v-for="(group, index) in plateGroups"
      :key="group.key"
      class="layout-card__plate"
    >
      <div class="layout-card__plate-title">
        原片 {{ index + 1 }}（{{ group.plate.Width }} × {{ group.plate.Height }}，利用率 {{ (group.plate.Ratio * 100).toFixed(2) }}%，张数 {{ group.count }}）
      </div>
      <canvas
        :ref="(el) => setCanvasRef(el, index)"
        class="layout-card__canvas"
      ></canvas>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.layout-card {
  &__ratio {
    margin-bottom: 12px;
    font-size: 14px;
    color: #666;
  }

  &__toolbar {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 12px;
  }

  &__tip {
    font-size: 12px;
    color: #999;
  }

  &__empty {
    padding: 40px 0;
    text-align: center;
    color: #999;
  }

  &__plate {
    margin: 0 auto 16px;
    text-align: center;
  }

  &__plate-title {
    margin-bottom: 8px;
    font-size: 13px;
    color: #444;
  }

  &__canvas {
    display: inline-block;
    max-width: 100%;
    border: 1px solid #e5e5e5;
    border-radius: 4px;
  }
}
</style>
