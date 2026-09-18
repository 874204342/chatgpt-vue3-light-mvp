<script setup lang="ts">
import type { DataTableColumns } from 'naive-ui'
import {
  getOrderImportCategorySummary,
  getOrderImportList
} from '@/api/order-import'
import type { OrderImportRow } from '@/api/order-import'

type CategorySummaryItem = {
  unOptimThickness?: string
}

type OrderImportPayload = {
  rows: OrderImportRow[]
  autoGenerate?: boolean
  source: 'local' | 'excel'
}

const props = defineProps<{
  show: boolean
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  import: [payload: OrderImportPayload]
}>()

const message = useMessage()

const loading = ref(false)
const summaryLoading = ref(false)
const tableData = ref<OrderImportRow[]>([])
const total = ref(0)
const pageNum = ref(1)
const pageSize = ref(50)
const checkedRowKeys = ref<Array<string | number>>([])
const selectedRowMap = ref<Record<string, OrderImportRow>>({})
const categorySummaryMap = ref<Record<string, CategorySummaryItem[]>>({})
const LOCAL_TABLE_SCROLL_X = 1530
const tableMaxHeight = ref(460)

const thirtyDaysRange = () => {
  const end = new Date()
  const start = new Date()
  start.setDate(end.getDate() - 29)
  return [start.getTime(), end.getTime()] as [number, number]
}

const createSearchForm = () => ({
  createDateRange: thirtyDaysRange() as [number, number] | null,
  sendDateRange: null as [number, number] | null,
  orderNumber: '',
  customerName: '',
  projectName: '',
  floorNumber: '',
  productName: null as string | null,
  glassName: '',
  width: '',
  height: '',
  orderTypeId: null as string | number | null,
  glassNum: null as number | null,
  categoryName: '',
  thickness: ''
})

const searchForm = reactive(createSearchForm())

const rowKey = (row: OrderImportRow) => row.uniqueIndex || `${ row.orderNumber || '' }-${ row.glassName || '' }-${ row.createTime || '' }`

const localColumns: DataTableColumns<OrderImportRow> = [
  {
    type: 'selection',
    multiple: true
  },
  {
    title: '品类',
    key: 'categoryName',
    width: 100
  },
  {
    title: '厚度',
    key: 'thickness',
    width: 90
  },
  {
    title: '订单编号',
    key: 'orderNumber',
    width: 150
  },
  {
    title: '客户名称',
    key: 'customerName',
    width: 140,
    ellipsis: {
      tooltip: true
    }
  },
  {
    title: '项目名称',
    key: 'projectName',
    width: 160,
    ellipsis: {
      tooltip: true
    }
  },
  {
    title: '楼层编号',
    key: 'floorNumber',
    width: 110
  },
  {
    title: '产品名称',
    key: 'productName',
    width: 140,
    ellipsis: {
      tooltip: true
    }
  },
  {
    title: '单片名称',
    key: 'glassName',
    width: 140,
    ellipsis: {
      tooltip: true
    }
  },
  {
    title: '未优化数量',
    key: 'unPlateQuantity',
    width: 110
  },
  {
    title: '未优化面积',
    key: 'area',
    width: 110
  },
  {
    title: '制单时间',
    key: 'createTime',
    width: 170
  }
]

const categoryOptions = computed(() => {
  return Object.keys(categorySummaryMap.value).map(item => ({
    label: item,
    value: item
  }))
})

const selectedCount = computed(() => Object.keys(selectedRowMap.value).length)

