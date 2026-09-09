import { withShellTree } from "./shell-parser";
import { createStaticReferenceCollector } from "./static-file-references";
import { byteOffsetsFor, controlCharacterIssue } from "./shell-static";
import {
  addShellIssue,
  MAX_SHELL_SEGMENTS,
  recordShellIssue,
  traverseShellTree,
  type MutableShellAnalysis,
  type ShellAnalysisBudget,
} from "./shell-analysis-traversal";
import type { ShellAnalysis } from "./types";

const MAX_SOURCE_BYTES = 128 * 1024;
const MAX_NESTED_SHELL_DEPTH = 8;

type AnalyzeRequest = {
  readonly source: string;
  readonly nestedDepth: number;
  readonly budget: ShellAnalysisBudget;
  readonly cwd: string;
  readonly referencesEnabled: boolean;
};

/**
 * 快速纯正则备选解析（当 WASM Tree-sitter 未就绪或异常时的降级解析器）
 */
const fallbackRegexAnalysis = (source: string, cwd: string): ShellAnalysis => {
  const words = source.trim().split(/\s+/);
  const commandName = words[0] || "";
  const args = words.slice(1);
  return {
    source,
    segments: [
      {
        source,
        normalizedSource: source,
        commandName,
        originalExecutable: { raw: commandName, value: commandName, expansionFree: true },
        effectiveExecutable: { raw: commandName, value: commandName, expansionFree: true },
        targetKind: "external",
        executionCwd: cwd,
        executionCwdKnown: true,
        arguments: args,
        rawArguments: args,
        argumentWords: args.map((a) => ({ raw: a, value: a, expansionFree: true })),
        environment: [],
        assignments: [],
        wrapperChain: [],
        terminalAllowEligible: true,
        redirections: [],
        startByte: 0,
        endByte: source.length,
        connector: "start",
        topLevel: true,
        subshellDepth: 0,
        nested: false,
        stdinFromPipe: false,
      },
    ],
    redirections: [],
    staticFileReferences: [],
    issues: [],
    nestedAnalyses: [],
  };
};

const analyze = async ({ source, nestedDepth, budget, cwd, referencesEnabled }: AnalyzeRequest): Promise<ShellAnalysis> => {
  const bytes = Buffer.from(source, "utf8");
  if (bytes.byteLength > MAX_SOURCE_BYTES) {
    return {
      source,
      segments: [],
      redirections: [],
      staticFileReferences: [],
      issues: [{ kind: "limit", reason: "shell command exceeds 128 KiB" }],
      nestedAnalyses: [],
    };
  }
  const controlIssue = controlCharacterIssue(source);
  if (controlIssue) return { source, segments: [], redirections: [], staticFileReferences: [], issues: [controlIssue], nestedAnalyses: [] };
  const state: MutableShellAnalysis = {
    segments: [],
    redirections: [],
    referenceCollector: createStaticReferenceCollector(cwd),
    nestedShells: [],
    issues: new Map(),
    byteOffsets: byteOffsetsFor(source),
    segmentLimitReached: false,
  };
  const nestedAnalyses: ShellAnalysis[] = [];

  try {
    await withShellTree(source, (root) => {
      traverseShellTree(root, source, state, budget, nestedDepth > 0);
    });
  } catch (error) {
    // 优雅降级：若 Tree-sitter WASM 解析遇到异常，直接返回纯正则分词解析，保证不阻断进程
    return fallbackRegexAnalysis(source, cwd);
  }

  if (nestedDepth >= MAX_NESTED_SHELL_DEPTH && state.nestedShells.length > 0) {
    recordShellIssue(state, "limit", "nested shell depth limit exceeded");
  } else {
    for (const nestedSource of state.nestedShells) {
      if (budget.remainingSegments <= 0) {
        recordShellIssue(state, "limit", `shell command exceeds ${String(MAX_SHELL_SEGMENTS)} executable segments`);
        break;
      }
      const nestedAnalysis = await analyze({ source: nestedSource, nestedDepth: nestedDepth + 1, budget, cwd, referencesEnabled: false });
      nestedAnalyses.push(nestedAnalysis);
    }
  }
  const staticFileReferences = referencesEnabled
    ? state.referenceCollector.finish(state.segments)
    : [];
  return {
    source,
    segments: Object.freeze(state.segments),
    redirections: Object.freeze(state.redirections),
    staticFileReferences: Object.freeze(staticFileReferences),
    issues: Object.freeze([...state.issues.values()]),
    nestedAnalyses: Object.freeze(nestedAnalyses),
  };
};

export const analyzeShell = (source: string, cwd: string): Promise<ShellAnalysis> =>
  analyze({
    source,
    nestedDepth: 0,
    budget: { remainingSegments: MAX_SHELL_SEGMENTS },
    cwd,
    referencesEnabled: true,
  });
