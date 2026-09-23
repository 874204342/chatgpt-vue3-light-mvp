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
#   PYTHON_BIN=python3.11  显式指定解释器；不填则自动探测 3.11/3.10/3.12/3.9/3.8
#   SKIP_DEPS=1            跳过依赖安装（仅重装/更新 systemd 服务时使用）
#   BOOT_WAIT_SECONDS=600  启动后最长等待秒数，覆盖首次模型下载/初始化慢的场景
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
# 留空表示自动探测（见 detect_python）
PYTHON_BIN="${PYTHON_BIN:-}"
SKIP_DEPS="${SKIP_DEPS:-0}"
BOOT_WAIT_SECONDS="${BOOT_WAIT_SECONDS:-600}"
BOOT_WAIT_INTERVAL_SECONDS=2

# 监听 0.0.0.0 / :: 时，探活改用同协议的回环地址
PROBE_HOST="${OCR_HOST}"
if [[ "${PROBE_HOST}" == "0.0.0.0" ]]; then
  PROBE_HOST="127.0.0.1"
fi
if [[ "${PROBE_HOST}" == "::" ]]; then
  PROBE_HOST="::1"
fi

format_host_for_url() {
  if [[ "$1" == *:* && "$1" != \[*\] ]]; then
    printf '[%s]\n' "$1"
    return 0
  fi
  printf '%s\n' "$1"
}

PROBE_HOST_FOR_URL="$(format_host_for_url "${PROBE_HOST}")"
HEALTH_URL="http://${PROBE_HOST_FOR_URL}:${OCR_PORT}/health"
BOOT_WAIT_ATTEMPTS=$(( (BOOT_WAIT_SECONDS + BOOT_WAIT_INTERVAL_SECONDS - 1) / BOOT_WAIT_INTERVAL_SECONDS ))

log() { echo "[${SERVICE_NAME}] $*"; }

# ---------- 0. 前置校验 ----------
if [[ "${EUID}" -ne 0 ]]; then
  log "需要 root 权限写入 ${UNIT_TARGET}，请使用 sudo 执行本脚本" >&2
  exit 1
fi

# 服务以“执行 sudo 的那个用户”身份运行，避免 root 跑业务进程
RUN_USER="${SUDO_USER:-$(id -un)}"
RUN_GROUP="$(id -gn "${RUN_USER}")"

# paddlepaddle 2.6.2 只发布了 cp38 ~ cp312 的 wheel，3.13+ 需要源码编译，这里不做支持
SUPPORTED_PY_VERSIONS=("3.8" "3.9" "3.10" "3.11" "3.12")
# 自动探测时的优先级：与本地已验证通过的 3.11 环境保持一致
PY_CANDIDATES=("python3.11" "python3.10" "python3.12" "python3.9" "python3.8" "python3" "python")

py_version_of() {
  "$1" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || true
}

is_supported_version() {
  local target
  for target in "${SUPPORTED_PY_VERSIONS[@]}"; do
    [[ "$1" == "${target}" ]] && return 0
  done
  return 1
}

# 输出可用的解释器命令；显式指定 PYTHON_BIN 时只校验它自己
detect_python() {
  local candidates=("${PY_CANDIDATES[@]}")
  local candidate version
  if [[ -n "${PYTHON_BIN}" ]]; then
    candidates=("${PYTHON_BIN}")
  fi

  for candidate in "${candidates[@]}"; do
    command -v "${candidate}" >/dev/null 2>&1 || continue
    version="$(py_version_of "${candidate}")"
    if is_supported_version "${version}"; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done
  return 1
}

DETECTED_PYTHON="$(detect_python || true)"
if [[ -z "${DETECTED_PYTHON}" ]]; then
  log "未找到可用的 Python 解释器（paddlepaddle==2.6.2 仅提供 3.8 ~ 3.12 的预编译包）" >&2
  log "服务器上检测到的解释器：" >&2
  for candidate in "${PY_CANDIDATES[@]}"; do
    if command -v "${candidate}" >/dev/null 2>&1; then
      log "  ${candidate} -> Python $(py_version_of "${candidate}")" >&2
    fi
  done
  log "处理方式：安装 3.10 / 3.11（Ubuntu: sudo apt install python3.11 python3.11-venv）后重试，" >&2
  log "或指定已有版本：PYTHON_BIN=python3.10 sudo -E bash $0" >&2
  exit 1
fi

PYTHON_BIN="${DETECTED_PYTHON}"
PY_VERSION="$(py_version_of "${PYTHON_BIN}")"
log "使用解释器：${PYTHON_BIN}（Python ${PY_VERSION}）"

# ---------- 1. 准备虚拟环境与依赖 ----------
# 目录存在但缺少 bin/python，说明是 Windows 上创建后整体拷贝过来的，不能直接用
if [[ -d "${VENV_DIR}" && ! -x "${VENV_DIR}/bin/python" ]]; then
  log "${VENV_DIR} 不是可用的 Linux 虚拟环境，请先删除后重试：rm -rf ${VENV_DIR}" >&2
  exit 1
fi

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
log "等待服务就绪（最长 ${BOOT_WAIT_SECONDS} 秒，首次可能需要下载/初始化 OCR 模型）"
READY=0
for _ in $(seq 1 "${BOOT_WAIT_ATTEMPTS}"); do
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
  sleep "${BOOT_WAIT_INTERVAL_SECONDS}"
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
