type OrderImportParams = Record<string, unknown>

const createOrderImportRequest = async (path: string, body: OrderImportParams) => {
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

export const getOrderImportCategorySummary = (body: OrderImportParams) => {
  return createOrderImportRequest('/api/order-import/category-summary', body)
}

export const getOrderImportList = (body: OrderImportParams) => {
  return createOrderImportRequest('/api/order-import/list', body)
}
