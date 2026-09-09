import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { parsePolicyJsonc, stripJsonComments } from "../core/policy-parser";
import { MasterApprovalConfigSchema, type MasterApprovalConfig } from "./master-schema";

export const MASTER_POLICY_FILE_NAME = "command-approval.jsonc";

export const globalPolicyPath = (): string => {
  const xdg = process.env["XDG_CONFIG_HOME"];
  const base = xdg && xdg.length > 0 ? join(xdg, "opencode") : join(homedir(), ".config", "opencode");
  return join(base, MASTER_POLICY_FILE_NAME);
};

export const localPolicyPath = (dir: string): string => join(dir, MASTER_POLICY_FILE_NAME);

export const effectivePolicyPath = (directory?: string): string => {
  const local = directory ? localPolicyPath(directory) : undefined;
  return local && existsSync(local) ? local : globalPolicyPath();
};

export function saveMasterPolicy(config: MasterApprovalConfig, directory?: string): void {
  const policyPath = effectivePolicyPath(directory);
  mkdirSync(join(policyPath, ".."), { recursive: true });
  writeFileSync(policyPath, JSON.stringify(config, null, 2));
}

export function saveMasterPolicyAtomic(config: MasterApprovalConfig, directory?: string): void {
  const parsed = MasterApprovalConfigSchema.parse(config);
  const policyPath = effectivePolicyPath(directory);
  mkdirSync(join(policyPath, ".."), { recursive: true });
  const temporaryPath = `${policyPath}.${randomUUID()}.write`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporaryPath, policyPath);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

export function loadReviewerModelStrict(directory?: string): string {
  const policyPath = effectivePolicyPath(directory);
  const raw = readFileSync(policyPath, "utf-8");
  const parsed = MasterApprovalConfigSchema.parse(parsePolicyJsonc(raw));
  const model = parsed.reviewer.model;
  if (typeof model !== "string" || model.trim().length === 0) {
    throw new Error("reviewer.model is required for live review");
  }
  return model;
}

