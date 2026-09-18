<script setup lang="ts">
import type { DataTableColumns } from 'naive-ui'
import {
  type InventorySummary,
  type OffcutInventoryRow,
  type RawInventoryRow,
  getInventoryList
} from '@/api/inventory'

type InventoryTabKey = 'raw' | 'offcut'

type InventorySearchForm = {
  keyword: string
  factoryName: string
  categoryName: string
  thickness: string
  location: string
}

type InventoryTabState<T> = {
  loading: boolean
  tableData: T[]
  total: number
  pageNum: number
  pageSize: number
  summary: InventorySummary
}

const props = defineProps<{
  show: boolean
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
}>()

const message = useMessage()
const activeTab = ref<InventoryTabKey>('raw')
const tableMaxHeight = ref(460)
const RAW_TABLE_SCROLL_X = 1280
const OFFCUT_TABLE_SCROLL_X = 1180

const createSearchForm = (): InventorySearchForm => ({
  keyword: '',
  factoryName: '',
  categoryName: '',
  thickness: '',
  location: ''
})

const createSummary = (): InventorySummary => ({
  totalRecords: 0,
  totalStockQuantity: 0,
  totalStockArea: 0
})

const searchFormMap = reactive<Record<InventoryTabKey, InventorySearchForm>>({
  raw: createSearchForm(),
  offcut: createSearchForm()
})

const rawState = reactive<InventoryTabState<RawInventoryRow>>({
  loading: false,
  tableData: [],
  total: 0,
  pageNum: 1,
  pageSize: 20,
  summary: createSummary()
})

const offcutState = reactive<InventoryTabState<OffcutInventoryRow>>({
  loading: false,
  tableData: [],
  total: 0,
  pageNum: 1,
  pageSize: 20,
  summary: createSummary()
})

const loadedStateMap = reactive<Record<InventoryTabKey, boolean>>({
  raw: false,
  offcut: false
})

const formatSpecification = (width?: string | number | null, height?: string | number | null) => {
  if (!width || !height) return '-'
  return `${ width } × ${ height }`
}

const rawColumns: DataTableColumns<RawInventoryRow> = [
  {
    title: '原片名称',
    key: 'name',
    width: 260,
    ellipsis: {
      tooltip: true
    }
  },
  {
    title: '厂家',
    key: 'factoryName',
    width: 120
  },
  {
    title: '品类',
    key: 'category',
    width: 110
  },
  {
    title: '厚度(mm)',
    key: 'thickness',
    width: 110
  },
  {
    title: '规格',
    key: 'specification',
    width: 150,
    render: row => row.specification || formatSpecification(row.width, row.height)
  },
  {
    title: '库存(张)',
    key: 'stockQuantity',
    width: 110
  },
  {
    title: '库存面积(㎡)',
    key: 'stockArea',
    width: 120
  },
  {
    title: '库位',
    key: 'location',
    width: 140,
    ellipsis: {
      tooltip: true
    }
  },
  {
    title: '最近入库',
    key: 'lastInboundAt',
    width: 170
  }
]

const offcutColumns: DataTableColumns<OffcutInventoryRow> = [
  {
    title: '标签号',
    key: 'tagId',
    width: 160
  },
  {
    title: '厂家',
    key: 'factoryName',
    width: 120
  },
  {
    title: '品类',
    key: 'category',
    width: 110
  },
  {
    title: '厚度(mm)',
    key: 'thickness',
    width: 110
  },
  {
    title: '规格',
    key: 'specification',
    width: 150,
    render: row => formatSpecification(row.width, row.height)
  },
  {
    title: '库存(张)',
    key: 'stockQuantity',
    width: 110
  },
  {
    title: '库存面积(㎡)',
    key: 'stockArea',
    width: 120
  },
  {
    title: '库位',
    key: 'location',
    width: 140,
    ellipsis: {
      tooltip: true
    }
  },
  {
    title: '入库时间',
    key: 'inboundAt',
    width: 170
  }
]

const syncTableLayout = async () => {
  await nextTick()
  if (typeof window === 'undefined') return

  // 移除汇总卡片后可用空间更充足，适当放宽表格高度上限，
  // 同时继续为分页和底部按钮保留安全空间。
  tableMaxHeight.value = Math.min(Math.max(window.innerHeight - 470, 280), 500)

  requestAnimationFrame(() => {
    window.dispatchEvent(new Event('resize'))
  })
}

