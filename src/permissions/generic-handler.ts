import { statSync } from "node:fs";
import { effectivePolicyPath, loadMasterPolicy } from "./master-config";
import { resolveSpaceForPath, type MatchedSpaceResult } from "./space-matcher";
import { evaluateRulesFromAnalysis } from "../core/rules";
import { analyzeShell } from "../core/shell-analysis";
import { scanWithTirith, verdictFromTirithScan } from "../core/risk-tool";
import { createMonotonicDeadline } from "../core/bounded-race";
import { reviewDecisionWithContext } from "../core/session-context";
import { applyReviewAuthorizationConsistency } from "../core/decision-pipeline";
import type { OpenCodeReviewerRuntime } from "../core/opencode-reviewer";
import type { GenericPermissionRequest } from "./types";
import type { CommandRule, ResolvedPolicy } from "../core/types";

type PermissionHandlerOptions = {
  readonly scanWithTirith?: typeof scanWithTirith;
};

/**
 * 编译 Preset 中的 allow/deny 规则为引擎可用的正则规则对象
 */
function compilePresetRules(presetRules: { allow: any[]; deny: any[] }): CommandRule[] {
  const rules: CommandRule[] = [];
  for (const item of presetRules.deny || []) {
    try {
      rules.push({
        label: `preset.deny:${item.match}`,
        match: item.match,
        decision: "block",
        scope: item.scope || "segment",
        priority: item.priority ?? 50,
        origin: "user",
        regex: new RegExp(item.match.includes("*") ? `^${item.match.replace(/\*/g, ".*")}$` : `^${item.match}$`),
        reason: item.reason,
      });
    } catch {}
  }
  for (const item of presetRules.allow || []) {
    try {
      rules.push({
        label: `preset.allow:${item.match}`,
        match: item.match,
        decision: "allow",
        scope: item.scope || "segment",
        priority: item.priority ?? 10,
        origin: "user",
        regex: new RegExp(item.match.includes("*") ? `^${item.match.replace(/\*/g, ".*")}$` : `^${item.match}$`),
        reason: item.reason,
      });
    } catch {}
  }
  return rules;
}

/**
 * 重构后的全能通用权限处理器：
 * 1. 空间路径匹配 (Space Routing) -> 找到该空间绑定的 Preset 与 UndecidedStrategy
 * 2. 黑名单匹配 -> 立即拦截 (Deny)
 * 3. 白名单匹配 -> 立即放行 (Allow)
 * 4. 未定名单 -> 根据该空间的 strategy 处理：
 *    - "ai_only": 纯 AI 判定，AI 允许则放行，否则拦截 (永不弹窗)
 *    - "ai_with_ask": AI 先判，AI 允许则放行，AI 判定高危或拿不准时弹窗问人类
 *    - "ask_human": 不经 AI，直接弹窗问人类
 */
