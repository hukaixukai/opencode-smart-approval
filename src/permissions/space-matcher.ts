import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { MasterApprovalConfig, ApprovalMode, SpaceDefinition, PermissionPreset, UndecidedStrategy } from "./master-schema";

export function expandHome(filePath: string): string {
  if (filePath === "~") return homedir();
  if (filePath.startsWith("~/")) return resolve(homedir(), filePath.slice(2));
  if (filePath.startsWith("$HOME/")) return resolve(homedir(), filePath.slice(6));
  return filePath;
}

export function matchPathPattern(targetPath: string, pattern: string): boolean {
  const normTarget = resolve(expandHome(targetPath));
  const normPattern = resolve(expandHome(pattern));

  if (normPattern.endsWith("/**")) {
    const base = normPattern.slice(0, -3);
    return normTarget === base || normTarget.startsWith(base + "/");
  }
  if (normPattern.endsWith("/*")) {
    const base = normPattern.slice(0, -2);
    if (!normTarget.startsWith(base + "/")) return false;
    const rel = normTarget.slice(base.length + 1);
    return !rel.includes("/");
  }
  if (normPattern.includes("*") || normPattern.includes("?")) {
    const escaped = normPattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, ".*")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, ".");
    const regex = new RegExp(`^${escaped}$`);
    return regex.test(normTarget);
  }
  return normTarget === normPattern || normTarget.startsWith(normPattern + "/");
}

export interface MatchedSpaceResult {
  space: SpaceDefinition | { id: "other"; name: "other"; paths: string[]; preset: string };
  preset: PermissionPreset;
  strategy: UndecidedStrategy;
  modeName: string;
}

/**
 * 根据工作目录匹配模式中的空间，解析出权限预设及内置在预设中的灰名单策略
 */
export function resolveSpaceForPath(
  config: MasterApprovalConfig,
  currentDirectory: string,
): MatchedSpaceResult {
  const activeModeId = config.active_mode || "delegate";
  const mode: ApprovalMode = config.modes[activeModeId] || config.modes["delegate"] || Object.values(config.modes)[0];

  let matchedSpace: SpaceDefinition | undefined;

  for (const space of mode.spaces || []) {
    for (const p of space.paths) {
      if (matchPathPattern(currentDirectory, p)) {
        matchedSpace = space;
        break;
      }
    }
    if (matchedSpace) break;
  }

  // 空间未命中时使用 other 兜底空间
  const otherPresetId = (mode as any).other?.preset || (mode as any).default_space?.preset || "developer";
  const spaceInfo = matchedSpace || {
    id: "other",
    name: "other",
    paths: ["*"],
    preset: otherPresetId,
  };

  const presetId = spaceInfo.preset;
  const preset = config.presets[presetId] || config.presets["developer"] || Object.values(config.presets)[0];

  return {
    space: spaceInfo,
    preset,
    strategy: preset.undecided_strategy || "ai_with_ask",
    modeName: mode.name,
  };
}
