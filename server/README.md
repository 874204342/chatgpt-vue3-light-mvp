# server

当前目录是为 `chatgpt-vue3-light-mvp` 新增的本地后端骨架。

## 作用

- 由后端代管 DeepSeek Key，避免前端直接暴露密钥
- 接收前端 `messages`，再转发到大模型接口
- 预留 MCP 接入点，后续可在服务端执行 Apifox 等工具
- 继续以 SSE 方式把模型结果流式返回给前端

## 目录

- `src/index.ts`：启动 Fastify 服务
- `src/routes/chat.ts`：聊天接口与 SSE 转发
- `src/llm/deepseek.ts`：DeepSeek 上游请求封装
- `src/mcp/client.ts`：MCP 接入预留位置
- `src/tools/weather.ts`：内置天气查询（Open-Meteo，无需 Key）
- `src/types/chat.ts`：聊天相关类型

## 启动方式

1. 安装依赖

```powershell
pnpm --dir server install
```

2. 启动本地后端

```powershell
pnpm dev:server
```

3. 启动前端

```powershell
pnpm dev
```

## 环境变量

后端会优先读取仓库根目录下的：

- `.\.env.local`
- `.\.env`

可用变量：

```env
DEEPSEEK_API_KEY=你的真实key
DEEPSEEK_BASE_URL=https://newapi.jubocloud.com
LOCAL_AI_SERVER_PORT=3001
```

如果没有单独配置 `DEEPSEEK_API_KEY`，后端会回退读取 `VITE_DEEPSEEK_KEY`。

## 当前状态

当前版本已经打通：

- 前端 -> 本地后端
- 本地后端 -> DeepSeek
- SSE 流式透传

当前版本已经加入 Apifox MCP 的读取与调用骨架，默认读取：

- `server\mcp.config.json`

当前版本还内置了天气查询能力：当用户问题命中天气类关键词时，服务端会调用 Open-Meteo 免费接口（无需 API Key）查询实时天气与未来三天预报，并以 system message 注入给模型。

当前版本也已支持订单 Excel 导入预解析：

- `GET /api/order-import/template`：下载 `server\src\excelTemplate\需切成品模板.xlsx`
- `POST /api/order-import/upload-preview`：上传 Excel 的 base64 内容，返回有效订单、异常行与汇总信息
- `POST /api/order-import/list`：查询本地 mock 订单
- `POST /api/order-import/category-summary`：查询本地 mock 订单的品类与厚度汇总

Excel 导入链路默认会先做字段识别、规格解析、数量校验、异常行提示与重复规格合并，确认有效数据后再进入前端现有的排版生成流程。当前已兼容模板中的 `自编号`、`流程卡号`、`架号`、`加工要求`、`备注`、`特殊工艺` 与业务文本型 `磨边等级`。

首次拉起前，请确认执行过：

```powershell
pnpm --dir server install
```

并且 `server\package.json` 中新增的 `@modelcontextprotocol/sdk` 已安装完成。
