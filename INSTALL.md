# Smart Approval 安装说明

## 适用版本

本压缩包适用于支持 OpenCode 插件的环境。插件只修改自己的配置和运行逻辑，不修改 OpenCode 官方源码。

## 安装

1. 备份已有的 `~/.config/opencode/plugins/smart-approval.ts` 和 `~/.config/opencode/plugins/smart-approval/`。
2. 将压缩包解压到 `~/.config/opencode/`，保持以下目录结构：

   ```text
   ~/.config/opencode/
   └── plugins/
       ├── smart-approval.ts
       └── smart-approval/
           ├── package.json
           ├── src/
           ├── assets/
           └── presets/
   ```

3. 进入插件目录安装运行依赖：

   ```bash
   cd ~/.config/opencode/plugins/smart-approval
   bun install --production
   ```

   也可以使用 npm：

   ```bash
   npm install --omit=dev
   ```

4. 重启 OpenCode。

## 首次使用

- 插件会使用 `~/.config/opencode/command-approval.jsonc` 作为审批配置；不存在时会创建默认配置。
- 使用 `/ae` 查看并切换审批模式。
- 使用 `/am` 切换审核模型。
- 使用 `/ae <需求>` 让 Agent 创建新模式。创建后需要重启 OpenCode 才会载入新模式。
- 使用 `/ad` 删除非内置、非当前生效模式。

## 依赖与兼容

- 运行依赖由插件目录中的 `package.json` 管理：`@opencode-ai/plugin`、`web-tree-sitter` 和 `zod`。
- 不要把本机的 `command-approval.jsonc`、OpenCode 配置、日志或 `node_modules` 打进发布包。
- `command-approval.jsonc` 可被 Agent 读取作为参考，但不能被 Agent 编辑、覆盖、移动或删除。

## 故障排查

- 插件没有加载：确认 `plugins/smart-approval.ts` 和 `plugins/smart-approval/src/index.ts` 都存在，并重启 OpenCode。
- 依赖错误：在 `plugins/smart-approval` 目录重新执行 `bun install --production`。
- 需要临时停用：设置 `OPENCODE_DISABLE_SMART_APPROVAL=1` 后重启 OpenCode。
- 加载错误日志：`~/.config/opencode/smart-approval.error.log`。
