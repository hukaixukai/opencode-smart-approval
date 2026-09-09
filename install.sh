#!/usr/bin/env bash
set -euo pipefail

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}====================================================${NC}"
echo -e "${BLUE}    OpenCode Smart Approval Plugin Installer         ${NC}"
echo -e "${BLUE}====================================================${NC}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${HOME}/.config/opencode/plugins"
PLUGIN_NAME="smart-approval"

echo -e "\n${YELLOW}[1/4]${NC} 检查安装目录环境..."
mkdir -p "${TARGET_DIR}"

echo -e "${YELLOW}[2/4]${NC} 备份已有版本（如果存在）..."
if [ -d "${TARGET_DIR}/${PLUGIN_NAME}" ] || [ -f "${TARGET_DIR}/smart-approval.ts" ]; then
    BACKUP_NAME="backup_${PLUGIN_NAME}_$(date +%Y%m%d%H%M%S)"
    echo -e "发现旧版本，自动备份到: ${TARGET_DIR}/${BACKUP_NAME}"
    mkdir -p "${TARGET_DIR}/${BACKUP_NAME}"
    [ -d "${TARGET_DIR}/${PLUGIN_NAME}" ] && cp -r "${TARGET_DIR}/${PLUGIN_NAME}" "${TARGET_DIR}/${BACKUP_NAME}/"
    [ -f "${TARGET_DIR}/smart-approval.ts" ] && cp "${TARGET_DIR}/smart-approval.ts" "${TARGET_DIR}/${BACKUP_NAME}/"
fi

echo -e "${YELLOW}[3/4]${NC} 同步插件源码与加载器..."
rm -rf "${TARGET_DIR}/${PLUGIN_NAME}"
mkdir -p "${TARGET_DIR}/${PLUGIN_NAME}"

# 拷贝插件主体文件
cp -r "${SCRIPT_DIR}/src" "${TARGET_DIR}/${PLUGIN_NAME}/"
cp -r "${SCRIPT_DIR}/presets" "${TARGET_DIR}/${PLUGIN_NAME}/"
[ -d "${SCRIPT_DIR}/assets" ] && cp -r "${SCRIPT_DIR}/assets" "${TARGET_DIR}/${PLUGIN_NAME}/"
cp "${SCRIPT_DIR}/package.json" "${TARGET_DIR}/${PLUGIN_NAME}/"
cp "${SCRIPT_DIR}/tsconfig.json" "${TARGET_DIR}/${PLUGIN_NAME}/"
[ -f "${SCRIPT_DIR}/bun.lock" ] && cp "${SCRIPT_DIR}/bun.lock" "${TARGET_DIR}/${PLUGIN_NAME}/"
[ -f "${SCRIPT_DIR}/README.md" ] && cp "${SCRIPT_DIR}/README.md" "${TARGET_DIR}/${PLUGIN_NAME}/"
[ -f "${SCRIPT_DIR}/LICENSE" ] && cp "${SCRIPT_DIR}/LICENSE" "${TARGET_DIR}/${PLUGIN_NAME}/"

# 拷贝加载器入口 smart-approval.ts 到 plugins/ 根目录
cp "${SCRIPT_DIR}/smart-approval.ts" "${TARGET_DIR}/smart-approval.ts"

echo -e "${YELLOW}[4/4]${NC} 安装运行依赖..."
cd "${TARGET_DIR}/${PLUGIN_NAME}"
if command -v bun &> /dev/null; then
    echo "使用 Bun 安装生产依赖..."
    bun install --production
elif command -v npm &> /dev/null; then
    echo "使用 npm 安装生产依赖..."
    npm install --omit=dev
else
    echo -e "${RED}[警告] 未找到 bun 或 npm，请进入 ${TARGET_DIR}/${PLUGIN_NAME} 手动安装依赖。${NC}"
fi

echo -e "\n${GREEN}====================================================${NC}"
echo -e "${GREEN}✔ 智能审批插件安装成功！${NC}"
echo -e "${GREEN}====================================================${NC}"
echo -e "操作指引："
echo -e "  1. 请重启 OpenCode 以加载插件。"
echo -e "  2. 在 OpenCode 终端中输入 ${BLUE}/ae${NC} 可查看并切换审批模式。"
echo -e "  3. 输入 ${BLUE}/am${NC} 可选择安全审查后台模型。"
echo -e "  4. 输入 ${BLUE}/ae <需求>${NC} 可让 Agent 为您快速新增定制模式。"
echo -e "祝您使用愉快！\n"
