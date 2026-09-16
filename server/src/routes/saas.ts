import { randomUUID, publicEncrypt, constants } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { serverConfig } from '../config.js'

type LoginBody = {
  tenantUsername?: string
  password?: string
  tenantCode?: string
}

type SaasSession = {
  token: string
  user: Record<string, unknown> | null
  expiresAt: number
}

const sessions = new Map<string, SaasSession>()
const cookieName = 'saas_session'
const sessionTtl = 8 * 60 * 60 * 1000
const publicKey = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCpsCRWVGkwOSNKD
+TA/ZZbGKaOR9omIkvLsj76g2t44u5nGcgDnk7RTri43g5fqCsy1yIBKrEjMTKkWuG2xoSfFoc3sA9S08/
zPPixD+THx2p+EAlvGdNoEz3Rk55BNUWWS3/rNEyBExS7ZdJkf3E8t+YJZ+OYO9c4ZHY/jHQRJQIDAQAB
-----END PUBLIC KEY-----`

const getSessionId = (request: FastifyRequest) => {
  const cookieHeader = request.headers.cookie || ''
  return cookieHeader
    .split(';')
    .map(item => item.trim())
    .find(item => item.startsWith(`${ cookieName }=`))
    ?.slice(cookieName.length + 1)
}

const setSessionCookie = (reply: FastifyReply, sessionId: string) => {
  reply.header('Set-Cookie', `${ cookieName }=${ sessionId }; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ sessionTtl / 1000 }`)
}

const clearSessionCookie = (reply: FastifyReply) => {
  reply.header('Set-Cookie', `${ cookieName }=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
}

const getSession = (request: FastifyRequest) => {
  const sessionId = getSessionId(request)
  const session = sessionId ? sessions.get(sessionId) : undefined
  if (!session || session.expiresAt <= Date.now()) {
    if (sessionId) sessions.delete(sessionId)
    return undefined
  }
  return { sessionId, session }
}

const encryptPassword = (password: string) => {
  return publicEncrypt(
    {
      key: publicKey,
      padding: constants.RSA_PKCS1_PADDING
    },
    Buffer.from(password)
  ).toString('base64')
}

const getUserInfo = (data: unknown) => {
  if (!data || typeof data !== 'object') return null
  const value = data as Record<string, unknown>
  const source = value.user && typeof value.user === 'object'
    ? value.user as Record<string, unknown>
    : value
  const { token: _token, refreshToken: _refreshToken, password: _password, ...user } = source
  return user
}

const getCurrentUserInfo = async (token: string, fallback: Record<string, unknown> | null) => {
  try {
    const response = await fetch(`${ serverConfig.saasBaseUrl }/employee/info`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${ token }` },
      signal: AbortSignal.timeout(30000)
    })
    if (!response.ok) return fallback
    const result = await response.json().catch(() => null) as Record<string, unknown> | null
    return getUserInfo(result?.data) || fallback
  } catch {
    return fallback
  }
}

export const registerSaasRoutes = async (app: FastifyInstance) => {
  app.get('/api/saas/auth/status', async (request, reply) => {
    const current = getSession(request)
    if (!current) return { authenticated: false }

    return {
      authenticated: true,
      user: current.session.user
    }
  })

  app.post<{ Body: LoginBody }>('/api/saas/auth/login', async (request, reply) => {
    const { tenantUsername, password, tenantCode } = request.body || {}
    if (!tenantUsername || !password || !tenantCode) {
      reply.code(400)
      return { message: '账号、密码和租户号不能为空' }
    }
    if (!serverConfig.saasBaseUrl) {
      reply.code(503)
      return { message: '未配置 SaaS 服务地址' }
    }

    let response: Response
    try {
      response = await fetch(`${ serverConfig.saasBaseUrl }/employee/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantUsername,
          password: encryptPassword(password),
          tenantCode
        }),
        signal: AbortSignal.timeout(30000)
      })
    } catch {
      reply.code(502)
      return { message: 'SaaS 登录服务暂时不可用' }
    }

    const result = await response.json().catch(() => null) as Record<string, unknown> | null
    const data = result?.data as Record<string, unknown> | undefined
    const token = typeof data?.token === 'string' ? data.token : ''
    if (!response.ok || result?.code !== 200 || !token) {
      reply.code(response.status >= 400 ? response.status : 401)
      return { message: typeof result?.message === 'string' ? result.message : 'SaaS 登录失败' }
    }

    const user = await getCurrentUserInfo(token, getUserInfo(data))
    const sessionId = randomUUID()
    sessions.set(sessionId, {
      token: `Bearer ${ token }`,
      user,
      expiresAt: Date.now() + sessionTtl
    })
    setSessionCookie(reply, sessionId)
    return {
      authenticated: true,
      user
    }
  })

  app.post('/api/saas/auth/logout', async (request, reply) => {
    const sessionId = getSessionId(request)
    if (sessionId) sessions.delete(sessionId)
    clearSessionCookie(reply)
    return { authenticated: false }
  })

}

export const getSaasToken = (request: FastifyRequest) => {
  return getSession(request)?.session.token
}

export const getSaasUser = (request: FastifyRequest) => {
  return getSession(request)?.session.user || null
}