const getTabState = (tab: InventoryTabKey) => tab === 'raw' ? rawState : offcutState

const buildRequestBody = (tab: InventoryTabKey) => {
  const form = searchFormMap[tab]
  const state = getTabState(tab)

  return {
    inventoryType: tab,
    pageParam: {
      pageNum: state.pageNum,
      pageSize: state.pageSize,
      total: state.total
    },
    keyword: form.keyword.trim(),
    factoryName: form.factoryName.trim(),
    categoryName: form.categoryName.trim(),
    thickness: form.thickness.trim().replace(/mm$/i, ''),
    location: form.location.trim()
  }
}

const fetchInventoryList = async (tab: InventoryTabKey) => {
  const state = getTabState(tab)
  state.loading = true

  try {
    const response = await getInventoryList(buildRequestBody(tab))
    if (response?.code !== 200) {
      message.warning(response?.message || '获取库存列表失败')
      return
    }

    state.tableData = response?.data?.list || []
    state.total = Number(response?.data?.total || 0)
    state.summary = response?.data?.summary || createSummary()
    loadedStateMap[tab] = true
    await syncTableLayout()
  } finally {
    state.loading = false
  }
}

const resetTabState = (tab: InventoryTabKey) => {
  const state = getTabState(tab)
  Object.assign(searchFormMap[tab], createSearchForm())
  state.tableData = []
  state.total = 0
  state.pageNum = 1
  state.pageSize = 20
  state.summary = createSummary()
  loadedStateMap[tab] = false
}

const initializeDialog = async () => {
  activeTab.value = 'raw'
  resetTabState('raw')
  resetTabState('offcut')
  await fetchInventoryList('raw')
}

const handleSearch = async (tab: InventoryTabKey) => {
  const state = getTabState(tab)
  state.pageNum = 1
  await fetchInventoryList(tab)
}

const handleReset = async (tab: InventoryTabKey) => {
  resetTabState(tab)
  await fetchInventoryList(tab)
}

const handlePageChange = async (tab: InventoryTabKey, page: number) => {
  const state = getTabState(tab)
  state.pageNum = page
  await fetchInventoryList(tab)
}

const handlePageSizeChange = async (tab: InventoryTabKey, pageSize: number) => {
  const state = getTabState(tab)
  state.pageSize = pageSize
  state.pageNum = 1
  await fetchInventoryList(tab)
}

const handleTabChange = async (tab: string) => {
  const targetTab = tab as InventoryTabKey
  activeTab.value = targetTab
  if (!loadedStateMap[targetTab]) {
    await fetchInventoryList(targetTab)
    return
  }
  await syncTableLayout()
}

const closeDialog = () => {
  emit('update:show', false)
}

watch(
  () => props.show,
  async (value) => {
    if (!value) return
    await initializeDialog()
  }
)

onMounted(() => {
  window.addEventListener('resize', syncTableLayout)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', syncTableLayout)
})
</script>

