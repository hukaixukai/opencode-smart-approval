#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR="${HOME}/.config/opencode/plugins"
PLUGIN_NAME="smart-approval"

echo "正在卸载 OpenCode Smart Approval 插件..."

if [ -f "${TARGET_DIR}/smart-approval.ts" ]; then
    rm -f "${TARGET_DIR}/smart-approval.ts"
    echo "✔ 已移除加载器: ${TARGET_DIR}/smart-approval.ts"
fi

if [ -d "${TARGET_DIR}/${PLUGIN_NAME}" ]; then
    rm -rf "${TARGET_DIR}/${PLUGIN_NAME}"
    echo "✔ 已移除插件目录: ${TARGET_DIR}/${PLUGIN_NAME}"
fi

echo "卸载完成。若不再需要策略配置，可手动检查: ~/.config/opencode/command-approval.jsonc"
