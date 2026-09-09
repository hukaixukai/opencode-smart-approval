# OpenCode Smart Approval (智能审批与安全护栏系统)

<p align="center">
  <strong>专为 OpenCode CLI 打造的双 Agent 协同安全护栏与动态分层审批插件</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/OpenCode-Plugin-blue.svg" alt="OpenCode Plugin" />
  <img src="https://img.shields.io/badge/Language-TypeScript-3178C6.svg" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Runtime-Bun%20%7C%20Node.js-black.svg" alt="Runtime" />
  <img src="https://img.shields.io/badge/Parser-Tree--sitter%20Bash-green.svg" alt="Tree-sitter" />
  <img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="MIT License" />
</p>

---

## 📖 为什么需要 Smart Approval？

在使用 OpenCode 等终端 AI 编码智能体时，开发者普遍面临两难困境：
- ⚠️ **如果开启全局确认**：每一条微小的 `git status`、`ls`、`mkdir` 都会弹窗请求人类确认，极其打断专注力与心流体验；
- 🚨 **如果开启完全放行 (`--yes`)**：Agent 在执行复杂重构或遭遇幻觉时，可能意外执行 `rm -rf`、覆盖敏感配置文件（如 `~/.ssh`、`~/.config`）或破坏根文件系统，存在严重安全隐患。

**Smart Approval** 专为解决此痛点而设计。通过 **“模式 ➔ 空间 ➔ 权限”** 三层流式管控与 **双 Agent 监督机制**，实现：
> **白名单命令 0 弹窗极速放行** ｜ **危险操作直接硬核拦截** ｜ **未知灰度命令交由后台审核 Agent 智能研判**

---

## 🌟 核心特性

- 🛡️ **双 Agent 监督与沙箱隔离**：执行业务任务的 Agent 与后台负责安全审查的 Agent 隔离运行，审查进程采用只读租约（Guarded Reader），防止 Agent 逆向篡改安全策略文件。
- 🌳 **Tree-sitter AST 深度静态分析**：基于 WebAssembly 编译的 `tree-sitter-bash` 语法分析引擎，精确拆解复合命令、管道符（`|`）、逻辑控制符（`&&`、`;`）、重定向与环境变量替换，杜绝危险命令通过别名或包装混淆绕过。
- 🧭 **空间预设与路径隔离 (Path Spaces)**：支持按目录划定安全边界。例如：
  - `日常开发工作区 (~/workspace/**)`：支持常规构建与模块内安全删除；
  - `临时沙盒目录 (/tmp/**, ~/.cache/**)`：全自动放行；
  - `系统核心目录 (/etc/**, ~/.ssh/**, ~/.config/**)`：严格审计，任何修改必须人工审批。
- 🚦 **灰名单三态治理 (Undecided Strategy)**：
  - `ai_with_ask`：**AI 智能研判 + 拿不准问我**（默认推荐，安全则静默放行，高危才弹窗确认）；
  - `ai_only`：**纯 AI 全权打理**（适合无人值守临时沙箱，拿不准直接阻断，绝不弹窗）；
  - `ask_human`：**严格问我**（核心凭据区，非白名单一律弹窗确认）。
- 🖥️ **精美 TUI 快捷指令体系**：无需手动编辑复杂配置文件，终端直接交互。
- 🗣️ **自然语言生成模式**：使用 `/ae <需求>`，Agent 自动根据意图生成新空间、规则与模式，经 Schema 校验后原子落盘。

---

## 📐 架构设计

```text
                                  ┌────────────────────────┐
                                  │   用户业务提示词与任务  │
                                  └───────────┬────────────┘
                                              ▼
                                  ┌────────────────────────┐
                                  │  主智能体 (Task Agent)  │
                                  └───────────┬────────────┘
                                              │ 尝试执行 Shell 命令 / 工具调用
                                              ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           Smart Approval 安全拦截引擎                           │
│                                                                                 │
│   1. 命令静态展开 (Tree-sitter AST 解析子命令、管道、参数与目标文件)             │
│   2. 命中当前激活模式 (Active Mode) 与 空间映射 (Space Path Matcher)              │
│                                                                                 │
│         ┌─────────────────────────────────────────────────────────────┐         │
│         │                      权限预设规则匹配                       │         │
│         └───────┬─────────────────────────┬─────────────────────────┬─┘         │
│                 │ (白名单)                │ (黑名单)                │ (未定名单) │
│                 ▼                         ▼                         ▼           │
│         ┌──────────────┐          ┌──────────────┐          ┌─────────────────┐ │
│         │  直接放行    │          │  直接阻断    │          │   灰名单策略    │ │
│         │  (0 弹窗)    │          │  (安全保护)  │          │(ai_with_ask 等) │ │
│         └──────────────┘          └──────────────┘          └────────┬────────┘ │
└──────────────────────────────────────────────────────────────────────┼──────────┘
                                                                       │
                                              ┌────────────────────────┘
                                              ▼
                                  ┌────────────────────────┐
                                  │ 后台审查智能体         │
                                  │ (Reviewer Agent)       │
                                  │ 模型由 /am 自由指定     │
                                  └───────────┬────────────┘
                                              │ 结合上下文研判
                        ┌─────────────────────┴─────────────────────┐
                        ▼                                           ▼
                 [ 研判安全无危害 ]                          [ 存在风险 / 拿不准 ]
                        │                                           │
                        ▼                                           ▼
                 自动静默放行                                弹窗向人类提问确认
```

