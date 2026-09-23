#!/usr/bin/env bash
#
# 本地 OCR 服务一键部署脚本（systemd 常驻）
#
# 用法（在服务器上，用 root 或 sudo 执行）：
#   sudo bash /var/www/server/ocr_service/deploy/install-service.sh
#
# 可选环境变量：
#   OCR_HOST=127.0.0.1     监听地址
#   OCR_PORT=18081         监听端口
#   PYTHON_BIN=python3.11  用于创建虚拟解释器的 python
#   SKIP_DEPS=1            跳过依赖安装（仅重装/更新 systemd 服务时使用）
#
set -euo pipefail

SERVICE_NAME="ocr-service"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OCR_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
VENV_DIR="${OCR_DIR}/.venv-ocr"
CACHE_DIR="${OCR_DIR}/.paddlex-cache"
REQ_FILE="${OCR_DIR}/requirements.txt"
UNIT_TEMPLATE="${SCRIPT_DIR}/${SERVICE_NAME}.service"
UNIT_TARGET="/etc/systemd/system/${SERVICE_NAME}.service"

OCR_HOST="${OCR_HOST:-127.0.0.1}"
OCR_PORT="${OCR_PORT:-18081}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
SKIP_DEPS="${SKIP_DEPS:-0}"

# 监听 0.0.0.0 / :: 时，探活改用回环地址
PROBE_HOST="${OCR_HOST}"
if [[ "${PROBE_HOST}" == "0.0.0.0" || "${PROBE_HOST}" == "::" ]]; then
  PROBE_HOST="127.0.0.1"
fi
HEALTH_URL="http://${PROBE_HOST}:${OCR_PORT}/health"

log() { echo "[${SERVICE_NAME}] $*"; }

# ---------- 0. 前置校验 ----------
if [[ "${EUID}" -ne 0 ]]; then
  log "需要 root 权限写入 ${UNIT_TARGET}，请使用 sudo 执行本脚本" >&2
  exit 1
fi

# 服务以“执行 sudo 的那个用户”身份运行，避免 root 跑业务进程
RUN_USER="${SUDO_USER:-$(id -un)}"
RUN_GROUP="$(id -gn "${RUN_USER}")"

if ! command -v "${PYTHON_BIN}" >/dev/null 2>&1; then
  log "未找到 ${PYTHON_BIN}，请先安装 Python 3.10 / 3.11" >&2
  exit 1
fi

# paddlepaddle 2.6.2 只提供 cp310 / cp311 轮子，其余版本会编译失败
PY_VERSION="$("${PYTHON_BIN}" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
if [[ "${PY_VERSION}" != "3.10" && "${PY_VERSION}" != "3.11" ]]; then
  log "当前 Python 版本为 ${PY_VERSION}，requirements 中的 paddlepaddle==2.6.2 仅支持 3.10 / 3.11" >&2
  log "可通过 PYTHON_BIN=python3.11 sudo -E bash $0 指定解释器" >&2
  exit 1
fi

# ---------- 1. 准备虚拟环境与依赖 ----------
if [[ ! -x "${VENV_DIR}/bin/python" ]]; then
  log "创建虚拟环境：${VENV_DIR}"
  "${PYTHON_BIN}" -m venv "${VENV_DIR}"
fi

if [[ "${SKIP_DEPS}" != "1" ]]; then
  log "安装 Python 依赖（首次较慢，请耐心等待）"
  "${VENV_DIR}/bin/python" -m pip install --upgrade pip
  "${VENV_DIR}/bin/python" -m pip install -r "${REQ_FILE}"
fi

if [[ ! -x "${VENV_DIR}/bin/uvicorn" ]]; then
  log "未找到 uvicorn，请去掉 SKIP_DEPS=1 重新执行以安装依赖" >&2
  exit 1
fi

# 模型缓存目录由 app.py 自动创建，这里提前建好并授权，避免服务运行时写入失败
mkdir -p "${CACHE_DIR}"
chown -R "${RUN_USER}:${RUN_GROUP}" "${VENV_DIR}" "${CACHE_DIR}"
log "运行用户：${RUN_USER}:${RUN_GROUP}"

# ---------- 2. 生成并安装 systemd 服务 ----------
log "生成 ${UNIT_TARGET}"
# 「s/\r$//」用于兜底：模板若被 Windows 编辑器改回 CRLF，systemd 会解析失败
sed \
  -e "s/\r$//" \
  -e "s#__RUN_USER__#${RUN_USER}#g" \
  -e "s#__RUN_GROUP__#${RUN_GROUP}#g" \
  -e "s#__OCR_DIR__#${OCR_DIR}#g" \
  -e "s#__VENV_DIR__#${VENV_DIR}#g" \
  -e "s#__OCR_HOST__#${OCR_HOST}#g" \
  -e "s#__OCR_PORT__#${OCR_PORT}#g" \
  "${UNIT_TEMPLATE}" > "${UNIT_TARGET}"
chmod 644 "${UNIT_TARGET}"

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}" >/dev/null
systemctl restart "${SERVICE_NAME}"

# ---------- 3. 健康检查 ----------
log "等待服务就绪（首次需加载 / 下载 OCR 模型）"
READY=0
for _ in $(seq 1 90); do
  # 用 venv 内的 Python 做探活，避免依赖服务器上是否安装 curl
  if "${VENV_DIR}/bin/python" -c "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('${HEALTH_URL}', timeout=3).status == 200 else 1)" >/dev/null 2>&1; then
    READY=1
    break
  fi
  if ! systemctl is-active --quiet "${SERVICE_NAME}"; then
    log "服务已退出，最近日志如下：" >&2
    journalctl -u "${SERVICE_NAME}" -n 50 --no-pager >&2 || true
    exit 1
  fi
  sleep 2
done

if [[ "${READY}" != "1" ]]; then
  log "健康检查超时，请查看：journalctl -u ${SERVICE_NAME} -f" >&2
  exit 1
fi

log "部署完成，健康检查通过：${HEALTH_URL}"
log "常用命令："
log "  systemctl status ${SERVICE_NAME}"
log "  journalctl -u ${SERVICE_NAME} -f"
log "  systemctl restart ${SERVICE_NAME}"