<template>
  <n-modal
    class="inventory-dialog-modal"
    :show="show"
    preset="card"
    title="仓库库存"
    style="width: min(1240px, calc(100vw - 32px)); height: min(760px, calc(100vh - 20px));"
    :bordered="false"
    :segmented="{ content: true }"
    @update:show="emit('update:show', $event)"
  >
    <div class="inventory-dialog">
      <n-tabs
        :value="activeTab"
        animated
        type="line"
        class="inventory-dialog__tabs"
        @update:value="handleTabChange"
      >
        <n-tab-pane
          name="raw"
          tab="原片库存"
        >
          <div
            class="inventory-dialog__tab-panel"
          >
            <n-form
              class="inventory-dialog__filters"
              label-placement="left"
              label-width="auto"
              :show-feedback="false"
            >
              <div class="inventory-dialog__filters-row inventory-dialog__filters-row--primary">
                <n-form-item
                  class="inventory-dialog__filter-item inventory-dialog__filter-item--keyword"
                  label="关键词"
                >
                  <n-input
                    v-model:value="searchFormMap.raw.keyword"
                    placeholder="名称、规格、色膜等"
                    @keyup.enter="handleSearch('raw')"
                  />
                </n-form-item>
                <n-form-item
                  class="inventory-dialog__filter-item"
                  label="厂家"
                >
                  <n-input
                    v-model:value="searchFormMap.raw.factoryName"
                    placeholder="请输入厂家"
                    @keyup.enter="handleSearch('raw')"
                  />
                </n-form-item>
                <n-form-item
                  class="inventory-dialog__filter-item"
                  label="品类"
                >
                  <n-input
                    v-model:value="searchFormMap.raw.categoryName"
                    placeholder="请输入品类"
                    @keyup.enter="handleSearch('raw')"
                  />
                </n-form-item>
              </div>

              <div class="inventory-dialog__filters-row inventory-dialog__filters-row--secondary">
                <n-form-item
                  class="inventory-dialog__filter-item"
                  label="厚度(mm)"
                >
                  <n-input
                    v-model:value="searchFormMap.raw.thickness"
                    placeholder="如 8 / 8mm"
                    @keyup.enter="handleSearch('raw')"
                  />
                </n-form-item>
                <n-form-item
                  class="inventory-dialog__filter-item"
                  label="库位"
                >
                  <n-input
                    v-model:value="searchFormMap.raw.location"
                    placeholder="请输入库位"
                    @keyup.enter="handleSearch('raw')"
                  />
                </n-form-item>
                <div class="inventory-dialog__filter-actions">
                  <div class="inventory-dialog__filter-actions-group">
                    <n-button
                      type="primary"
                      @click="handleSearch('raw')"
                    >
                      查询
                    </n-button>
                    <n-button @click="handleReset('raw')">
                      重置
                    </n-button>
                  </div>
                </div>
              </div>
            </n-form>

            <div class="inventory-dialog__table-wrap">
              <n-data-table
                class="inventory-dialog__table"
                remote
                :bordered="false"
                :loading="rawState.loading"
                :columns="rawColumns"
                :data="rawState.tableData"
                :single-line="false"
                :scroll-x="RAW_TABLE_SCROLL_X"
                :max-height="tableMaxHeight"
              />
            </div>

            <div class="inventory-dialog__pagination-wrap">
              <n-pagination
                v-model:page="rawState.pageNum"
                v-model:page-size="rawState.pageSize"
                :item-count="rawState.total"
                show-size-picker
                :page-sizes="[20, 50, 100]"
                @update:page="handlePageChange('raw', rawState.pageNum)"
                @update:page-size="handlePageSizeChange('raw', rawState.pageSize)"
              />
            </div>
          </div>
        </n-tab-pane>

        <n-tab-pane
          name="offcut"
          tab="余料库存"
        >
          <div
            class="inventory-dialog__tab-panel"
          >
            <n-form
              class="inventory-dialog__filters"
              label-placement="left"
              label-width="auto"
              :show-feedback="false"
            >
              <div class="inventory-dialog__filters-row inventory-dialog__filters-row--primary">
                <n-form-item
                  class="inventory-dialog__filter-item inventory-dialog__filter-item--keyword"
                  label="关键词"
                >
                  <n-input
                    v-model:value="searchFormMap.offcut.keyword"
                    placeholder="标签号、规格、色膜等"
                    @keyup.enter="handleSearch('offcut')"
                  />
                </n-form-item>
                <n-form-item
                  class="inventory-dialog__filter-item"
                  label="厂家"
                >
                  <n-input
                    v-model:value="searchFormMap.offcut.factoryName"
                    placeholder="请输入厂家"
                    @keyup.enter="handleSearch('offcut')"
                  />
                </n-form-item>
                <n-form-item
                  class="inventory-dialog__filter-item"
                  label="品类"
                >
                  <n-input
                    v-model:value="searchFormMap.offcut.categoryName"
                    placeholder="请输入品类"
                    @keyup.enter="handleSearch('offcut')"
                  />
                </n-form-item>
              </div>

              <div class="inventory-dialog__filters-row inventory-dialog__filters-row--secondary">
                <n-form-item
                  class="inventory-dialog__filter-item"
                  label="厚度(mm)"
                >
                  <n-input
                    v-model:value="searchFormMap.offcut.thickness"
                    placeholder="如 8 / 8mm"
                    @keyup.enter="handleSearch('offcut')"
                  />
                </n-form-item>
                <n-form-item
                  class="inventory-dialog__filter-item"
                  label="库位"
                >
                  <n-input
                    v-model:value="searchFormMap.offcut.location"
                    placeholder="请输入库位"
                    @keyup.enter="handleSearch('offcut')"
                  />
                </n-form-item>
                <div class="inventory-dialog__filter-actions">
                  <div class="inventory-dialog__filter-actions-group">
                    <n-button
                      type="primary"
                      @click="handleSearch('offcut')"
                    >
                      查询
                    </n-button>
                    <n-button @click="handleReset('offcut')">
                      重置
                    </n-button>
                  </div>
                </div>
              </div>
            </n-form>

            <div class="inventory-dialog__table-wrap">
              <n-data-table
                class="inventory-dialog__table"
                remote
                :bordered="false"
                :loading="offcutState.loading"
                :columns="offcutColumns"
                :data="offcutState.tableData"
                :single-line="false"
                :scroll-x="OFFCUT_TABLE_SCROLL_X"
                :max-height="tableMaxHeight"
              />
            </div>

            <div class="inventory-dialog__pagination-wrap">
              <n-pagination
                v-model:page="offcutState.pageNum"
                v-model:page-size="offcutState.pageSize"
                :item-count="offcutState.total"
                show-size-picker
                :page-sizes="[20, 50, 100]"
                @update:page="handlePageChange('offcut', offcutState.pageNum)"
                @update:page-size="handlePageSizeChange('offcut', offcutState.pageSize)"
              />
            </div>
          </div>
        </n-tab-pane>
      </n-tabs>

      <div class="inventory-dialog__footer">
        <n-space justify="end">
          <n-button @click="closeDialog">
            关闭
          </n-button>
        </n-space>
      </div>
    </div>
  </n-modal>
