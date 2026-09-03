import Fastify from 'fastify'
import cors from '@fastify/cors'
import { registerChatRoutes } from './routes/chat.js'
import { serverConfig } from './config.js'

const bootstrap = async () => {
  const app = Fastify({
    logger: true
  })

  await app.register(cors, {
    origin: true
  })

  await registerChatRoutes(app)

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
