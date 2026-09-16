<script lang="ts" setup>
import { useSaasAuth } from '@/composables/useSaasAuth'

type LoginForm = {
  tenantUsername: string
  password: string
  tenantCode: string
}

const { user, authenticated, initialized, getStatus, login, logout } = useSaasAuth()
const message = useMessage()
const showLogin = ref(false)
const submitting = ref(false)
const form = reactive<LoginForm>({
  tenantUsername: '',
  password: '',
  tenantCode: ''
})

const userName = computed(() => {
  const value = user.value || {}
  return String(value.nickName || value.userName || value.username || value.tenantUsername || '已登录用户')
})

const avatarText = computed(() => userName.value.slice(0, 1).toUpperCase())

const userRole = computed(() => {
  const value = user.value || {}
  return String(value.role || value.roleName || value.positionName || '未返回')
})

const tenantName = computed(() => {
  const value = user.value || {}
  return String(value.tenantName || value.tenantCode || '未返回')
})

const openUserPanel = () => {
  if (authenticated.value) return
  showLogin.value = true
}

const handleLogin = async () => {
  if (!form.tenantUsername || !form.password || !form.tenantCode) {
    message.warning('请填写账号、密码和租户号')
    return
  }

  submitting.value = true
  try {
    await login(form)
    form.password = ''
    showLogin.value = false
    message.success('SaaS 已连接')
  } catch (error) {
    message.error(error instanceof Error ? error.message : '登录失败，请稍后重试')
  } finally {
    submitting.value = false
  }
}

const handleLogout = async () => {
  try {
    await logout()
    message.success('已退出 SaaS')
  } catch (error) {
    message.error(error instanceof Error ? error.message : '退出失败，请稍后重试')
  }
}

onMounted(() => {
  getStatus().catch(() => {
    initialized.value = true
  })
})
</script>

<template>
  <n-dropdown
    v-if="authenticated"
    trigger="click"
    :options="[
      { key: 'user-name', label: `用户名：${ userName }`, disabled: true },
      { key: 'user-role', label: `角色：${ userRole }`, disabled: true },
      // { key: 'tenant-name', label: `租户：${ tenantName }`, disabled: true },
      { key: 'logout', label: '退出登录' }
    ]"
    @select="(key) => key === 'logout' && handleLogout()"
  >
    <button
      type="button"
      class="user-entry"
      :title="`已登录：${ userName }`"
    >
      <n-avatar
        round
        size="small"
        color="#18a058"
      >
        {{ avatarText }}
      </n-avatar>
      <span class="user-state lt-sm:hidden">{{ tenantName }}</span>
    </button>
  </n-dropdown>
  <button
    v-else
    type="button"
    class="user-entry"
    :title="initialized ? '登录 SaaS' : '正在检查登录状态'"
    :disabled="!initialized"
    @click="openUserPanel"
  >
    <n-avatar
      round
      size="small"
      color="#909399"
    >
      <span class="i-carbon:user"></span>
    </n-avatar>
    <span class="user-state lt-sm:hidden">未登录</span>
  </button>

  <n-modal
    v-model:show="showLogin"
    preset="card"
    title="登录"
    style="width: 420px !important;"
    :mask-closable="!submitting"
    :closable="!submitting"
  >
    <n-form
      label-placement="top"
      @submit.prevent="handleLogin"
    >
      <n-form-item label="账号">
        <n-input
          v-model:value="form.tenantUsername"
          placeholder="请输入账号"
          autocomplete="username"
          :disabled="submitting"
        />
      </n-form-item>
      <n-form-item label="密码">
        <n-input
          v-model:value="form.password"
          type="password"
          show-password-on="click"
          placeholder="请输入密码"
          autocomplete="current-password"
          :disabled="submitting"
          @keyup.enter="handleLogin"
        />
      </n-form-item>
      <n-form-item label="租户号">
        <n-input
          v-model:value="form.tenantCode"
          placeholder="请输入租户号"
          :disabled="submitting"
          @keyup.enter="handleLogin"
        />
      </n-form-item>
      <n-button
        type="primary"
        block
        attr-type="submit"
        :loading="submitting"
      >
        登录
      </n-button>
    </n-form>
  </n-modal>
</template>

<style lang="scss" scoped>
.user-entry {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  margin-left: 10px;
  padding: 0 12px 0 6px;
  border: 1px solid rgb(155 176 255 / 16%);
  border-radius: 999px;
  background: linear-gradient(180deg, rgb(255 255 255 / 72%), rgb(248 250 255 / 66%));
  box-shadow:
    0 10px 22px rgb(55 73 124 / 5%),
    inset 0 1px 0 rgb(255 255 255 / 75%);
  color: #556987;
  cursor: pointer;
  transition: transform 0.2s ease, box-shadow 0.2s ease, background 0.2s ease;

  &:hover:not(:disabled) {
    background: linear-gradient(180deg, rgb(255 255 255 / 88%), rgb(246 249 255 / 82%));
    box-shadow:
      0 12px 24px rgb(55 73 124 / 7%),
      inset 0 1px 0 rgb(255 255 255 / 84%);
    transform: translateY(-1px);
  }

  &:disabled {
    cursor: wait;
    opacity: 0.6;
  }
}

.user-state {
  font-size: 13px;
  font-weight: 600;
}
</style>
