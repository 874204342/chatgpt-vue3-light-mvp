const locationHost = {
  hostname: 'localhost',
  baseApiIp: 'http://10.30.10.54:10001',
  baseApi: 'http://10.30.10.54:10001/api'
}

const hostList = [
  locationHost
]

/**
 * 本地开发/未命中配置时的兜底 host 前缀
 * 测试与生产环境由 Nginx 同源反向代理 /api 到 SaaS 后台，
 * 因此这里统一使用相对路径，避免内网 IP 被打包进产物、也规避跨域
 */
const fallbackHost = {
  ...locationHost,
  baseApi: '/api'
}

/**
 *  获取当前服务的 host 前缀
 */
export const currentHost = hostList.find((hostItem) => {

  return window.location.hostname === hostItem.hostname

}) || fallbackHost

