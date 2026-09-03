import path from 'node:path'
import process from 'node:process'
import { config as loadEnv } from 'dotenv'

const workspaceRoot = path.resolve(process.cwd(), '..')

loadEnv({ path: path.resolve(workspaceRoot, '.env.local'), override: false })
loadEnv({ path: path.resolve(workspaceRoot, '.env'), override: false })

const deepseekApiKey = process.env.DEEPSEEK_API_KEY || process.env.VITE_DEEPSEEK_KEY || ''
const deepseekBaseUrl = process.env.DEEPSEEK_BASE_URL || 'https://newapi.jubocloud.com'
const port = Number(process.env.LOCAL_AI_SERVER_PORT || 3001)

if (!deepseekApiKey) {
  console.warn('[server] Missing DEEPSEEK_API_KEY or VITE_DEEPSEEK_KEY in root .env files.')
}

export const serverConfig = {
  workspaceRoot,
  deepseekApiKey,
  deepseekBaseUrl,
  port
}
