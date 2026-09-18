import MarkdownIt from 'markdown-it'
import hljs from './highlight'
import markdownItHighlight from 'markdown-it-highlightjs'
import { preWrapperPlugin } from './preWrapper'

import markdownItKatex from '@vscode/markdown-it-katex'
import splitAtDelimiters from 'katex/contrib/auto-render/splitAtDelimiters'

import 'katex/dist/katex.min.css'
import 'katex/dist/contrib/mhchem.min.js'

import {
  markdownItMermaidPlugin,
  renderMermaidSSE,
  transformMermaid
} from '@nzoth/toolkit'

import '@nzoth/toolkit/styles'

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true
})

const resolveMarkdownItPlugin = <T>(plugin: T): any =>
  // Some CJS/dual packages expose the actual plugin under `.default`.
  // MarkdownIt expects a function (which has `.apply`); passing a module object breaks at runtime.
  (plugin as any)?.default ?? plugin

md.use(markdownItHighlight, {
  hljs
})
  .use(preWrapperPlugin, {
    hasSingleTheme: true
  })
  .use(resolveMarkdownItPlugin(markdownItKatex))
  .use(markdownItMermaidPlugin)


const transformMathMarkdown = (markdownText: string) => {
  const data = splitAtDelimiters(markdownText, [
    {
      left: '\\[',
      right: '\\]',
      display: true
    },
    {
      left: '\\(',
      right: '\\)',
      display: false
    }
  ])

  return data.reduce((result, segment: any) => {
    if (segment.type === 'text') {
      return result + segment.data
    }
    const math = segment.display ? `$$${ segment.data }$$` : `$${ segment.data }$`
    return result + math
  }, '')
}

const THINK_BLOCK_PLACEHOLDER_CLASS = 'think-block-placeholder'

// 仅转义思考块中的 script，避免流式阶段把不可信脚本直接挂进 DOM。
const escapeThinkScriptTags = (content: string): string => {
  // <script> 或 <script ...>
  let escaped = content.replace(/<script([^>]*)>/gi, '&lt;script$1&gt;')
  // </script>
  escaped = escaped.replace(/<\/script>/gi, '&lt;/script&gt;')
  // <script ... />
  escaped = escaped.replace(/<script([^>]*)\s*\/>/gi, '&lt;script$1 /&gt;')

  return escaped
}

const createThinkBlockPlaceholder = (index: number) => [
  '',
  `<div class="${ THINK_BLOCK_PLACEHOLDER_CLASS }" data-index="${ index }"></div>`,
  ''
].join('\n')

const transformThinkMarkdown = (source: string) => {
  let result = ''
  let buffer = ''
  let inThinkBlock = false
  const thinkBlocks: string[] = []

  const appendThinkBlock = () => {
    thinkBlocks.push(escapeThinkScriptTags(buffer))
    result += createThinkBlockPlaceholder(thinkBlocks.length - 1)
    buffer = ''
  }

  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    const nextChars = source.slice(i, i + 7)
    const endChars = source.slice(i, i + 8)

    if (!inThinkBlock && nextChars === '<think>') {
      inThinkBlock = true
      buffer = ''
      i += 6
      continue
    }

    if (inThinkBlock && endChars === '</think>') {
      inThinkBlock = false
      appendThinkBlock()
      i += 7
      continue
    }

    if (inThinkBlock) {
      buffer += char
    } else {
      result += char
    }
  }

  if (inThinkBlock && buffer) {
    appendThinkBlock()
  }

  return {
    content: result,
    thinkBlocks
  }
}

const escapeHtml = (content: string) => content
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;')

const normalizeLayoutLine = (line: string) => line
  .replace(/^\s*(?:[-*+•●▪◦·]\s+|\d+[.)、]\s+|#{1,6}\s*)/, '')
  .trim()

// 自定义推荐卡片会跳过标准 Markdown 段落渲染，这里补一层轻量文本清洗，
// 避免 `**加粗**`、行首符号等语法直接暴露到 UI 上。
const normalizeInlineMarkdownText = (text: string) => text
  .replace(/^[•●▪◦·]\s*/, '')
  .replace(/\*\*(.*?)\*\*/g, '$1')
  .replace(/__(.*?)__/g, '$1')
  .replace(/`([^`]+)`/g, '$1')
  .replace(/\s{2,}/g, ' ')
  .trim()

const normalizeMatchText = (line: string) => normalizeLayoutLine(line)
  .replace(/\*\*/g, '')
  .replace(/__/g, '')
  .replace(/`/g, '')
  .replace(/<\/?[^>]+>/g, '')
  .trim()

const stripSectionPrefix = (line: string, pattern: RegExp) => {
  const stripped = line.replace(pattern, '').trim()
  return stripped || line.trim()
}

