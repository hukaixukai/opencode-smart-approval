import { loadMasterPolicy, saveMasterPolicyAtomic } from "../permissions/master-config";
import type { MasterApprovalConfig, ApprovalMode, SpaceDefinition, PermissionPreset, UndecidedStrategy } from "../permissions/master-schema";
import { appendErrorReport } from "../sandbox/error-reporter";
import { openModeDeletionDialog } from "./mode-delete";
import { normalizeDisplayName } from "../display-names";

export type TuiToastInput = {
  readonly variant?: "info" | "success" | "warning" | "error";
  readonly title?: string;
  readonly message: string;
};

export const notifyTuiAction = (
  dialog: { readonly clear: () => void },
  toast: (input: TuiToastInput & { readonly duration: number }) => void,
  input: TuiToastInput,
): void => {
  dialog.clear();
  toast({ ...input, duration: 4_000 });
};

export const paginateTuiItems = <T>(items: readonly T[], requestedPage: number, pageSize: number) => {
  const safePageSize = Number.isSafeInteger(pageSize) && pageSize > 0 ? pageSize : 1;
  const pageCount = Math.max(1, Math.ceil(items.length / safePageSize));
  const page = Math.min(Math.max(0, Number.isSafeInteger(requestedPage) ? requestedPage : 0), pageCount - 1);
  return {
    items: items.slice(page * safePageSize, (page + 1) * safePageSize),
    page,
    pageCount,
  };
};

export function formatPresetSummary(strategy: string): string {
  return `灰 ${strategy}`;
}

export function formatRuleCountSummary(allowCount: number, denyCount: number): string {
  return `允许 ${allowCount} · 拒绝 ${denyCount}`;
}

export function formatSpaceSummary(presetName: string): string {
  return `绑定 ${presetName}`;
}

export function formatSelectedPresetLabel(presetName: string): string {
  return `绑定 ${presetName}`;
}

export function formatSpaceDisplayName(name: string): string {
  return normalizeDisplayName(name, "未匹配路径");
}

export function formatPresetDisplayName(name: string): string {
  return normalizeDisplayName(name, "未命名预设");
}

export function formatTuiSectionTitle(section: string, name: string): string {
  return `${section} ${name}`;
}

export function formatStrategy(st: UndecidedStrategy): string {
  switch (st) {
    case "ai_with_ask":
      return "智能审核 高危询问";
    case "ai_only":
      return "纯智能 绝不弹窗";
    case "ask_human":
      return "询问 未定必弹窗";
    default:
      return st;
  }
}

