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

当前版本已新增订单图片 OCR 导入链路：

- `POST /api/order-import/upload-image`：上传单张订单图片的 base64 内容，先调用本地 OCR 服务识别文字，再交给文本模型解析成结构化订单
- `server\ocr_service\app.py`：本地 OCR 微服务脚本，默认监听 `http://127.0.0.1:18081`

启动本地 OCR 服务前，请先在 `server\ocr_service` 目录安装依赖：

```powershell
py -3.10 -m venv ".venv-ocr"
".\.venv-ocr\Scripts\Activate.ps1"
python -m pip install --upgrade pip
pip install -r ".\server\ocr_service\requirements.txt"
uvicorn app:app --host 127.0.0.1 --port 18081 --app-dir ".\server\ocr_service"
```

如果 OCR 服务地址和端口有调整，可在仓库根目录的环境变量中覆盖：

```env
LOCAL_OCR_BASE_URL=http://127.0.0.1:18081
LOCAL_OCR_TIMEOUT=120000
```

### 服务器常驻部署（systemd）

本地调试用上面的 `uvicorn` 前台命令即可；部署到服务器（例如 `/var/www/server/ocr_service`）时，用 `deploy` 目录下的一键脚本注册为 systemd 服务，实现开机自启与进程崩溃自动拉起：

```bash
sudo bash /var/www/server/ocr_service/deploy/install-service.sh
```

脚本会自动完成：自动探测可用的 Python 解释器（`paddlepaddle==2.6.2` 只提供 3.8 ~ 3.12 的预编译包，按 3.11 → 3.10 → 3.12 → 3.9 → 3.8 → 系统 `python3` 的顺序挑选）→ 创建 `.venv-ocr` 虚拟环境 → 安装 `requirements.txt` 依赖 → 渲染并安装 `ocr-service.service` → 启动服务并探活 `/health`。

可用环境变量覆盖默认行为：

```bash
# 指定端口、解释器与冷启动等待时间（PYTHON_BIN 留空即自动探测）
sudo OCR_PORT=18081 PYTHON_BIN=python3.10 BOOT_WAIT_SECONDS=600 bash /var/www/server/ocr_service/deploy/install-service.sh
```

说明：

- `BOOT_WAIT_SECONDS` 默认是 `600`，用于覆盖首次模型下载或 OCR 引擎初始化较慢的场景
- `OCR_HOST=::` 或其他 IPv6 地址时，脚本会自动按 IPv6 URL 规则探活，无需手动改健康检查地址

若服务器上所有解释器都不在 3.8 ~ 3.12 范围内，脚本会列出检测到的版本并退出。此时先装一个可用版本再重试：

```bash
# Ubuntu / Debian
sudo apt install python3.11 python3.11-venv
# CentOS / RHEL / Rocky
sudo yum install python3.11
```

常用运维命令：

```bash
systemctl status ocr-service      # 查看状态
journalctl -u ocr-service -f      # 查看实时日志
systemctl restart ocr-service     # 重启
```

注意：`install-service.sh` 与 `ocr-service.service` 必须是 LF 换行。若在 Windows 上编辑过再上传，先执行 `sed -i 's/\r$//' /var/www/server/ocr_service/deploy/*` 转换。

首次拉起前，请确认执行过：

```powershell
pnpm --dir server install
```

并且 `server\package.json` 中新增的 `@modelcontextprotocol/sdk` 已安装完成。