const highlightBusinessText = (text: string) => escapeHtml(text)
  .replace(/(综合利用率[:：]?\s*)(\d+(?:\.\d+)?%)/g, '$1<span class="layout-analysis__inline-metric">$2</span>')
  .replace(/((?:需要|约需|需用|使用约)\s*\d+\s*张)/g, '<span class="layout-analysis__alert-num">$1</span>')
  .replace(/((?:库存(?:仅|约)?|可用库存(?:仅|约)?|候选库存中该规格仅)\s*\d+\s*张)/g, '<span class="layout-analysis__alert-num">$1</span>')
  .replace(/((?:存在(?:明显)?备料缺口|存在缺口|库存不足|需补料|建议补料))/g, '<span class="layout-analysis__alert-tag">$1</span>')

const parseLabeledText = (text: string) => {
  const matched = text.match(/^([^：:]{2,20})[：:]\s*(.+)$/)
  if (!matched) {
    return {
      label: '',
      body: text.trim()
    }
  }

  return {
    label: matched[1].trim(),
    body: matched[2].trim()
  }
}

const renderLayoutListItems = (items: string[], warning = false) => items
  .map((item) => {
    const normalizedItem = normalizeInlineMarkdownText(item)
    const { label, body } = parseLabeledText(normalizedItem)
    const text = body || normalizedItem
    const labelClassName = warning
      ? 'layout-analysis__item-label layout-analysis__item-label--risk'
      : 'layout-analysis__item-label'
    const bodyClassName = warning
      ? 'layout-analysis__item-text layout-analysis__item-text--risk'
      : 'layout-analysis__item-text'

    return [
      '<li class="layout-analysis__item">',
      label ? `<span class="${ labelClassName }">${ escapeHtml(label) }</span>` : '',
      `<span class="${ bodyClassName }">${ highlightBusinessText(text) }</span>`,
      '</li>'
    ].join('')
  })
  .join('')

