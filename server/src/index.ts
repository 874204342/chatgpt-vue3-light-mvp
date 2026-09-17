import Fastify from 'fastify'
import cors from '@fastify/cors'
import { registerChatRoutes } from './routes/chat.js'
import { registerOrderImportRoutes } from './routes/order-import.js'
import { serverConfig } from './config.js'

const bootstrap = async () => {
  const app = Fastify({
    logger: true,
    // base64 图片会显著增大请求体，默认 1MB 不够，放宽到 20MB 以支持多模态上传。
    bodyLimit: 20 * 1024 * 1024
  })

  await app.register(cors, {
    origin: true,
    credentials: true
  })

  await registerChatRoutes(app)
  await registerOrderImportRoutes(app)

  try {
    await app.listen({
      host: '0.0.0.0',
      port: serverConfig.port
    })
    app.log.info(`Local AI server is running on http://localhost:${ serverConfig.port }`)
  } catch (error) {
    app.log.error(error)
    process.exit(1)
  }
}

bootstrap()
