import path from 'node:path'
import process from 'node:process'
import { config as loadEnv } from 'dotenv'

const workspaceRoot = path.resolve(process.cwd(), '..')

loadEnv({
  path: path.resolve(workspaceRoot, '.env.local'),
  override: false
})
loadEnv({
  path: path.resolve(workspaceRoot, '.env'),
  override: false
})

// DeepSeek 上游配置：优先读取专用变量，回退兼容旧的 VITE_ 前缀变量。
const deepseekApiKey = process.env.DEEPSEEK_API_KEY || process.env.VITE_DEEPSEEK_KEY || ''
const deepseekBaseUrl = process.env.DEEPSEEK_BASE_URL || 'https://newapi.jubocloud.com'
// 智谱 GLM 上游配置。
const glmApiKey = process.env.GLM_API_KEY || process.env.VITE_GLM_KEY || ''
const glmBaseUrl = process.env.GLM_BASE_URL || 'https://open.bigmodel.cn/api/paas'
const port = Number(process.env.LOCAL_AI_SERVER_PORT || 3001)

if (!deepseekApiKey) {
  console.warn('[server] Missing DEEPSEEK_API_KEY or VITE_DEEPSEEK_KEY in root .env files.')
}
if (!glmApiKey) {
  console.warn('[server] Missing GLM_API_KEY or VITE_GLM_KEY in root .env files.')
}

export const serverConfig = {
  workspaceRoot,
  deepseekApiKey,
  deepseekBaseUrl,
  glmApiKey,
  glmBaseUrl,
  port
}