---

## 🚀 快速安装

### 方式一：一键安装脚本（推荐）

克隆本仓库到本地，并运行 `install.sh`：

```bash
git clone https://github.com/hukaixukai/opencode-smart-approval.git
cd opencode-smart-approval
bash install.sh
```

安装脚本将自动：
1. 备份已有插件（如有）；
2. 部署 `smart-approval.ts` 及其源码核心至 `~/.config/opencode/plugins/`；
3. 自动检测并安装 `bun` 或 `npm` 依赖包；
4. 引导重启 OpenCode 即刻启用。

### 方式二：手动安装

1. 将当前项目复制至 OpenCode 插件目录：
   ```bash
   mkdir -p ~/.config/opencode/plugins
   cp smart-approval.ts ~/.config/opencode/plugins/
   cp -r . ~/.config/opencode/plugins/smart-approval
   ```
2. 进入目录并安装依赖：
   ```bash
   cd ~/.config/opencode/plugins/smart-approval
   bun install --production
   # 或者使用 npm: npm install --omit=dev
   ```
3. 重启 OpenCode 即可生效。

---

## ⌨️ TUI 快捷指令指南

在 OpenCode 交互界面中，直接输入以下斜杠命令：

| 指令 | 说明 | 交互效果 |
| :--- | :--- | :--- |
| **`/am`** | **配置审查 AI 模型** | 弹出模型选择器，支持快捷切换后台负责安全把关的 LLM（如 Gemini、DeepSeek 等），仅 TUI 反馈，不污染主会话。 |
| **`/ae`** | **模式管理与规则查看** | 浏览模式列表，回车激活；对当前模式再次按回车可**分页下钻查看权限预设详情与空间映射**。 |
| **`/ae <需求>`** | **自然语言新增模式** | 例如：`/ae 新增学术模式，本地项目允许编辑，服务器只读，删除需问我`。由 Agent 自动设计并原子保存新方案。 |
| **`/an <需求>`** | **兼容版新增模式** | 针对部分不支持直接向 `/ae` 传参的 TUI 终端，功能与 `/ae <需求>` 完全等价。 |
| **`/ad`** | **安全删除模式** | 查看所有自定义模式；双击 `Ctrl+D` 触发防误删保护，受保护内置模式（`delegate`, `full_allow`）禁止删除。 |

---

## ⚙️ 模式与预设结构

插件会在首次运行时自动生成 `~/.config/opencode/command-approval.jsonc`。

### 三层核心配置逻辑

1. **模式 (Mode)**：全局顶层策略方案。
2. **空间映射 (Spaces)**：将具体的文件系统路径与权限预设绑定。未匹配路径落入 `other` 兜底空间。
3. **权限预设 (Presets)**：
   - `rules.allow`：白名单规则数组（支持正则与通配匹配）；
   - `rules.deny`：黑名单规则数组；
   - `undecided_strategy`：灰名单策略（`ai_with_ask` / `ai_only` / `ask_human`）；
   - `tools.allow` / `tools.deny`：MCP 或原生工具级别过滤。

```jsonc
{
  "$schema": "./schema/policy-v3.schema.json",
  "active_mode": "delegate",
  "modes": {
    "delegate": {
      "id": "delegate",
      "name": "替我审批模式",
      "spaces": [
        {
          "id": "main_workspace",
          "name": "主要工作空间",
          "paths": ["~/workspace/**", "./**"],
          "preset": "developer"
        },
        {
          "id": "system_root",
          "name": "系统敏感空间",
          "paths": ["/etc/**", "~/.ssh/**", "~/.config/**"],
          "preset": "strict_audit"
        }
      ],
      "other": { "preset": "developer" }
    }
  }
}
```

---

## 🔒 安全防护自保护原则

为了避免 Agent “自己批准自己”或“恶意篡改审核规则”，插件内置了多层自保护防护盾：
1. **策略只读保护**：`command-approval.jsonc` 对任何 Agent 均设置为物理只读，禁止 Agent 使用编辑工具、覆盖写入或删除它；
2. **结构化原子提交**：新增模式必须通过专用的 `approval_mode_create` 工具执行完整 Schema 校验、冲突规避与原子刷新；
3. **隔离审查会话**：后台安全判定在独立的上下文 Session 中运行，无权接触未授权上下文，保证研判独立客观。

---

## 🛠️ 技术栈与依赖

- **Language**：TypeScript
- **Runtime**：Bun / Node.js (ES Module)
- **Syntax Analysis**：`web-tree-sitter` + `tree-sitter-bash.wasm`
- **Validation**：`zod`
- **Host Integration**：`@opencode-ai/plugin`, `@opencode-ai/sdk`

---

## 🤝 参与贡献与致谢

欢迎提交 Issue 与 Pull Request！如果您有更好的安全规则建议或语法解析模式，请随时交流。

- **Author**: hukai ([@hukaixukai](https://github.com/hukaixukai))
- **Repository**: [https://github.com/hukaixukai/opencode-smart-approval](https://github.com/hukaixukai/opencode-smart-approval)
- **License**: [MIT License](LICENSE)
