import type MarkdownIt from 'markdown-it'
import PrismJsComponents from 'prismjs/components'

export interface Options {
  // 复制按钮的标题文本，当前文件里暂未直接使用，通常作为插件配置保留。
  codeCopyButtonTitle: string
  // 是否只使用单一主题：
  // true: 只输出基础类名，不附加自适应主题标记。
  // false: 额外附加 xx-adaptive-theme，便于在明暗主题之间切换样式。
  hasSingleTheme: boolean
}

// 将字符串首字母转成大写，用于代码块头部的语言名称展示。
// 例如：typescript -> Typescript。
function capitalizeFirstLetter(str) {
  return str.replace(/^\w/, (match) => match.toUpperCase())
}

// 根据代码块声明的语言名或别名，解析出更友好的展示名称。
// 这里借助 Prism 的语言元数据来拿到 title / alias / aliasTitles，
// 例如 ts -> TypeScript，js -> JavaScript。
const getBaseLanguageName = (nameOrAlias, components = PrismJsComponents) => {

  const _nameOrAlias = nameOrAlias.toLowerCase()

  const allLanguages = components.languages
  const allLanguageKeys = Object.keys(allLanguages)

  // 默认直接展示首字母大写后的原始语言名；
  // 如果下面能在语言表里查到更正式的名称，会覆盖这里的值。
  const lang = {
    value: capitalizeFirstLetter(nameOrAlias || 'markdown')
  }

  for (let index = 0; index < allLanguageKeys.length; index++) {
    const languageKey = allLanguageKeys[index]
    const languageItem = allLanguages[languageKey]

    const { title, alias, aliasTitles } = languageItem

    // 语言 key 直接命中，例如 typescript。
    if (languageKey === _nameOrAlias) {
      lang.value = title
      break
    }

    if (!alias) {
      continue
    }

    if (Array.isArray(alias)) {

      // 如果别名有专门的显示名，优先使用。
      if (aliasTitles && aliasTitles[_nameOrAlias]) {
        lang.value = aliasTitles[_nameOrAlias]
        break
      }

      // 否则命中别名数组时，退回主标题。
      if (alias.includes(_nameOrAlias)) {
        lang.value = title
        break
      }
    } else {
      // 单个别名场景。
      if (alias === _nameOrAlias) {
        lang.value = title
        break
      }
    }
  }

  return lang.value
}

export function preWrapperPlugin(md: MarkdownIt, options: Options) {
  // 保留 markdown-it 原本的 fence 渲染器，
  // 先让它完成标准代码块 HTML 输出，再在外层包一层自定义结构。
  const fence = md.renderer.rules.fence!
  md.renderer.rules.fence = (...args) => {
    const [tokens, idx] = args
    const token = tokens[idx]

    // 去掉 info 中形如 [title] 的标题声明，避免影响语言解析。
    token.info = token.info.replace(/\[.*\]/, '')

    // 检测代码块是否带 active 标记，并把这个状态透传到外层 class 上。
    const active = / active( |$)/.test(token.info) ? ' active' : ''
    token.info = token.info.replace(/ active$/, '').replace(/ active /, ' ')

    // 从 info 字段里提取规范化后的语言名。
    const lang = extractLang(token.info)

    // 调用原始 fence 渲染器，拿到 <pre><code>...</code></pre>。
    const content = fence(...args)

    // 在原始代码块外层再包一层结构，
    // 统一加上语言名、复制按钮、主题标记等 UI 能力。
    return (
      `
      <div class="markdown-code-wrapper flex language-${ lang }${ getAdaptiveThemeMarker(options) }${ active }">
        <div class="markdown-code-header">
          <span class="markdown-code-lang">${ getBaseLanguageName(lang) }</span>
          <button class="markdown-code-copy">
            <div class="markdown-copy-icon"></div>
            <span class="markdown-copy-text default">复制代码</span>
            <span class="markdown-copy-text done">已复制</span>
          </button>
        </div>
        ${ content }
      </div>
      `
    )
  }
}

export function getAdaptiveThemeMarker(options: Options) {
  // 单主题场景不追加额外 class；
  // 多主题场景追加标记类，供 CSS 根据主题做差异化控制。
  return options.hasSingleTheme ? '' : ' xx-adaptive-theme'
}

export function extractTitle(info: string, html = false) {
  if (html) {
    // 从 HTML 注释和 data-title 属性里提取标题。
    return (
      info.replace(/<!--[^]*?-->/g, '').match(/data-title="(.*?)"/)?.[1] || ''
    )
  }
  // 非 HTML 场景优先取 [title]，其次回退到语言名，最后兜底 txt。
  return info.match(/\[(.*)\]/)?.[1] || extractLang(info) || 'txt'
}

function extractLang(info: string) {
  return info
    .trim()
    // 去掉类似 =1 这类附加参数。
    .replace(/=(\d*)/, '')
    // 去掉行号相关配置，例如 :line-numbers。
    .replace(/:(no-)?line-numbers({| |$|=\d*).*/, '')
    // 去掉 -vue、{...} 或后续空格后的附加信息，只保留语言名主体。
    .replace(/(-vue|{| ).*$/, '')
    // 特殊兼容：vue-html 映射为 template。
    .replace(/^vue-html$/, 'template')
    // ansi 不作为语言名展示，清空处理。
    .replace(/^ansi$/, '')
}
