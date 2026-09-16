import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { serverConfig } from '../config.js'
import { getSaasToken } from './saas.js'

type OrderImportBody = Record<string, unknown>

const getAuthErrorResponse = (reply: FastifyReply) => {
  reply.code(401)
  return {
    message: '请先登录 SaaS 后再导入订单'
  }
}

const proxySaasOrderImportRequest = async (
  request: FastifyRequest<{ Body: OrderImportBody }>,
  reply: FastifyReply,
  path: string
) => {
  const token = getSaasToken(request)
  if (!token) {
    return getAuthErrorResponse(reply)
  }
  if (!serverConfig.saasBaseUrl) {
    reply.code(503)
    return {
      message: '未配置 SaaS 服务地址'
    }
  }

  let response: Response
  try {
    response = await fetch(`${ serverConfig.saasBaseUrl }${ path }`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': token
      },
      body: JSON.stringify(request.body || {}),
      signal: AbortSignal.timeout(30000)
    })
  } catch {
    reply.code(502)
    return {
      message: 'SaaS 订单服务暂时不可用'
    }
  }

  const result = await response.json().catch(() => null) as Record<string, unknown> | null
  if (!response.ok) {
    reply.code(response.status)
  }
  return result || {
    code: response.ok ? 200 : response.status,
    message: response.ok ? 'ok' : 'SaaS 订单服务返回异常'
  }
}

export const registerOrderImportRoutes = async (app: FastifyInstance) => {
  app.post<{ Body: OrderImportBody }>('/api/order-import/category-summary', async (request, reply) => {
    return proxySaasOrderImportRequest(request, reply, '/optimImport/unOptimCategoryOrder')
  })

  app.post<{ Body: OrderImportBody }>('/api/order-import/list', async (request, reply) => {
    return proxySaasOrderImportRequest(request, reply, '/optimImport/importOrder')
  })
}