const extractRecommendationContext = (line: string) => {
  const normalizedLine = normalizeInlineMarkdownText(line)
  const triggerMatched = normalizedLine.match(/^(.*?)(?=(?:本轮)?推荐(?:采用|选用|使用)|(?:采用|选用|使用)[“"「『]?(?:方案)?[A-Z])/i)

  if (!triggerMatched) {
    return {
      intro: '',
      recommendation: normalizedLine
    }
  }

  return {
    intro: triggerMatched[1].trim().replace(/[，,。；;]+$/, ''),
    recommendation: normalizedLine.slice(triggerMatched[1].length).trim()
  }
}

const extractSchemeInfo = (text: string) => {
  const matched = text.match(/[“"「『]?(?:方案)?([A-Z])\s*[：:、 ]\s*([^"”」』，。,；;]+)[”"」』]?/i)

  return {
    schemeCode: matched?.[1]?.toUpperCase() || '',
    schemeTitle: normalizeInlineMarkdownText(matched?.[2] || '')
  }
}

const transformLayoutSummaryMarkdown = (source: string) => {
  const lines = source
    .split('\n')
    .map(item => item.trim())
    .filter(Boolean)

  if (lines.length < 3) {
    return source
  }

  const recommendationPattern = /^(?:推荐方案|最佳方案)/i
  const advantagePattern = /^(?:方案优势|排版执行(?:较)?稳定|执行稳定性|订单适配(?:较好|良好)?|订单适配度|订单匹配度)/i
  const riskPattern = /^(?:风险预警|主要风险)/i
  const alternativePattern = /^(?:备选方案(?:说明|差异)?|方案差异|备选说明|执行建议|建议)/i

  let recommendationLine = ''
  const advantageLines: string[] = []
  const riskLines: string[] = []
  const alternativeLines: string[] = []
  const introLines: string[] = []
  const remainingLines: string[] = []

  lines.forEach((line) => {
    const normalizedLine = normalizeLayoutLine(line)
    const matchText = normalizeMatchText(line)

    if (/^系统已在下方展示多方案排版图/i.test(matchText)) {
      introLines.push(normalizedLine)
      return
    }

    if (!recommendationLine && recommendationPattern.test(matchText)) {
      recommendationLine = stripSectionPrefix(normalizedLine, /^(?:推荐方案|最佳方案)\s*/i)
      return
    }

    if (advantagePattern.test(matchText)) {
      advantageLines.push(stripSectionPrefix(normalizedLine, /^(?:方案优势|排版执行(?:较)?稳定|执行稳定性|订单适配(?:较好|良好)?|订单适配度|订单匹配度)\s*[：:]?\s*/i))
      return
    }

    if (riskPattern.test(matchText) || /(?:库存不足|备料缺口|存在缺口|需补料|库存仅)/.test(matchText)) {
      riskLines.push(stripSectionPrefix(normalizedLine, /^(?:风险预警|主要风险)\s*[：:]?\s*/i))
      return
    }

    if (alternativePattern.test(matchText)) {
      alternativeLines.push(stripSectionPrefix(normalizedLine, /^(?:备选方案(?:说明|差异)?|方案差异|备选说明|执行建议|建议)\s*[：:]?\s*/i))
      return
    }

    remainingLines.push(normalizedLine)
  })

  if (!recommendationLine || (!advantageLines.length && !riskLines.length && !alternativeLines.length)) {
    return source
  }

  if (remainingLines.length) {
    alternativeLines.push(...remainingLines)
  }

  const recommendationContext = extractRecommendationContext(recommendationLine)
  if (recommendationContext.intro) {
    introLines.unshift(recommendationContext.intro)
  }

  const normalizedRecommendation = recommendationContext.recommendation || normalizeInlineMarkdownText(recommendationLine)
  const ratioMatched = normalizedRecommendation.match(/(\d+(?:\.\d+)?)%/)
  if (!ratioMatched) {
    return source
  }

  const { schemeCode, schemeTitle: extractedSchemeTitle } = extractSchemeInfo(normalizedRecommendation)
  const recommendationHeader = normalizedRecommendation.split(/综合利用率[:：]?\s*(?:约|达)?\s*\d+(?:\.\d+)?%/i)[0] || normalizedRecommendation
  const schemeTitle = extractedSchemeTitle || recommendationHeader
    .replace(/^(?:本轮)?推荐(?:采用|选用|使用)?\s*/i, '')
    .replace(/[“"「『]?(?:方案)?[A-Z]\s*[：:、 ]\s*/i, '')
    .replace(/[，,。；\s]+$/g, '')
    .trim() || '综合表现最优'
  const recommendationDetail = normalizedRecommendation
    .replace(/^(?:本轮)?推荐(?:采用|选用|使用)?\s*/i, '')
    .replace(/[“"「『]?(?:方案)?[A-Z]\s*[：:、 ]\s*[^"”」』，。,；;]+[”"」』]?/i, '')
    .replace(/综合利用率[:：]?\s*(?:约|达)?\s*\d+(?:\.\d+)?%\s*[，,。；]?/i, '')
    .replace(/^(?:完成|用于完成|可用于完成)\s*/i, '')
    .replace(/^[，,。；\s]+/, '')
    .trim()

  const noteHtml = introLines.length
    ? `<div class="layout-analysis__note">${ highlightBusinessText(normalizeInlineMarkdownText(introLines.join(' '))) }</div>`
    : ''

  return [
    '<section class="layout-analysis">',
    '<div class="layout-analysis__hero">',
    '<div class="layout-analysis__hero-badge">',
    schemeCode ? `推荐方案 ${ schemeCode }` : '推荐方案',
    '</div>',
    '<div class="layout-analysis__hero-main">',
    `<div class="layout-analysis__hero-title">${ escapeHtml(schemeTitle) }</div>`,
    '<div class="layout-analysis__hero-metric">',
    '<span class="layout-analysis__hero-metric-label">综合利用率</span>',
    `<span class="layout-analysis__hero-metric-value">${ ratioMatched[1] }%</span>`,
    '</div>',
    '</div>',
    recommendationDetail
      ? `<div class="layout-analysis__hero-desc">${ highlightBusinessText(recommendationDetail) }</div>`
      : '',
    noteHtml,
    '</div>',
    '<div class="layout-analysis__grid">',
    advantageLines.length
      ? [
        '<section class="layout-analysis__section">',
        '<div class="layout-analysis__section-badge">方案优势</div>',
        '<ul class="layout-analysis__list">',
        renderLayoutListItems(advantageLines),
        '</ul>',
        '</section>'
      ].join('')
      : '',
    riskLines.length
      ? [
        '<section class="layout-analysis__section layout-analysis__section--risk">',
        '<div class="layout-analysis__section-badge layout-analysis__section-badge--risk">风险预警</div>',
        '<ul class="layout-analysis__list">',
        renderLayoutListItems(riskLines, true),
        '</ul>',
        '</section>'
      ].join('')
      : '',
    alternativeLines.length
      ? [
        '<section class="layout-analysis__section layout-analysis__section--secondary">',
        '<div class="layout-analysis__section-badge">备选方案说明</div>',
        '<ul class="layout-analysis__list">',
        renderLayoutListItems(alternativeLines),
        '</ul>',
        '</section>'
      ].join('')
      : '',
    '</div>',
    '</section>'
  ].join('')
}


export const renderMarkdownText = (content: string) => {
  const thinkTransformed = transformThinkMarkdown(content)
  const layoutSummaryTransformed = transformLayoutSummaryMarkdown(thinkTransformed.content)
  const mathTransformed = transformMathMarkdown(layoutSummaryTransformed)
  const mermaidTransformed = transformMermaid(mathTransformed)
  let renderedContent = md.render(mermaidTransformed)

  // 思考块单独渲染后再回填，避免中间态 HTML 与正文 Markdown 发生二次渲染。
  thinkTransformed.thinkBlocks.forEach((thinkBlock, index) => {
    const placeholder = `<div class="${ THINK_BLOCK_PLACEHOLDER_CLASS }" data-index="${ index }"></div>`
    const renderedThinkBlock = `<div class="think-wrapper">${ md.render(thinkBlock) }</div>`
    renderedContent = renderedContent.replace(placeholder, renderedThinkBlock)
  })

  return renderedContent
}

// 触发 Mermaid 渲染
export const renderMermaidProcess = (callback = () => {}) => {
  renderMermaidSSE(callback)
}
