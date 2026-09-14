import { serverConfig } from '../config.js'
import { type ChatMessage, extractTextContent } from '../types/chat.js'

type LayoutSpecPlateArea = {
  Ratio: number
  Width: number
  Height: number
  DuplicateMark: string
}

export type LayoutResult = {
  status: number
  data: {
    Ratio: number
    SpecPlateAreas: LayoutSpecPlateArea[]
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

const extractLayoutConversation = (messages: ChatMessage[]) => {
  return messages
    .filter(message => message.role === 'user')
    .map(message => extractTextContent(message.content))
    .filter(Boolean)
    .join('\n\n')
}

const hasLayoutKeyword = (userText: string) => userText.includes('排版')

export const shouldGenerateLayout = async (messages: ChatMessage[]) => {
  const userText = extractLayoutConversation(messages)

  try {
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
              '判断用户是否希望进行玻璃套料、开料、裁切或原片利用率优化。',
              '仅当用户意图是根据成品玻璃和原片库存生成裁切方案时返回 true。',
              '其他所有请求返回 false。',
              '只输出 true 或 false，不要输出其他内容。'
            ].join('\n')
          },
          {
            role: 'user',
            content: userText
          }
        ]
      }),
      signal: AbortSignal.timeout(30000)
    })

    if (!response.ok) return hasLayoutKeyword(userText)

    const data = await response.json()
    return data?.choices?.[0]?.message?.content?.trim().toLowerCase() === 'true'
  } catch {
    return hasLayoutKeyword(userText)
  }
}

const createLayoutSummary = (layout: LayoutResult) => {
  const plates = layout.data.SpecPlateAreas
  const plans = plates.map((plate, index) => {
    const count = plate.DuplicateMark.length
    return `- 方案 ${ index + 1 }：原片 ${ plate.Width }×${ plate.Height }，单片利用率 ${ (plate.Ratio * 100).toFixed(2) }%，使用数量 ${ count }`
  })

  return [
    '排版结果摘要：',
    `- 综合利用率：${ (layout.data.Ratio * 100).toFixed(2) }%`,
    `- 排版方案数：${ plates.length }`,
    ...plans
  ].join('\n')
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

type LayoutParamsResolution = {
  params: LayoutParams
  missing_fields: string[]
}

const assertLayoutParamsResolution = (params: any): LayoutParamsResolution => {
  if (!params || !params.params || !Array.isArray(params.missing_fields)) {
    throw new Error('模型生成的排版参数结构不完整')
  }

  const { params: layoutParams } = params
  if (!Array.isArray(layoutParams.sheet_infos) || !Array.isArray(layoutParams.glass_infos)) {
    throw new Error('模型生成的排版参数结构不完整')
  }

  return params as LayoutParamsResolution
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
            '你是玻璃套料排版接口参数提取器。',
            '请根据用户提供的信息输出严格 JSON，不要输出解释、Markdown 或代码块。',
            'JSON 必须匹配以下结构：',
            '{"params":{"task_id":"string","min_cutting_rate":0,"cutting_margin":0,"sheet_infos":[{"id":1,"glass_type":0,"size":[3660,2140],"num":327,"trimming_margin":[[0,0],[0,0]]}],"glass_infos":[{"id":1001,"glass_type":0,"size":[1100,1000],"num":135,"grinding_margin":[[0,0],[0,0]],"new_glass":0}]},"missing_fields":[]}',
            '必须确认：至少一项成品订单的规格和数量；至少一项原片库存的规格和库存；是否允许旋转。缺少任一项时，写入 missing_fields，并且 params 中不得虚构该字段。',
            '规格格式为宽×高时，size 按 [宽, 高] 输出；库存/数量转为 num；glass_type、new_glass、磨边、修边、最低切裁率、掰片距离可按默认值 0 输出；id 用递增整数；task_id 可用当前时间戳字符串。'
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

  return assertLayoutParamsResolution(extractJsonObject(content))
}

export const resolveLayoutMessages = async (
  messages: ChatMessage[],
  isLayoutRequest: boolean,
  onProgress?: (message: string) => void
): Promise<LayoutResolutionResult> => {
  if (!isLayoutRequest) {
    return {
      messages,
      toolCalls: []
    }
  }

  try {
    const userText = extractLayoutConversation(messages)
    onProgress?.('正在解析订单与原片信息…')
    const { params, missing_fields: missingFields } = await generateLayoutParamsByModel(userText)

    if (missingFields.length) {
      return {
        messages: [
          ...messages,
          {
            role: 'system',
            content: [
              '用户希望进行玻璃套料排版，但参数不完整。',
              `缺少的信息：${ missingFields.join('；') }。`,
              '请用简短、清晰的中文向用户逐项追问；不要猜测参数，不要声称已调用排版接口。'
            ].join('\n')
          }
        ],
        toolCalls: ['layout-generate-need-input']
      }
    }

    params.sheet_infos.forEach(sheet => {
      sheet.glass_type = 0
    })
    params.glass_infos.forEach(glass => {
      glass.glass_type = 0
    })

    onProgress?.('正在调用排版算法计算最优方案…')
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
            '排版已完成，系统已根据排版接口的真实结果在聊天界面展示排版图，并提供图片导出功能。',
            '你只负责基于以下摘要，用 3～5 条简短、易懂的要点解释利用率、原片方案和废料优化建议。',
            '禁止输出、尝试生成或描述任何图片、SVG、Mermaid、ASCII 图、坐标点位、HTML 表格或原始 JSON。',
            '禁止声称无法生成图片，也不要提示用户查看你生成的图。',
            '如需提及图，请明确说明“系统生成的排版图已在下方展示”。',
            createLayoutSummary(layout)
          ].join('\n\n')
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