</template>

<style scoped lang="scss">
.inventory-dialog {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 12px;
  max-height: calc(100vh - 120px);
  min-height: 0;
}

.inventory-dialog__tabs {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
}

.inventory-dialog__tab-panel {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  gap: 12px;
}

.inventory-dialog__filters {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.inventory-dialog__filters-row {
  display: grid;
  gap: 12px;
  align-items: end;
}

.inventory-dialog__filters-row--primary {
  grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr) minmax(0, 1fr);
}

.inventory-dialog__filters-row--secondary {
  grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr) auto;
}

.inventory-dialog__filter-item {
  width: 100%;
  min-width: 0;
  margin-right: 0;
}

.inventory-dialog__filter-item--keyword {
  min-width: 260px;
}

.inventory-dialog__filter-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  justify-self: end;
  min-width: max-content;
}

.inventory-dialog__filter-actions-group {
  display: inline-flex;
  gap: 12px;
}

.inventory-dialog__table-wrap {
  display: flex;
  flex: 1;
  min-height: 180px;
  overflow: auto;
  border: 1px solid rgb(157 176 225 / 16%);
  border-radius: 18px;
  background:
    linear-gradient(180deg, rgb(255 255 255 / 94%), rgb(247 250 255 / 88%)),
    radial-gradient(circle at top left, rgb(255 255 255 / 74%), transparent 42%);
  box-shadow:
    inset 0 1px 0 rgb(255 255 255 / 72%),
    0 10px 24px rgb(64 88 150 / 6%);
  backdrop-filter: blur(14px);
}

.inventory-dialog__table {
  flex: 1;
  min-width: 0;
  min-height: 0;
  height: 100%;
}

.inventory-dialog__pagination-wrap {
  display: flex;
  justify-content: flex-start;
  flex-shrink: 0;
  padding-bottom: 2px;
}

.inventory-dialog__footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding-top: 12px;
  border-top: 1px solid rgb(157 176 225 / 12%);
  flex-shrink: 0;
}