const formatDate = (timestamp: number) => {
  const date = new Date(timestamp)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${ year }-${ month }-${ day }`
}

const getRangeValue = (value: [number, number] | null, index: 0 | 1) => {
  if (!value?.[index]) return ''
  return formatDate(value[index])
}

const getRequestParams = () => {
  return {
    pageParam: {
      pageNum: pageNum.value,
      pageSize: pageSize.value,
      total: total.value
    },
    showSpec: false,
    orderNumber: searchForm.orderNumber.trim(),
    customerName: searchForm.customerName.trim(),
    projectName: searchForm.projectName.trim(),
    floorNumber: searchForm.floorNumber.trim(),
    productName: searchForm.productName,
    glassName: searchForm.glassName.trim(),
    width: searchForm.width.trim(),
    height: searchForm.height.trim(),
    orderTypeId: searchForm.orderTypeId,
    glassNum: searchForm.glassNum,
    categoryName: searchForm.categoryName,
    thickness: searchForm.thickness ? searchForm.thickness.replace(/mm$/i, '') : '',
    createDateBegin: getRangeValue(searchForm.createDateRange, 0),
    createDateEnd: getRangeValue(searchForm.createDateRange, 1),
    sendDateBegin: getRangeValue(searchForm.sendDateRange, 0),
    sendDateEnd: getRangeValue(searchForm.sendDateRange, 1)
  }
}

const syncCheckedRowKeys = () => {
  checkedRowKeys.value = Object.keys(selectedRowMap.value)
}

const syncTableLayout = async () => {
  await nextTick()
  if (typeof window === 'undefined') return

  // Naive DataTable 在弹窗内更适合使用明确高度，避免 body 区在首次渲染时被算成 0。
  tableMaxHeight.value = Math.min(Math.max(window.innerHeight - 360, 320), 560)
  requestAnimationFrame(() => {
    window.dispatchEvent(new Event('resize'))
  })
}

const fetchCategorySummary = async () => {
  summaryLoading.value = true
  try {
    const response = await getOrderImportCategorySummary({
      ...getRequestParams(),
      pageParam: {
        pageNum: 1,
        pageSize: 50,
        total: total.value
      },
      categoryName: '',
      thickness: ''
    })
    if (response?.code !== 200) {
      message.warning(response?.message || '获取品类汇总失败')
      return
    }
    categorySummaryMap.value = (response.data || {}) as Record<string, CategorySummaryItem[]>
    if (searchForm.categoryName && !categorySummaryMap.value[searchForm.categoryName]) {
      searchForm.categoryName = ''
    }
  } finally {
    summaryLoading.value = false
  }
}

const fetchOrderList = async () => {
  loading.value = true
  try {
    const response = await getOrderImportList(getRequestParams())
    if (response?.code !== 200) {
      message.warning(response?.message || '获取订单列表失败')
      return
    }
    tableData.value = response?.data?.list || []
    total.value = Number(response?.data?.total || 0)
    if (!tableData.value.length) {
      message.info(response?.message || '当前暂无可导入的本地订单数据')
    }
    syncCheckedRowKeys()
    await syncTableLayout()
  } finally {
    loading.value = false
  }
}

const resetFilters = async () => {
  Object.assign(searchForm, createSearchForm())
  pageNum.value = 1
  total.value = 0
  await fetchCategorySummary()
  await fetchOrderList()
}

const initializeLocalTab = async () => {
  selectedRowMap.value = {}
  syncCheckedRowKeys()
  await resetFilters()
}

const initializeDialog = async () => {
  // 弹窗已收敛为单一“本地订单”入口，打开时直接刷新筛选和列表数据。
  await initializeLocalTab()
}

const closeDialog = () => {
  emit('update:show', false)
}

const handleSearch = async () => {
  pageNum.value = 1
  await fetchCategorySummary()
  await fetchOrderList()
}

const handleCategoryChange = async () => {
  pageNum.value = 1
  await fetchOrderList()
}

const handleUpdateCheckedRowKeys = (
  keys: Array<string | number>,
  rows: OrderImportRow[]
) => {
  const nextMap = {
    ...selectedRowMap.value
  }
  tableData.value.forEach((row) => {
    delete nextMap[String(rowKey(row))]
  })
  rows.forEach((row) => {
    nextMap[String(rowKey(row))] = row
  })
  selectedRowMap.value = nextMap
  checkedRowKeys.value = keys
}

const emitImport = (rows: OrderImportRow[], source: 'local' | 'excel', autoGenerate = false) => {
  emit('import', {
    rows,
    source,
    autoGenerate
  })
  closeDialog()
}

const handleImportLocalOrders = () => {
  const selectedRows = Object.values(selectedRowMap.value)
  if (!selectedRows.length) {
    message.warning('请先勾选订单')
    return
  }
  emitImport(selectedRows, 'local')
}

watch(
  () => props.show,
  async (value) => {
    if (!value) return
    await initializeDialog()
    await syncTableLayout()
  }
)
</script>

<template>
  <n-modal
    class="order-import-modal"
    :show="show"
    preset="card"
    title="导入订单"
    style="width: min(1240px, calc(100vw - 32px)); height: min(720px, calc(100vh - 20px));"
    :bordered="false"
    :segmented="{ content: true }"
    @update:show="emit('update:show', $event)"
  >
    <div class="order-import-dialog">
      <div class="order-import-dialog__local-panel">
        <n-form
          class="order-import-dialog__filters"
          label-placement="left"
          label-width="auto"
          :show-feedback="false"
        >
          <div class="order-import-dialog__filters-row order-import-dialog__filters-row--primary">
            <n-form-item
              class="order-import-dialog__filter-item order-import-dialog__filter-item--date"
              label="制单日期"
            >
              <n-date-picker
                v-model:value="searchForm.createDateRange"
                type="daterange"
                clearable
                style="width: 100%;"
              />
            </n-form-item>
            <n-form-item
              class="order-import-dialog__filter-item"
              label="订单编号"
            >
              <n-input
                v-model:value="searchForm.orderNumber"
                placeholder="请输入订单编号"
              />
            </n-form-item>
            <n-form-item
              class="order-import-dialog__filter-item"
              label="客户名称"
            >
              <n-input
                v-model:value="searchForm.customerName"
                placeholder="请输入客户名称"
              />
            </n-form-item>
            <n-form-item
              class="order-import-dialog__filter-item"
              label="单片名称"
            >
              <n-input
                v-model:value="searchForm.glassName"
                placeholder="请输入单片名称"
              />
            </n-form-item>
          </div>

          <div class="order-import-dialog__filters-row order-import-dialog__filters-row--secondary">
            <!-- <n-form-item
              class="order-import-dialog__filter-item"
              label="项目名称"
            >
              <n-input
                v-model:value="searchForm.projectName"
                placeholder="请输入项目名称"
              />
            </n-form-item> -->

            <n-form-item
              class="order-import-dialog__filter-item order-import-dialog__filter-item--select"
              label="品类"
            >
              <n-select
                v-model:value="searchForm.categoryName"
                :options="categoryOptions"
                clearable
                placeholder="请选择品类"
                :loading="summaryLoading"
                @update:value="handleCategoryChange"
              />
            </n-form-item>
            <n-form-item
              class="order-import-dialog__filter-item order-import-dialog__filter-item--select"
              label="厚度(mm)"
            >
              <!-- 与原片库存保持一致，厚度改为自由输入，支持输入 8 / 8mm 进行模糊筛选。 -->
              <n-input
                v-model:value="searchForm.thickness"
                placeholder="如 8 / 8mm"
                @keyup.enter="handleSearch"
              />
            </n-form-item>
            <div class="order-import-dialog__filter-actions">
              <div class="order-import-dialog__filter-actions-group">
                <n-button
                  type="primary"
                  @click="handleSearch"
                >
                  查询
                </n-button>
                <n-button @click="resetFilters">
                  重置
                </n-button>
              </div>
            </div>
          </div>
        </n-form>

        <div class="order-import-dialog__table-header">
          <span class="order-import-dialog__selected-count">已选择 {{ selectedCount }} 条订单</span>
        </div>

        <div class="order-import-dialog__table-wrap">
          <!-- 表格区域占据剩余高度，避免内容被弹窗高度挤压后出现可视区丢失。 -->
          <n-data-table
            class="order-import-dialog__table"
            remote
            :bordered="false"
            :loading="loading"
            :columns="localColumns"
            :data="tableData"
            :single-line="false"
            :scroll-x="LOCAL_TABLE_SCROLL_X"
            :max-height="tableMaxHeight"
            :row-key="rowKey"
            :checked-row-keys="checkedRowKeys"
            @update:checked-row-keys="handleUpdateCheckedRowKeys"
          />
        </div>

        <div class="pagination-wrap">
          <n-pagination
            v-model:page="pageNum"
            v-model:page-size="pageSize"
            :item-count="total"
            show-size-picker
            :page-sizes="[20, 50, 100]"
            @update:page="fetchOrderList"
            @update:page-size="fetchOrderList"
          />
        </div>
      </div>

      <div class="dialog-footer">
        <n-space class="dialog-footer__actions">
          <n-button @click="closeDialog">
            取消
          </n-button>
          <n-button
            type="primary"
            @click="handleImportLocalOrders"
          >
            导入到输入框
          </n-button>
        </n-space>
      </div>
    </div>
  </n-modal>
</template>

<style scoped lang="scss">
.order-import-dialog {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 12px;
  max-height: calc(100vh - 120px);
  min-height: 0;
}

.order-import-dialog__filters {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.order-import-dialog__filters-row {
  display: grid;
  gap: 12px;
  align-items: end;
}

.order-import-dialog__filters-row--primary {
  grid-template-columns: minmax(0, 1.45fr) minmax(0, 1.45fr) minmax(0, 1fr) minmax(0, 1fr);
}

.order-import-dialog__filters-row--secondary {
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 0.78fr) minmax(0, 0.78fr) auto;
}

.order-import-dialog__filter-item {
  width: 100%;
  min-width: 0;
  margin-right: 0;
}

.order-import-dialog__filter-item--date {
  min-width: 280px;
}

.order-import-dialog__filter-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  justify-self: end;
  grid-column: 5;
  min-width: max-content;
}

.order-import-dialog__filter-actions-group {
  display: inline-flex;
  gap: 12px;
}

.order-import-dialog__local-panel {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  gap: 12px;
}

.order-import-dialog__table-wrap {
  display: flex;
  flex: 1;
  min-height: 260px;
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

.order-import-dialog__table-header {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  min-height: 24px;
}

.order-import-dialog__selected-count {
  color: #50627f;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.01em;
}

.order-import-dialog__table {
  flex: 1;
  min-width: 0;
  min-height: 0;
  height: 100%;
}

.dialog-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 16px;
  padding-top: 12px;
  border-top: 1px solid rgb(157 176 225 / 12%);
  flex-shrink: 0;
}

.dialog-footer__actions {
  justify-content: flex-end;
}

.dialog-footer__actions :deep(.n-button) {
  min-width: 112px;
  height: 40px;
  border-radius: 12px;
}

.pagination-wrap {
  display: flex;
  justify-content: flex-start;
  flex-shrink: 0;
}

.order-import-modal {

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

  :deep(.n-form-item) {
    margin-bottom: 0;
  }

  :deep(.order-import-dialog__filters-row .n-form-item) {
    display: inline-flex;
    align-items: center;
    margin-bottom: 0;
  }

  :deep(.order-import-dialog__filters-row .n-form-item-label) {
    padding-bottom: 0;
    line-height: 32px;
    white-space: nowrap;
  }

  :deep(.order-import-dialog__filters-row .n-form-item-blank) {
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
}

@media (width <= 1180px) {

  .order-import-dialog__filters-row--primary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .order-import-dialog__filters-row--secondary {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .order-import-dialog__filter-actions {
    grid-column: 3;
    justify-content: flex-start;
    justify-self: end;
    min-width: max-content;
  }
}

@media (width <= 900px) {

  .order-import-dialog__filters-row--secondary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .order-import-dialog__filter-actions {
    grid-column: 2;
    justify-self: end;
  }
}

@media (width <= 820px) {

  .order-import-dialog__filters-row--primary,
  .order-import-dialog__filters-row--secondary {
    grid-template-columns: 1fr;
  }

  .order-import-dialog__filter-item--date {
    min-width: 0;
  }

  .order-import-dialog__filter-actions {
    grid-column: auto;
    justify-self: stretch;
    justify-content: stretch;
  }

  .order-import-dialog__filter-actions-group {
    width: 100%;
  }

  .dialog-footer {
    justify-content: stretch;
  }

  .dialog-footer__actions {
    width: 100%;
    justify-content: stretch;
  }

  .dialog-footer__actions :deep(.n-button) {
    flex: 1;
    min-width: 0;
  }
}
</style>
