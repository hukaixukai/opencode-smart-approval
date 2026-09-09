import { z } from "zod";

/**
 * 灰名单（未定名单：既不在明确白名单也不在黑名单的指令/工具调用）的三种处理策略：
 * 1. "ai_with_ask": AI 智能研判 + 拿不准问人类 (常规操作 AI 静默放行；仅 AI 判定高危或拿不准时弹窗向主人确认) [默认推荐]
 * 2. "ai_only": 纯 AI 全权打理 (AI 评估安全直接放行，AI 判定高危或拿不准时直接拒绝，绝不弹窗打扰人类)
 * 3. "ask_human": 严格问人类 (只要不在白名单内，不经 AI 预判，一律弹窗请主人亲自确认)
 */
export type UndecidedStrategy = "ai_with_ask" | "ai_only" | "ask_human";

export const UndecidedStrategySchema = z.enum(["ai_with_ask", "ai_only", "ask_human"]);

/**
 * 规则项定义
 */
export interface RuleItem {
  match: string;
  reason?: string;
  scope?: "command" | "segment";
  priority?: number;
}

export const RuleItemSchema = z.object({
  match: z.string().min(1),
  reason: z.string().optional(),
  scope: z.enum(["command", "segment"]).optional(),
  priority: z.number().int().optional(),
});

/**
 * 权限预设 (Permission Preset)：
 * 完整包含指令与工具权限（白名单、黑名单、以及灰名单/未定名单处置策略）
 */
export interface PermissionPreset {
  id: string;
  name: string;
  description?: string;
  // 灰名单（未定名单）处理策略，归入权限预设内
  undecided_strategy: UndecidedStrategy;
  // 工具级别权限控制 (read, edit, write, webfetch, task 等)
  tools?: {
    allow?: string[];
    deny?: string[];
  };
  // 终端命令级别控制 (黑白名单规则)
  rules: {
    allow: RuleItem[];
    deny: RuleItem[];
  };
}

export const PermissionPresetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  undecided_strategy: UndecidedStrategySchema.default("ai_with_ask"),
  tools: z.object({
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
  }).optional(),
  rules: z.object({
    allow: z.array(RuleItemSchema).default([]),
    deny: z.array(RuleItemSchema).default([]),
  }),
});

/**
 * 空间预设 / 路径空间设置 (Space Definition)：
 * 纯粹的路径范畴与权限预设绑定
 */
export interface SpaceDefinition {
  id: string;
  name: string;
  // 匹配的路径模式列表 (如 ["~/workspace/**", "./**"])
  paths: string[];
  // 该路径空间绑定的权限预设 ID (指向 presets 中的预设)
  preset: string;
  description?: string;
}

export const SpaceDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1),
  preset: z.string().min(1),
  description: z.string().optional(),
});

/**
 * 模式方案 (Mode)：
 * 包装一组空间路径划分，以及未匹配路径时的 other 兜底设置
 */
export interface ApprovalMode {
  id: string;
  name: string;
  description?: string;
  // 模式下启用的空间路径列表 (按顺序优先匹配)
  spaces: SpaceDefinition[];
  // 兜底空间 (other)，当路径未命中上方任何具体空间时生效
  other: {
    preset: string;
  };
}

export const ApprovalModeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  spaces: z.array(SpaceDefinitionSchema).default([]),
  // 统一命名为 other
  other: z.object({
    preset: z.string().min(1).default("developer"),
  }).default({ preset: "developer" }),
});

/**
 * 顶层配置 Schema (V4 Master Config)
 */
export interface MasterApprovalConfig {
  version: 4;
  active_mode: string;
  reviewer: {
    model?: string;
    timeout_ms?: number;
    context_messages?: number;
    cleanup_session?: boolean;
  };
  modes: Record<string, ApprovalMode>;
  presets: Record<string, PermissionPreset>;
}

export const MasterApprovalConfigSchema = z.object({
  version: z.literal(4),
  active_mode: z.string().min(1).default("delegate"),
  reviewer: z.object({
    model: z.string().optional(),
    timeout_ms: z.number().int().min(1000).max(300000).default(45000),
    context_messages: z.number().int().min(0).max(200).default(20),
    cleanup_session: z.boolean().default(true),
  }).default({}),
  modes: z.record(z.string(), ApprovalModeSchema),
  presets: z.record(z.string(), PermissionPresetSchema),
});
