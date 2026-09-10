import { extractTextContent, type ChatMessage } from '../types/chat.js'

// 天气增强结果，结构与 MCP 增强保持一致，便于路由层统一处理。
type WeatherResolutionResult = {
  messages: ChatMessage[]
  toolCalls: string[]
}

// Open-Meteo 地理编码接口返回的最小结构。
type GeocodingResult = {
  results?: Array<{
    name: string
    latitude: number
    longitude: number
    country?: string
    admin1?: string
  }>
}

// Open-Meteo 预报接口返回的最小结构。
type ForecastResult = {
  current?: {
    temperature_2m: number
    relative_humidity_2m: number
    apparent_temperature: number
    weather_code: number
    wind_speed_10m: number
  }
  daily?: {
    time: string[]
    weather_code: number[]
    temperature_2m_max: number[]
    temperature_2m_min: number[]
    precipitation_probability_max: Array<number | null>
  }
}

// WMO 天气代码到中文描述的映射，覆盖常见天气类型。
const WEATHER_CODE_TEXT: Record<number, string> = {
  0: '晴',
  1: '基本晴朗',
  2: '局部多云',
  3: '阴',
  45: '雾',
  48: '雾凇',
  51: '小毛毛雨',
  53: '毛毛雨',
  55: '大毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨（小）',
  67: '冻雨（大）',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '雪粒',
  80: '小阵雨',
  81: '阵雨',
  82: '强阵雨',
  85: '小阵雪',
  86: '大阵雪',
  95: '雷暴',
  96: '雷暴伴小冰雹',
  99: '雷暴伴大冰雹'
}

// 判断最后一条用户消息是否像在问天气。
// 规则保持轻量，避免对普通问题误触发外部请求。
const shouldQueryWeather = (messages: ChatMessage[]) => {
  const lastUserMessage = [...messages].reverse().find(message => message.role === 'user')
  if (!lastUserMessage) return false

  const text = extractTextContent(lastUserMessage.content)
  if (!text) return false

  return /天气|气温|温度|下雨|下雪|雨吗|雪吗|weather/i.test(text)
}

// 从用户问题中提取城市名。
// 优先匹配“某地 + 天气/气温/温度”的常见中文句式，提取失败时返回空字符串。
// 注意：日期词（今天/明天等）可能出现在城市前后，这里允许两种位置，
// 并在结果里剥掉误捕获到城市名开头的日期词。
const extractCity = (content: string) => {
  const match = content.match(/([\u4e00-\u9fa5A-Za-z]{2,12}?)(?:市|区|县)?(?:今天|明天|后天|最近)?(?:的)?(?:天气|气温|温度)/)
  return match?.[1]?.replace(/^(今天|明天|后天|最近)/, '').trim() || ''
}

// 调用 Open-Meteo 地理编码接口，把城市名解析为经纬度。
// 该接口免费且无需 API Key，适合本地开发场景。
const geocodeCity = async (city: string) => {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${ encodeURIComponent(city) }&count=1&language=zh&format=json`
  const response = await fetch(url, { signal: AbortSignal.timeout(90000) })

  if (!response.ok) return null

  const data = await response.json() as GeocodingResult
  return data.results?.[0] || null
}

// 按经纬度查询当前天气与未来三天预报。
const fetchForecast = async (latitude: number, longitude: number) => {
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    forecast_days: '3',
    timezone: 'auto'
  })

  const response = await fetch(`https://api.open-meteo.com/v1/forecast?${ params.toString() }`, {
    signal: AbortSignal.timeout(90000)
  })
  if (!response.ok) return null

  return await response.json() as ForecastResult
}

// 把预报数据整理成人类可读文本，供注入 system message 使用。
const formatForecastText = (locationName: string, forecast: ForecastResult) => {
  const lines: string[] = []
  const current = forecast.current

  if (current) {
    lines.push(
      `当前天气：${ WEATHER_CODE_TEXT[current.weather_code] || `代码${ current.weather_code }` }`,
      `当前气温：${ current.temperature_2m }°C（体感 ${ current.apparent_temperature }°C）`,
      `相对湿度：${ current.relative_humidity_2m }%`,
      `风速：${ current.wind_speed_10m } km/h`
    )
  }

  const daily = forecast.daily
  if (daily?.time?.length) {
    lines.push('未来三天预报：')
    daily.time.forEach((date, index) => {
      const rain = daily.precipitation_probability_max?.[index]
      lines.push(
        `- ${ date }：${ WEATHER_CODE_TEXT[daily.weather_code[index]] || `代码${ daily.weather_code[index] }` }，` +
        `${ daily.temperature_2m_min[index] }°C ~ ${ daily.temperature_2m_max[index] }°C${
          typeof rain === 'number' ? `，降水概率 ${ rain }%` : '' }`
      )
    })
  }

  return [`${ locationName } 天气数据（来源：Open-Meteo）：`, ...lines].join('\n')
}

// 根据当前消息列表决定是否做天气增强。
// 与 MCP 增强一样，结果以 system message 形式注入，模型据此回答而不是凭空编造。
export const resolveWeatherMessages = async (messages: ChatMessage[]): Promise<WeatherResolutionResult> => {
  if (!shouldQueryWeather(messages)) {
    return {
      messages,
      toolCalls: []
    }
  }

  const lastUserMessage = [...messages].reverse().find(message => message.role === 'user')
  const city = extractCity(extractTextContent(lastUserMessage?.content ?? ''))

  // 提取不到城市时不强行请求，交给模型自行回应。
  if (!city) {
    return {
      messages,
      toolCalls: []
    }
  }

  try {
    const location = await geocodeCity(city)
    if (!location) {
      throw new Error(`City not found: ${ city }`)
    }

    const forecast = await fetchForecast(location.latitude, location.longitude)
    if (!forecast) {
      throw new Error('Forecast fetch failed')
    }

    const locationName = [location.name, location.admin1, location.country].filter(Boolean).join('，')
    const weatherMessage: ChatMessage = {
      role: 'system',
      content: [
        '本轮已调用天气查询工具，请优先基于下面的实时数据回答天气相关问题，不要编造数据。',
        '',
        formatForecastText(locationName, forecast)
      ].join('\n')
    }

    return {
      messages: [...messages, weatherMessage],
      toolCalls: ['weather-open-meteo']
    }
  } catch (error) {
    // 查询失败时不阻断主链路，只提醒模型如实说明无法获取实时天气。
    const fallbackMessage: ChatMessage = {
      role: 'system',
      content: '本轮尝试查询实时天气但失败了。请如实告知用户暂时无法获取实时天气数据，不要编造。'
    }

    return {
      messages: [...messages, fallbackMessage],
      toolCalls: ['weather-error']
    }
  }
}
