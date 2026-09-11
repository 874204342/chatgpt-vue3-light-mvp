import { serverConfig } from '../config.js'
import { type ChatMessage, extractTextContent } from '../types/chat.js'

export type LayoutResult = {
  status: number
  data: {
    Ratio: number
    SpecPlateAreas: unknown[]
    Origin: string
  }
  msg: string
}

type LayoutResolutionResult = {
  messages: ChatMessage[]
  toolCalls: string[]
  layout?: LayoutResult
}

type LayoutParams = {
  task_id: string
  min_cutting_rate: number
  cutting_margin: number
  sheet_infos: Array<{
    id: number
    glass_type: number
    size: [number, number]
    num: number
    trimming_margin: [[number, number], [number, number]]
  }>
  glass_infos: Array<{
    id: number
    glass_type: number
    size: [number, number]
    num: number
    grinding_margin: [[number, number], [number, number]]
    new_glass: number
  }>
}

const extractLastUserText = (messages: ChatMessage[]) => {
  const lastUserMessage = [...messages].reverse().find(message => message.role === 'user')
  return extractTextContent(lastUserMessage?.content ?? '')
}

const shouldGenerateLayout = (messages: ChatMessage[]) => {
  return extractLastUserText(messages).includes('排版')
}

const extractJsonObject = (text: string) => {
  const matched = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const rawText = matched?.[1] || text
  const startIndex = rawText.indexOf('{')
  const endIndex = rawText.lastIndexOf('}')

  if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) {
    throw new Error('模型未返回有效 JSON')
  }

  return JSON.parse(rawText.slice(startIndex, endIndex + 1))
}

const assertLayoutParams = (params: any): LayoutParams => {
  if (!params || !Array.isArray(params.sheet_infos) || !Array.isArray(params.glass_infos)) {
    throw new Error('模型生成的排版参数结构不完整')
  }

  return params as LayoutParams
}

const generateLayoutParamsByModel = async (userText: string) => {
  const response = await fetch(`${ serverConfig.newApiBaseUrl }/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ serverConfig.newApiApiKey }`
    },
    body: JSON.stringify({
      model: serverConfig.newApiModel,
      stream: false,
      messages: [
        {
          role: 'system',
          content: [
            '你是玻璃套料排版接口参数生成器。',
            '请把用户的大白话排版需求转换成严格 JSON，不要输出解释、Markdown 或代码块。',
            'JSON 必须匹配以下结构：',
            '{"task_id":"string","min_cutting_rate":0,"cutting_margin":0,"sheet_infos":[{"id":1,"glass_type":0,"size":[3660,2140],"num":327,"trimming_margin":[[0,0],[0,0]]}],"glass_infos":[{"id":1001,"glass_type":0,"size":[1100,1000],"num":135,"grinding_margin":[[0,0],[0,0]],"new_glass":0}]}',
            '规则：规格格式为宽×高时，size 按 [宽, 高] 输出；库存/数量转为 num；缺失的 glass_type、new_glass、margin 类字段默认填 0；id 用递增整数；task_id 可用当前时间戳字符串。'
          ].join('\n')
        },
        {
          role: 'user',
          content: userText
        }
      ]
    }),
    signal: AbortSignal.timeout(600000)
  })

  if (!response.ok) {
    throw new Error(`排版参数解析模型请求失败：${ response.status }`)
  }

  const data = await response.json()
  const content = data?.choices?.[0]?.message?.content
  if (!content) {
    throw new Error('排版参数解析模型未返回内容')
  }

  return assertLayoutParams(extractJsonObject(content))
}

export const resolveLayoutMessages = async (
  messages: ChatMessage[]
): Promise<LayoutResolutionResult> => {
  if (!shouldGenerateLayout(messages)) {
    return {
      messages,
      toolCalls: []
    }
  }

  try {
    const userText = extractLastUserText(messages)
    const params = await generateLayoutParamsByModel(userText)

    const response = await fetch('http://192.168.2.189:8088/layout/generate/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(60000)
    })

    if (!response.ok) {
      throw new Error(`排版接口请求失败：${ response.status }`)
    }

    const result = await response.text()
    const layout = JSON.parse(result) as LayoutResult
    return {
      layout,
      messages: [
        ...messages,
        {
          role: 'system',
          content: [
            '本轮已先将用户文本解析为排版接口 JSON，再调用排版生成接口。',
            '请优先基于以下接口请求参数和接口结果回答用户。',
            '',
            '排版接口请求参数：',
            JSON.stringify(params, null, 2),
            '',
            '排版接口返回结果：',
            result
          ].join('\n')
        }
      ],
      toolCalls: ['layout-generate']
    }
  } catch (error) {
    return {
      messages: [
        ...messages,
        {
          role: 'system',
          content: `本轮排版生成接口调用失败：${ error instanceof Error ? error.message : '未知错误' }。请如实告知用户。`
        }
      ],
      toolCalls: ['layout-generate-error']
    }
  }
}
