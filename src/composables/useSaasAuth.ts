export type SaasUser = Record<string, unknown> | null

type AuthResponse = {
  authenticated?: boolean
  user?: SaasUser
  message?: string
}

type LoginPayload = {
  tenantUsername: string
  password: string
  tenantCode: string
}

const user = ref<SaasUser>(null)
const initialized = ref(false)

const request = async (url: string, init?: RequestInit) => {
  const response = await fetch(`/local-ai${ url }`, {
    credentials: 'include',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers
    }
  })
  const data = await response.json().catch(() => ({})) as AuthResponse
  if (!response.ok) throw new Error(data.message || '请求失败，请稍后重试')
  return data
}

export const useSaasAuth = () => {
  const authenticated = computed(() => Boolean(user.value))

  const getStatus = async () => {
    const data = await request('/api/saas/auth/status', { method: 'GET' })
    user.value = data.authenticated ? data.user || {} : null
    initialized.value = true
  }

  const login = async (payload: LoginPayload) => {
    const data = await request('/api/saas/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload)
    })
    user.value = data.user || {}
  }

  const logout = async () => {
    await request('/api/saas/auth/logout', {
      method: 'POST',
      body: JSON.stringify({})
    })
    user.value = null
  }

  return {
    user,
    authenticated,
    initialized,
    getStatus,
    login,
    logout
  }
}