.inventory-dialog-modal {

  :deep(.n-card) {
    display: flex;
    flex-direction: column;
    max-height: calc(100vh - 40px);
  }

  :deep(.n-card__content) {
    display: flex;
    min-height: 0;
    flex-direction: column;
    overflow: hidden;
  }

  :deep(.n-tabs-nav) {
    margin-bottom: 12px;
  }

  /* 建立完整的纵向伸缩链，避免 Tab 内部表格高度在弹窗中丢失。 */
  :deep(.n-tabs),
  :deep(.n-tabs-content),
  :deep(.n-tab-pane) {
    min-height: 0;
  }

  :deep(.n-tabs-content) {
    display: flex;
    flex: 1;
  }

  :deep(.n-tab-pane) {
    display: flex;
    flex: 1;
  }

  :deep(.n-form-item) {
    margin-bottom: 0;
  }

  :deep(.inventory-dialog__filters-row .n-form-item) {
    display: inline-flex;
    align-items: center;
    margin-bottom: 0;
  }

  :deep(.inventory-dialog__filters-row .n-form-item-label) {
    padding-bottom: 0;
    line-height: 32px;
    white-space: nowrap;
  }

  :deep(.inventory-dialog__filters-row .n-form-item-blank) {
    flex: 1;
  }

  :deep(.n-data-table) {
    height: 100%;
    background: transparent;
  }

  :deep(.n-data-table-wrapper) {
    height: 100%;
  }

  :deep(.n-data-table-base-table-body) {
    min-height: 120px;
  }

  :deep(.n-data-table-base-table-header) {
    background: rgb(244 247 255 / 92%);
  }

  :deep(.n-data-table-th) {
    color: #50627f;
    font-weight: 600;
  }

  :deep(.n-data-table-td) {
    background: transparent;
  }

  :deep(.n-pagination) {
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  /* 上一版样式未生效的根因是命中了不存在/优先级不足的类名。
     Naive UI 的页码按钮实际使用 .n-pagination-item，页容量选择器则是
     .n-pagination-select 内部的 .n-base-selection，这里按真实 DOM 结构覆盖。 */
  :deep(.n-pagination .n-pagination-item),
  :deep(.n-pagination .n-pagination-select .n-base-selection) {
    border-radius: 12px;
    border: 1px solid rgb(157 176 225 / 16%);
    background:
      linear-gradient(180deg, rgb(255 255 255 / 92%), rgb(245 248 255 / 88%)),
      radial-gradient(circle at top left, rgb(255 255 255 / 74%), transparent 42%);
    box-shadow:
      inset 0 1px 0 rgb(255 255 255 / 76%),
      0 6px 16px rgb(64 88 150 / 6%);
  }

  :deep(.n-pagination .n-pagination-select .n-base-selection-label),
  :deep(.n-pagination .n-pagination-select .n-base-selection-input) {
    color: #4a5f82;
  }

  :deep(.n-pagination .n-pagination-item:not(.n-pagination-item--disabled):hover) {
    color: #3357a8;
    border-color: rgb(122 150 226 / 26%);
    box-shadow:
      inset 0 1px 0 rgb(255 255 255 / 82%),
      0 8px 18px rgb(80 108 182 / 10%);
  }

  :deep(.n-pagination .n-pagination-item:not(.n-pagination-item--disabled).n-pagination-item--active) {
    color: #fff;
    border-color: transparent;
    background: linear-gradient(135deg, #5c7df2 0%, #729cff 100%);
    box-shadow:
      0 10px 22px rgb(82 114 208 / 22%),
      inset 0 1px 0 rgb(255 255 255 / 24%);
  }
}

@media (width <= 1080px) {
  .inventory-dialog__filters-row--primary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .inventory-dialog__filters-row--secondary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .inventory-dialog__filter-actions {
    grid-column: 2;
  }
}

@media (width <= 900px) {
  .inventory-dialog__filters-row--primary,
  .inventory-dialog__filters-row--secondary {
    grid-template-columns: 1fr;
  }

  .inventory-dialog__filter-item--keyword {
    min-width: 0;
  }

  .inventory-dialog__filter-actions {
    grid-column: auto;
    justify-self: stretch;
    justify-content: stretch;
  }

  .inventory-dialog__filter-actions-group {
    width: 100%;
  }

  .inventory-dialog__pagination-wrap {
    justify-content: flex-start;
  }
}
</style>