export function createGenericPermissionHandler(
  directory: string,
  reviewerRuntimeProvider?: () => OpenCodeReviewerRuntime | undefined,
  options: PermissionHandlerOptions = {},
) {
  const runRiskScan = options.scanWithTirith ?? scanWithTirith;
  let masterConfig = loadMasterPolicy(directory);
  let spaceResolution: MatchedSpaceResult = resolveSpaceForPath(masterConfig, directory);
  let compiledRules = compilePresetRules(spaceResolution.preset.rules);
  let policySignature = "";

  function currentPolicySignature(): string {
    const policyPath = effectivePolicyPath(directory);
    const stat = statSync(policyPath, { bigint: true });
    return `${policyPath}:${stat.mtimeNs}:${stat.size}`;
  }

  function refreshPolicy(force = false): void {
    const signature = currentPolicySignature();
    if (!force && signature === policySignature) return;

    masterConfig = loadMasterPolicy(directory);
    spaceResolution = resolveSpaceForPath(masterConfig, directory);
    compiledRules = compilePresetRules(spaceResolution.preset.rules);
    policySignature = signature;
  }

  refreshPolicy(true);

  function normalizeResources(req: GenericPermissionRequest): string[] {
    const resources: string[] = [];
    if (req.pattern) {
      if (typeof req.pattern === "string") resources.push(req.pattern);
      else resources.push(...req.pattern);
    }
    const meta = req.metadata ?? {};
    for (const key of ["filePath", "path", "file", "command", "query", "url", "tool", "args"]) {
      const v = (meta as any)[key];
      if (typeof v === "string" && v.length > 0) resources.push(v);
      else if (Array.isArray(v)) {
        for (const item of v) if (typeof item === "string") resources.push(item);
      }
    }
    if (req.title && req.title.length > 0 && req.title !== req.type) {
      resources.push(req.title);
    }
    return [...new Set(resources)];
  }

  function isBashPermission(req: GenericPermissionRequest): boolean {
    return req.type === "bash" || req.type === "shell" || req.type === "external_directory";
  }

  function isFilePermission(req: GenericPermissionRequest): boolean {
    return ["read", "edit", "write", "glob", "grep", "list", "external_directory"].includes(req.type);
  }

  async function evaluateWithCompiledRules(commandLike: string): Promise<"allow" | "deny" | "undecided"> {
    try {
      const analysis = await analyzeShell(commandLike, directory).catch(() => undefined);
      if (analysis) {
        const evalResult = evaluateRulesFromAnalysis(compiledRules, commandLike, analysis);
        if (evalResult.matchedRules.length > 0) {
          if (evalResult.decision === "block") return "deny";
          if (evalResult.decision === "allow") return "allow";
        }
      }
    } catch {}

    for (const rule of compiledRules) {
      try {
        if (rule.regex.test(commandLike)) {
          if (rule.decision === "block") return "deny";
          if (rule.decision === "allow") return "allow";
        }
      } catch {}
    }
    return "undecided";
  }

  async function executeUndecidedStrategy(
    req: GenericPermissionRequest,
    commandLike: string,
  ): Promise<"allow" | "ask" | "deny"> {
    const strategy = spaceResolution.strategy;

    // 策略 3: "ask_human" -> 直接弹窗询问人类
    if (strategy === "ask_human") {
      return "ask";
    }

    // 策略 1 & 2 都需要 AI 进行第一道专业安全研判
    const reviewer = reviewerRuntimeProvider?.();
    if (!reviewer) {
      // 若 AI 模块暂时不可用，策略 1 降级为 deny 防越权，策略 2 降级为 ask
      return strategy === "ai_only" ? "deny" : "ask";
    }

    try {
      const deadline = createMonotonicDeadline(masterConfig.reviewer.timeout_ms || 45000);
      const analysis = await analyzeShell(commandLike, directory).catch(() => ({
        source: commandLike,
        segments: [],
        redirections: [],
        staticFileReferences: [],
        issues: [],
        nestedAnalyses: [],
      }));

      const modelReview = await reviewDecisionWithContext({
        deadline,
        timeoutMs: 2000,
        reviewerRuntime: reviewer,
        context: {
          sessionID: req.sessionID,
          tool: req.type,
          command: commandLike,
          cwd: directory,
          args: req.metadata,
        },
        currentCall: req.callID ? {
          callID: req.callID,
          tool: req.type,
          effectSha256: "generic_permission",
        } : undefined,
        shellAnalysis: analysis,
        evaluation: {
          decision: "review",
          matchedRules: [],
          categories: [],
          reasons: [`space=${spaceResolution.space.name}, strategy=${strategy}`],
        },
        tirith: { action: "allow", categories: [], reasons: [] },
        contextMessages: masterConfig.reviewer.context_messages || 20,
        claimedTranscript: undefined,
        authorizationCandidate: undefined,
        cleanupEnabled: masterConfig.reviewer.cleanup_session ?? true,
      });
      const finalReview = applyReviewAuthorizationConsistency({
        review: modelReview,
        authorizationCandidate: undefined,
      });

      if (finalReview.outcome === "allow") {
        return "allow"; // AI 评估安全 -> 自动放行 (不弹窗)
      } else if (finalReview.outcome === "deny") {
        return "deny"; // AI 评估危险 -> 自动拒绝
      } else {
        // AI 判定 needs_confirmation (拿不准/需人类确认)
        if (strategy === "ai_only") {
          return "deny"; // 策略 1: 绝对不打扰人类，拿不准直接拒绝
        }
        return "ask"; // 策略 2: 弹窗请主人亲自确认
      }
    } catch {
      return strategy === "ai_only" ? "deny" : "ask";
    }
  }

  return {
    get masterConfig() {
      refreshPolicy();
      return masterConfig;
    },
    get spaceResolution() {
      refreshPolicy();
      return spaceResolution;
    },
    get compiledRules() {
      refreshPolicy();
      return compiledRules;
    },
    async handlePermission(req: GenericPermissionRequest): Promise<"allow" | "ask" | "deny"> {
      refreshPolicy();
      const resources = normalizeResources(req);
      const commandLike = resources.join(" ") || req.title || req.type;

      // 1. 工具白名单与黑名单显式检查 (Preset Tool Level)
      const allowedTools = spaceResolution.preset.tools?.allow || [];
      const deniedTools = spaceResolution.preset.tools?.deny || [];
      if (deniedTools.includes(req.type) || deniedTools.includes("*")) {
        return "deny";
      }

      // 2. 敏感路径保护
      if (isFilePermission(req)) {
        const sensitiveSegments = ["/.ssh", "/.gnupg", "/etc/shadow", "/etc/sudoers", ".env", ".git-credentials", ".netrc"];
        if (resources.some((r) => sensitiveSegments.some((s) => r.includes(s)))) {
          // 在完全允许模式或临时空间外，敏感路径默认拦截或由策略把关
          if (masterConfig.active_mode !== "full_allow") {
            return "deny";
          }
        }
      }

      // 3. Bash 额外 Tirith 安全引擎扫描
      if (masterConfig.active_mode !== "full_allow" && isBashPermission(req) && commandLike.trim().length > 0) {
        try {
          const fakePolicy: ResolvedPolicy = {
            review: { timeoutMs: 45000, contextMessages: 20, cleanupSession: true },
            tirith: { enabled: true, timeoutMs: 5000, failOpen: false },
            selfProtection: { enabled: true },
            rules: compiledRules,
          };
          const tirithScan = await runRiskScan(fakePolicy, {
            command: commandLike,
            cwd: directory,
            tool: req.type,
            sessionID: req.sessionID,
            args: req.metadata,
          } as any).catch(() => undefined);
          if (tirithScan) {
            const verdict = verdictFromTirithScan(tirithScan as any);
            if (verdict?.decision === "block") return "deny";
          }
        } catch {}
      }

      // 4. 预设规则评估 (黑名单 -> deny / 白名单 -> allow / 未匹配 -> undecided)
      const ruleVerdict = await evaluateWithCompiledRules(commandLike);
      if (ruleVerdict === "allow") return "allow";
      if (ruleVerdict === "deny") return "deny";

      // 5. 如果在工具级明确白名单允许该工具 (如 read/glob)，且未被规则 deny，则直接放行
      if (allowedTools.includes(req.type) || allowedTools.includes("*")) {
        return "allow";
      }

      // 6. 属于【未定名单】：触发该空间设定的 UndecidedStrategy
      return await executeUndecidedStrategy(req, commandLike);
    },
  };
}
