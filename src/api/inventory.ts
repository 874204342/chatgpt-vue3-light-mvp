type InventoryParams = Record<string, unknown>

export type InventorySummary = {
  totalRecords: number
  totalStockQuantity: number
  totalStockArea: number
}

export type RawInventoryRow = {
  id?: string
  name?: string
  factoryName?: string | null
  category?: string | null
  grade?: string | null
  colorFilm?: string | null
  thickness?: number
  location?: string | null
  specification?: string | null
  width?: number
  height?: number
  stockQuantity?: number
  stockArea?: number
  lastInboundAt?: string
}

export type OffcutInventoryRow = {
  id?: string
  tagId?: string
  factoryName?: string | null
  category?: string | null
  grade?: string | null
  colorFilm?: string | null
  thickness?: number
  location?: string | null
  width?: number
  height?: number
  stockQuantity?: number
  stockArea?: number
  inboundAt?: string
}

const createInventoryRequest = async (path: string, body: InventoryParams) => {
  const response = await fetch(`${ location.origin }/local-ai${ path }`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body || {})
  })

  const result = await response.json().catch(() => ({}))
  if (!response.ok && !result?.message) {
    throw new Error(`请求失败 (${ response.status })`)
  }
  return result
}

export const getInventoryList = (body: InventoryParams) => {
  return createInventoryRequest('/api/inventory/list', body)
}