const tui = async (api: any) => {
  try {
    const currentDirectory = (): string | undefined => api.state?.path?.directory || undefined;
    const loadPolicy = (): MasterApprovalConfig => loadMasterPolicy(currentDirectory());
    const savePolicy = (config: MasterApprovalConfig): void => saveMasterPolicyAtomic(config, currentDirectory());

    api.command.register(() => [
      // =========================================================================
      // /am: 设置审核模型 (纯斜杠指令，无任何快捷键冲突)
      // =========================================================================
      {
        title: "设置审核模型",
        value: "approval.model.picker",
        category: "Security",
        slash: { name: "approval-model", aliases: ["am"] },
        onSelect: (dialog?: any) => {
          if (!dialog) return;

          dialog.setSize?.("large");

          const config = loadPolicy();
          const current = config.reviewer?.model ?? "未配置";

          const configuredProviders = new Set(Object.keys((api.tuiConfig as any)?.provider ?? {}));
          const seen = new Set<string>();
          const options: any[] = [];

          for (const provider of (api.state as any)?.provider ?? []) {
            const pid = (provider as any)?.id ?? "";
            if (configuredProviders.size > 0 && !configuredProviders.has(pid)) continue;
            const models = (provider as any)?.models ?? {};
            for (const mid of Object.keys(models)) {
              const full = `${pid}/${mid}`;
              if (seen.has(full)) continue;
              seen.add(full);
              const isCurrent = full === config.reviewer?.model;
              options.push({
                title: full,
                value: full,
                description: isCurrent ? "当前审核模型" : "设置为审核模型",
              });
            }
          }

          if (options.length === 0) {
            options.push({
              title: "没有可用模型",
              value: "__none__",
              description: "请先在 OpenCode 中配置模型提供商",
              disabled: true,
            });
          }

          options.sort((a, b) => a.title.localeCompare(b.title));
          dialog.replace(() =>
            api.ui.DialogSelect({
              title: "审核模型",
              placeholder: `当前: ${current}`,
              current: config.reviewer?.model,
              options,
              onSelect: (option: { value: string }) => {
                if (option.value === "__none__") return;
                try {
                  config.reviewer.model = option.value;
                  savePolicy(config);
                  notifyTuiAction(dialog, api.ui.toast, {
                    variant: "success",
                    title: "审核模型已切换",
                    message: `下一次 AI 审核使用 ${option.value}`,
                  });
                } catch (error) {
                  api.ui.toast({
                    variant: "error",
                    title: "审核模型切换失败",
                    message: error instanceof Error ? error.message : String(error),
                    duration: 5_000,
                  });
                }
              },
            }),
          );
        },
      },

      // =========================================================================
      // /ae: 模式管理 (纯斜杠指令，无任何快捷键冲突)
      // =========================================================================
      {
        title: "模式管理",
        value: "approval.mode.inspector",
        category: "Security",
        slash: { name: "approval-edit", aliases: ["ae"] },
        onSelect: (dialog?: any) => {
          if (!dialog) return;

          dialog.setSize?.("large");

          // 1. 首页：纯净模式列表
          const renderModeList = () => {
            const config = loadPolicy();
            const modes = Object.values(config.modes || {});
            const activeId = config.active_mode;

            const options = modes.map((m) => {
              const isActive = m.id === activeId;
              return {
                title: m.name,
                value: m.id,
                description: isActive ? "当前生效 · 回车查看配置" : "回车切换此模式",
              };
            });

            dialog.replace(() =>
              api.ui.DialogSelect({
                title: "审批模式",
                placeholder: `当前: ${config.modes[activeId]?.name || activeId}`,
                current: activeId,
                options,
                onSelect: (option: { value: string }) => {
                  const selected = modes.find((mode) => mode.id === option.value);
                  if (!selected) return;
                  if (selected.id === activeId) {
                    renderModeBoxes(selected);
                    return;
                  }
                  try {
                    config.active_mode = selected.id;
                    savePolicy(config);
                    notifyTuiAction(dialog, api.ui.toast, {
                      variant: "success",
                      title: "审批模式已切换",
                      message: `下一次权限判断使用「${selected.name}」`,
                    });
                  } catch (error) {
                    api.ui.toast({
                      variant: "error",
                      title: "审批模式切换失败",
                      message: error instanceof Error ? error.message : String(error),
                      duration: 5_000,
                    });
                  }
                },
              }),
            );
          };

          // 2. 模式主框：两大预设
          const renderModeBoxes = (mode: ApprovalMode) => {
            dialog.setSize?.("large");
            const config = loadPolicy();
            const spaces = mode.spaces || [];

            const usedPresetIds = new Set(spaces.map((s) => s.preset));
            if (mode.other?.preset) usedPresetIds.add(mode.other.preset);

            dialog.replace(() =>
              api.ui.DialogSelect({
                title: `模式 · ${mode.name}`,
                options: [
                  {
                    title: "权限预设",
                    value: "box_presets",
                    description: `${usedPresetIds.size} 个预设 · 查看白名单、黑名单和灰名单策略`,
                  },
                  {
                    title: "空间映射",
                    value: "box_spaces",
                    description: `${spaces.length} 组路径 + other 默认规则`,
                  },
                  {
                    title: "← 返回模式列表",
                    value: "back",
                  },
                ],
                onSelect: (option: { value: string }) => {
                  if (option.value === "box_presets") renderPresetBox(mode, usedPresetIds);
                  else if (option.value === "box_spaces") renderSpaceBox(mode);
                  else renderModeList();
                },
              }),
            );
          };

          // 大框 1: 权限预设列表
          const renderPresetBox = (mode: ApprovalMode, usedPresetIds: Set<string>) => {
            dialog.setSize?.("large");
            const config = loadPolicy();
            const presets = Object.values(config.presets || {}).filter((pr) => usedPresetIds.has(pr.id));

            const options: any[] = presets.map((pr) => {
              const strat = formatStrategy(pr.undecided_strategy || "ai_with_ask");
              return {
                title: formatPresetDisplayName(pr.name),
                value: pr.id,
                description: formatPresetSummary(strat),
              };
            });

            options.push({
              title: "← 返回模式",
              value: "back",
            });

            dialog.replace(() =>
              api.ui.DialogSelect({
                title: formatTuiSectionTitle("权限预设", mode.name),
                options,
                onSelect: (option: { value: string }) => {
                  if (option.value === "back") {
                    renderModeBoxes(mode);
                    return;
                  }
                  const selected = presets.find((preset) => preset.id === option.value);
                  if (selected) renderPresetDetail(mode, selected, usedPresetIds);
                },
              }),
            );
          };

          // 大框 1 详情: 规则明细
          const renderPresetDetail = (mode: ApprovalMode, preset: PermissionPreset, usedPresetIds: Set<string>, requestedPage = 0) => {
            dialog.setSize?.("xlarge");
            const allowRules = preset.rules?.allow || [];
            const denyRules = preset.rules?.deny || [];
            const strat = formatStrategy(preset.undecided_strategy || "ai_with_ask");

            const rules = [
              ...allowRules.map((rule) => ({ kind: "白名单", mark: "✓", rule })),
              ...denyRules.map((rule) => ({ kind: "黑名单", mark: "✗", rule })),
            ];
            const page = paginateTuiItems(rules, requestedPage, 8);
            const rangeStart = rules.length === 0 ? 0 : page.page * 8 + 1;
            const rangeEnd = Math.min((page.page + 1) * 8, rules.length);
            const items: any[] = [
              {
                title: "🟡 灰名单处理方式",
                value: "h_grey",
                description: strat,
                category: "重点",
                disabled: true,
              },
              {
                title: formatRuleCountSummary(allowRules.length, denyRules.length),
                value: "h_count",
                description: `规则 ${rangeStart}-${rangeEnd} / ${rules.length}`,
                disabled: true,
              },
              ...(page.items.length === 0
                ? [{ title: "没有配置规则", value: "h_empty", disabled: true }]
                : page.items.map((entry, index) => ({
                    title: `${entry.mark} ${entry.rule.match}`,
                    value: `rule_${page.page * 8 + index}`,
                    description: `${entry.kind}${entry.rule.reason ? ` · ${entry.rule.reason}` : ""}`,
                  }))),
              ...(page.page > 0 ? [{ title: "← 上一页", value: "prev" }] : []),
              ...(page.page + 1 < page.pageCount ? [{ title: "下一页 →", value: "next" }] : []),
              {
                title: "← 返回权限预设",
                value: "back",
              },
            ];

            dialog.replace(() =>
              api.ui.DialogSelect({
                title: formatPresetDisplayName(preset.name),
                placeholder: `第 ${page.page + 1} / ${page.pageCount} 页`,
                options: items,
                onSelect: (option: { value: string }) => {
                  if (option.value === "back") renderPresetBox(mode, usedPresetIds);
                  else if (option.value === "prev") renderPresetDetail(mode, preset, usedPresetIds, page.page - 1);
                  else if (option.value === "next") renderPresetDetail(mode, preset, usedPresetIds, page.page + 1);
                },
              }),
            );
          };

          // 大框 2: 空间预设。先选空间，再进入独立详情页，避免把路径、预设和策略
          // 挤在同一个 option 的 description 中导致窄终端横向截断。
          const renderSpaceDetail = (mode: ApprovalMode, space: SpaceDefinition, requestedPage = 0) => {
            dialog.setSize?.("xlarge");
            const config = loadPolicy();
            const preset = config.presets?.[space.preset];
            const strategy = formatStrategy(preset?.undecided_strategy || "ai_with_ask");
            const presetName = preset?.name || "未找到预设";
            const paths = space.paths.length > 0 ? space.paths : ["未配置路径 该空间不会匹配任何路径"];
            const page = paginateTuiItems(paths, requestedPage, 6);
            const rangeStart = page.items.length === 0 ? 0 : page.page * 6 + 1;
            const rangeEnd = Math.min((page.page + 1) * 6, paths.length);
            const options: any[] = [
              {
                title: "绑定预设",
                value: "h_preset",
                description: formatSelectedPresetLabel(presetName),
                disabled: true,
              },
              {
                title: "🟡 灰",
                value: "h_strategy",
                description: strategy,
                category: "重点",
                disabled: true,
              },
              {
                title: `路径 ${rangeStart}-${rangeEnd} / ${paths.length}`,
                value: "h_paths",
                description: space.description || "每条路径独立一行，支持分页查看",
                disabled: true,
              },
              ...page.items.map((path, index) => ({
                title: `路径 ${page.page * 6 + index + 1}`,
                value: `path_${page.page * 6 + index}`,
                description: path,
              })),
              ...(page.page > 0 ? [{ title: "← 上一页", value: "prev" }] : []),
              ...(page.page + 1 < page.pageCount ? [{ title: "下一页 →", value: "next" }] : []),
              {
                title: "← 返回空间映射",
                value: "back",
              },
            ];

            dialog.replace(() =>
              api.ui.DialogSelect({
                title: formatSpaceDisplayName(space.name),
                placeholder: `第 ${page.page + 1} / ${page.pageCount} 页`,
                options,
                onSelect: (option: { value: string }) => {
                  if (option.value === "back") renderSpaceBox(mode);
                  else if (option.value === "prev") renderSpaceDetail(mode, space, page.page - 1);
                  else if (option.value === "next") renderSpaceDetail(mode, space, page.page + 1);
                },
              }),
            );
          };

          const renderSpaceBox = (mode: ApprovalMode) => {
            dialog.setSize?.("large");
            const config = loadPolicy();
            const spaces: SpaceDefinition[] = [...(mode.spaces || [])];
            if (mode.other) {
              spaces.push({
                id: "other_space",
                name: "未匹配路径",
                paths: ["未匹配上述空间的路径"],
                preset: mode.other.preset,
                description: "未命中任何空间时使用的兜底映射",
              });
            }
            const presets = config.presets || {};
            const options: any[] = spaces.map((space) => {
              const preset = presets[space.preset];
              const presetName = formatPresetDisplayName(preset?.name || "未找到预设");
              return {
                title: formatSpaceDisplayName(space.name),
                value: space.id,
                description: formatSpaceSummary(presetName),
              };
            });
            options.push({ title: "← 返回模式", value: "back" });

            dialog.replace(() =>
              api.ui.DialogSelect({
                title: formatTuiSectionTitle("空间映射", mode.name),
                options,
                onSelect: (option: { value: string }) => {
                  if (option.value === "back") {
                    renderModeBoxes(mode);
                    return;
                  }
                  const selected = spaces.find((space) => space.id === option.value);
                  if (selected) renderSpaceDetail(mode, selected);
                },
              }),
            );
          };

          // 启动
          renderModeList();
        },
      },

      // `/an <需求>` 是 `/ae <需求>` 在部分 TUI 版本中的兼容入口。
      // 参数由服务端 command.executed 钩子读取；这里不直接修改配置。
      {
        title: "让 Agent 新增审批模式（使用 /an <需求>）",
        value: "approval.mode.author",
        category: "Security",
        slash: { name: "approval-new", aliases: ["an"] },
        onSelect: () => {},
      },

      {
        title: "删除审批模式",
        value: "approval.mode.delete",
        category: "Security",
        slash: { name: "approval-delete", aliases: ["ad"] },
        onSelect: () => {
          const directory = currentDirectory();
          openModeDeletionDialog(api, directory, loadPolicy());
        },
      },
    ]);

    const stopCreationNotice = api.event?.on("command.executed", (event: any) => {
      const command = event.properties?.name;
      const requirement = String(event.properties?.arguments ?? "").trim();
      if (!["approval-edit", "ae", "approval-new", "an"].includes(command) || requirement.length === 0) return;
      api.ui.dialog.clear();
      api.ui.toast({
        variant: "info",
        title: "Agent 正在设计新模式",
        message: "本次需求已交给 Agent，正在生成模式",
        duration: 4_000,
      });
    });
    if (stopCreationNotice) api.lifecycle?.onDispose(stopCreationNotice);
  } catch (err) {
    appendErrorReport("tui:init", err);
  }
};

export default {
  id: "smart-approval-tui",
  tui,
};