export function createDefaultMasterConfig(): MasterApprovalConfig {
  return {
    version: 4,
    active_mode: "delegate",
    reviewer: {
      model: "cpa-vps/gemini-3.7-flash-high",
      timeout_ms: 45000,
      context_messages: 20,
      cleanup_session: true,
    },
    modes: {
      // 模式 1：替我审批模式
      "delegate": {
        id: "delegate",
        name: "替我审批模式",
        description: "常用开发区畅快通行，临时沙盒全权AI处理，系统敏感区严格审查",
        spaces: [
          {
            id: "main_workspace",
            name: "主要工作空间",
            paths: ["~/workspace/**", "$HOME/workspace/**", "./**"],
            preset: "developer",
            description: "日常开发区：常用构建命令全白名单，支持项目内删除",
          },
          {
            id: "sandbox_temp",
            name: "临时测试空间",
            paths: ["/tmp/**", "~/.cache/**"],
            preset: "full_power",
            description: "临时产物与缓存目录：极速放行，纯AI全权打理，绝不弹窗打扰",
          },
          {
            id: "system_root",
            name: "系统敏感空间",
            paths: ["/etc/**", "~/.ssh/**", "~/.config/**", "/root/**"],
            preset: "strict_audit",
            description: "核心配置与凭证目录：严格只读，灰名单指令必弹窗",
          },
        ],
        other: {
          preset: "developer",
        },
      },
      // 模式 2：完全允许模式
      "full_allow": {
        id: "full_allow",
        name: "完全允许模式",
        description: "全局全空间完全放行，零弹窗零阻断极速通行，仅拦截系统毁灭性指令",
        spaces: [
          {
            id: "global_all",
            name: "全局空间",
            paths: ["/**"],
            preset: "full_power",
            description: "全路径自动放行",
          },
        ],
        other: {
          preset: "full_power",
        },
      },
    },
    presets: {
      // 预设 A: 开发标准版 (包含白名单、黑名单、以及灰名单策略 undecided_strategy)
      "developer": {
        id: "developer",
        name: "开发标准预设",
        description: "覆盖主流包管理、构建、测试、运行、项目内删除，灰名单AI审核",
        undecided_strategy: "ai_with_ask", // 灰名单：AI智能研判 (安全放行，高危问我)
        tools: {
          allow: ["read", "glob", "grep", "list", "todowrite", "skill", "question"],
          deny: [],
        },
        rules: {
          allow: [
            { match: "git *", reason: "git 版本控制" },
            { match: "git", reason: "git 版本控制" },
            { match: "npm *", reason: "npm 包管理" },
            { match: "pnpm *", reason: "pnpm 包管理" },
            { match: "yarn *", reason: "yarn 包管理" },
            { match: "bun *", reason: "bun 包管理" },
            { match: "pip *", reason: "pip 包管理" },
            { match: "pip3 *", reason: "pip 包管理" },
            { match: "python *", reason: "python 运行" },
            { match: "python3 *", reason: "python 运行" },
            { match: "pytest *", reason: "测试" },
            { match: "cargo *", reason: "rust 构建" },
            { match: "go *", reason: "go 工具链" },
            { match: "node *", reason: "node 运行" },
            { match: "deno *", reason: "deno 运行" },
            { match: "tsc *", reason: "类型检查" },
            { match: "ruff *", reason: "lint" },
            { match: "flake8 *", reason: "lint" },
            { match: "black *", reason: "格式化" },
            { match: "mypy *", reason: "类型检查" },
            { match: "ls *", reason: "只读查看" },
            { match: "pwd", reason: "只读查看" },
            { match: "which *", reason: "只读查看" },
            { match: "echo *", reason: "输出" },
            { match: "cat *", reason: "只读查看" },
            { match: "head *", reason: "只读查看" },
            { match: "tail *", reason: "只读查看" },
            { match: "wc *", reason: "统计" },
            { match: "sort *", reason: "排序" },
            { match: "uniq *", reason: "去重" },
            { match: "find *", reason: "查找" },
            { match: "grep *", reason: "搜索" },
            { match: "rg *", reason: "搜索" },
            { match: "sed *", reason: "文本处理" },
            { match: "awk *", reason: "文本处理" },
            { match: "curl *", reason: "网络请求" },
            { match: "wget *", reason: "下载" },
            { match: "make *", reason: "构建" },
            { match: "cmake *", reason: "构建" },
            { match: "ctest *", reason: "测试" },
            { match: "tar *", reason: "压缩解压" },
            { match: "zip *", reason: "压缩" },
            { match: "unzip *", reason: "解压" },
            { match: "gzip *", reason: "压缩" },
            { match: "touch *", reason: "创建文件" },
            { match: "mkdir *", reason: "创建目录" },
            { match: "cp *", reason: "复制" },
            { match: "mv *", reason: "移动" },
            { match: "docker *", reason: "容器操作" },
            { match: "docker-compose *", reason: "容器编排" },
            { match: "ssh dev-server*", reason: "预设开发服务器" },
            { match: "^rm\\s[^;|&]*(~/workspace/|\\$HOME/workspace/|\\./)", reason: "工作空间内自由删除", scope: "command", priority: 100 },
          ],
          deny: [
            { match: "(^|[;&|]\\s*)rm\\s", reason: "工作空间外禁止删除", scope: "command", priority: 50 },
            { match: "rm -rf /", reason: "根目录毁灭性删除" },
            { match: "rm -rf ~", reason: "家目录毁灭性删除" },
            { match: "rm -rf $HOME", reason: "家目录毁灭性删除" },
            { match: "rm -rf ..", reason: "上级目录毁灭性删除" },
            { match: "mkfs.*", reason: "磁盘格式化" },
            { match: "dd if=* of=/dev/*", reason: "裸设备写入" },
            { match: "chmod -R 777 /", reason: "根目录权限破坏" },
            { match: "shutdown*", reason: "系统关机" },
            { match: "reboot", reason: "系统重启" },
            { match: "init 0", reason: "系统关机" },
          ],
        },
      },
      // 预设 B: 极速完全放行版
      "full_power": {
        id: "full_power",
        name: "极速放行预设",
        description: "全工具与命令白名单自动放行，仅拦截极少数致命系统故障",
        undecided_strategy: "ai_only", // 灰名单：纯 AI 处置 (绝不弹窗)
        tools: {
          allow: ["*"],
          deny: [],
        },
        rules: {
          allow: [
            { match: "*", reason: "完全放行" },
          ],
          deny: [
            { match: "rm -rf /", reason: "根目录毁灭性删除" },
            { match: "rm -rf ~", reason: "家目录毁灭性删除" },
            { match: "rm -rf $HOME", reason: "家目录毁灭性删除" },
            { match: "mkfs.*", reason: "磁盘格式化" },
            { match: "dd if=* of=/dev/*", reason: "裸设备写入" },
          ],
        },
      },
      // 预设 C: 严格只读审计版
      "strict_audit": {
        id: "strict_audit",
        name: "严格审计预设",
        description: "仅允许只读查看与搜索，禁止任何修改与删除，灰名单必问",
        undecided_strategy: "ask_human", // 灰名单：严格问人类 (未定必弹窗)
        tools: {
          allow: ["read", "glob", "grep", "list", "question"],
          deny: ["write", "edit", "apply_patch"],
        },
        rules: {
          allow: [
            { match: "git status*", reason: "git查看" },
            { match: "git diff*", reason: "git查看" },
            { match: "git log*", reason: "git查看" },
            { match: "ls *", reason: "只读查看" },
            { match: "pwd", reason: "只读查看" },
            { match: "cat *", reason: "只读查看" },
            { match: "grep *", reason: "搜索" },
            { match: "rg *", reason: "搜索" },
            { match: "find *", reason: "查找" },
            { match: "echo *", reason: "输出" },
          ],
          deny: [
            { match: "rm *", reason: "严格模式禁止删除" },
            { match: "git push*", reason: "严格模式禁止推送" },
            { match: "git commit*", reason: "严格模式禁止提交" },
            { match: "git reset*", reason: "严格模式禁止重置" },
          ],
        },
      },
    },
  };
}

export function loadMasterPolicy(directory?: string): MasterApprovalConfig {
  const chosenPath = effectivePolicyPath(directory);

  if (!existsSync(chosenPath)) {
    const defaultConfig = createDefaultMasterConfig();
    mkdirSync(join(chosenPath, ".."), { recursive: true });
    writeFileSync(chosenPath, JSON.stringify(defaultConfig, null, 2));
    return defaultConfig;
  }

  try {
    const raw = readFileSync(chosenPath, "utf-8");
    const json = parsePolicyJsonc(raw) as any;

    if (json.version === 3 || !json.modes || !json.presets) {
      const migrated = createDefaultMasterConfig();
      writeFileSync(chosenPath, JSON.stringify(migrated, null, 2));
      return migrated;
    }

    // 兼容历史 other/default_space 字段名
    for (const m of Object.values(json.modes || {})) {
      const mode = m as any;
      if (!mode.other && mode.default_space) {
        mode.other = { preset: mode.default_space.preset || "developer" };
        delete mode.default_space;
      }
    }

    const parsed = MasterApprovalConfigSchema.safeParse(json);
    if (parsed.success) {
      return parsed.data;
    }
    return createDefaultMasterConfig();
  } catch {
    return createDefaultMasterConfig();
  }
}
