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

MCP 目前还是预留骨架，下一步可在 `src/mcp/client.ts` 中接入 Apifox MCP。
