<script setup lang="ts">
import type { DataTableColumns } from 'naive-ui'
import { getOrderImportCategorySummary, getOrderImportList } from '@/api/order-import'

type OrderImportRow = {
  uniqueIndex?: string
  categoryName?: string
  thickness?: string | number
  orderNumber?: string
  customerName?: string
  projectName?: string
  floorNumber?: string
  productName?: string
  glassName?: string
  unPlateQuantity?: string | number
  area?: string | number
  createTime?: string
  mergdeList?: OrderImportRow[]
}

type CategorySummaryItem = {
  unOptimThickness?: string
}

const props = defineProps<{
  show: boolean
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  import: [rows: OrderImportRow[]]
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

const columns: DataTableColumns<OrderImportRow> = [
  { type: 'selection', multiple: true },
  { title: '品类', key: 'categoryName', width: 100 },
  { title: '厚度', key: 'thickness', width: 90 },
  { title: '订单编号', key: 'orderNumber', width: 150 },
  { title: '客户名称', key: 'customerName', width: 140, ellipsis: { tooltip: true } },
  { title: '项目名称', key: 'projectName', width: 160, ellipsis: { tooltip: true } },
  { title: '楼层编号', key: 'floorNumber', width: 110 },
  { title: '产品名称', key: 'productName', width: 140, ellipsis: { tooltip: true } },
  { title: '单片名称', key: 'glassName', width: 140, ellipsis: { tooltip: true } },
  { title: '未优化数量', key: 'unPlateQuantity', width: 110 },
  { title: '未优化面积', key: 'area', width: 110 },
  { title: '制单时间', key: 'createTime', width: 170 }
]

const categoryOptions = computed(() => {
  return Object.keys(categorySummaryMap.value).map(item => ({
    label: item,
    value: item
  }))
})

const thicknessOptions = computed(() => {
  const currentCategory = searchForm.categoryName
  const targetRows = currentCategory
    ? (categorySummaryMap.value[currentCategory] || [])
    : Object.values(categorySummaryMap.value).flat()
  const thicknessList = [...new Set(
    targetRows
      .map(item => String(item.unOptimThickness || '').trim())
      .filter(Boolean)
  )]
  return thicknessList.map(item => ({
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
      searchForm.thickness = ''
    }
    if (searchForm.thickness && !thicknessOptions.value.some(item => item.value === searchForm.thickness)) {
      searchForm.thickness = ''
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
    syncCheckedRowKeys()
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

const initializeDialog = async () => {
  selectedRowMap.value = {}
  syncCheckedRowKeys()
  await resetFilters()
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
  searchForm.thickness = ''
  pageNum.value = 1
  await fetchOrderList()
}

const handleThicknessChange = async () => {
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

const handleImport = () => {
  const selectedRows = Object.values(selectedRowMap.value)
  if (!selectedRows.length) {
    message.warning('请先勾选订单')
    return
  }
  emit('import', selectedRows)
  closeDialog()
}

watch(
  () => props.show,
  (value) => {
    if (!value) return
    initializeDialog()
  }
)
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    title="导入订单"
    style="width: 1200px;"
    :bordered="false"
    :segmented="{ content: true }"
    @update:show="emit('update:show', $event)"
  >
    <n-space vertical :size="16">
      <n-space align="end" wrap>
        <n-form-item label="制单日期" style="width: 280px;">
          <n-date-picker
            v-model:value="searchForm.createDateRange"
            type="daterange"
            clearable
            style="width: 100%;"
          />
        </n-form-item>
        <n-form-item label="交货日期" style="width: 280px;">
          <n-date-picker
            v-model:value="searchForm.sendDateRange"
            type="daterange"
            clearable
            style="width: 100%;"
          />
        </n-form-item>
        <n-form-item label="订单编号" style="width: 220px;">
          <n-input v-model:value="searchForm.orderNumber" placeholder="请输入订单编号" />
        </n-form-item>
        <n-form-item label="客户名称" style="width: 220px;">
          <n-input v-model:value="searchForm.customerName" placeholder="请输入客户名称" />
        </n-form-item>
        <n-form-item label="项目名称" style="width: 220px;">
          <n-input v-model:value="searchForm.projectName" placeholder="请输入项目名称" />
        </n-form-item>
        <n-form-item label="楼层编号" style="width: 220px;">
          <n-input v-model:value="searchForm.floorNumber" placeholder="请输入楼层编号" />
        </n-form-item>
        <n-form-item label="单片名称" style="width: 220px;">
          <n-input v-model:value="searchForm.glassName" placeholder="请输入单片名称" />
        </n-form-item>
        <n-form-item label="品类" style="width: 180px;">
          <n-select
            v-model:value="searchForm.categoryName"
            :options="categoryOptions"
            clearable
            placeholder="请选择品类"
            :loading="summaryLoading"
            @update:value="handleCategoryChange"
          />
        </n-form-item>
        <n-form-item label="厚度" style="width: 160px;">
          <n-select
            v-model:value="searchForm.thickness"
            :options="thicknessOptions"
            clearable
            placeholder="请选择厚度"
            @update:value="handleThicknessChange"
          />
        </n-form-item>
        <n-space>
          <n-button type="primary" @click="handleSearch">查询</n-button>
          <n-button @click="resetFilters">重置</n-button>
        </n-space>
      </n-space>

      <n-data-table
        remote
        max-height="520"
        :loading="loading"
        :columns="columns"
        :data="tableData"
        :row-key="rowKey"
        :checked-row-keys="checkedRowKeys"
        @update:checked-row-keys="handleUpdateCheckedRowKeys"
      />

      <div class="dialog-footer">
        <span>已选择 {{ selectedCount }} 条订单</span>
        <n-space>
          <n-button @click="closeDialog">取消</n-button>
          <n-button type="primary" @click="handleImport">导入到输入框</n-button>
        </n-space>
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
    </n-space>
  </n-modal>
</template>

<style scoped lang="scss">
.dialog-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.pagination-wrap {
  display: flex;
  justify-content: flex-end;
}
</style>
