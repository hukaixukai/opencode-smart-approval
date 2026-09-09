import type { MasterApprovalConfig } from "../permissions/master-schema";
import { deleteMode, isProtectedMode } from "../modes/mode-store";

export type DeletionCandidate = {
  readonly id: string;
  readonly name: string;
  readonly disabledReason?: string;
};

export const deletionCandidates = (config: MasterApprovalConfig): readonly DeletionCandidate[] =>
  Object.values(config.modes)
    .filter((mode) => !isProtectedMode(mode.id))
    .map((mode) => mode.id === config.active_mode
      ? { id: mode.id, name: mode.name, disabledReason: "当前生效模式，请先通过 /ae 切换" }
      : { id: mode.id, name: mode.name });

export const createDeleteConfirmation = (
  windowMs = 3_000,
  now: () => number = Date.now,
) => {
  let armed: { modeID: string; expiresAt: number } | undefined;
  return {
    select(modeID: string): void {
      if (armed?.modeID !== modeID) armed = undefined;
    },
    press(modeID: string): "armed" | "confirmed" {
      const current = now();
      if (armed?.modeID === modeID && current <= armed.expiresAt) {
        armed = undefined;
        return "confirmed";
      }
      armed = { modeID, expiresAt: current + windowMs };
      return "armed";
    },
    reset(): void {
      armed = undefined;
    },
  };
};

export const openModeDeletionDialog = (
  api: any,
  directory: string | undefined,
  config: MasterApprovalConfig,
): void => {
  const dialog = api.ui.dialog;
  dialog.setSize?.("large");
  const candidates = deletionCandidates(config);
  const confirmation = createDeleteConfirmation();
  let selectedModeID = candidates.find((candidate) => !candidate.disabledReason)?.id ?? candidates[0]?.id;
  let closed = false;
  let removeKeyBinding: (() => void) | undefined;

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    confirmation.reset();
    removeKeyBinding?.();
  };

  const confirmSelected = (): void => {
    if (!selectedModeID) return;
    const candidate = candidates.find((entry) => entry.id === selectedModeID);
    if (!candidate || candidate.disabledReason) {
      api.ui.toast({ variant: "warning", title: "无法删除模式", message: candidate?.disabledReason ?? "没有选中模式" });
      return;
    }
    if (confirmation.press(candidate.id) === "armed") {
      api.ui.toast({
        variant: "warning",
        title: "确认删除模式",
        message: `3 秒内再次按 Ctrl+D 删除「${candidate.name}」`,
        duration: 3_000,
      });
      return;
    }
    try {
      deleteMode(directory, candidate.id);
      cleanup();
      dialog.clear();
      api.ui.toast({ variant: "success", title: "审批模式已删除", message: candidate.name, duration: 4_000 });
    } catch (error) {
      confirmation.reset();
      api.ui.toast({
        variant: "error",
        title: "删除失败",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  removeKeyBinding = api.command?.register(() => [{
    title: "确认删除审批模式",
    value: "approval.mode.delete.confirm",
    category: "Security",
    keybind: "ctrl+d",
    hidden: true,
    onSelect: confirmSelected,
  }]);

  const options = candidates.length > 0
    ? candidates.map((candidate) => ({
        title: candidate.disabledReason ? `● ${candidate.name}` : `  ${candidate.name}`,
        value: candidate.id,
        description: candidate.disabledReason ?? "选中后连续按两次 Ctrl+D 删除",
        disabled: Boolean(candidate.disabledReason),
        onSelect: () => {},
      }))
    : [{
        title: "没有可删除的用户模式",
        value: "none",
        disabled: true,
        onSelect: () => {},
      }];

  dialog.replace(() => api.ui.DialogSelect({
    title: "删除模式（连续两次 Ctrl+D）",
    options,
    current: selectedModeID,
    onMove: (option: { value: string }) => {
      selectedModeID = option.value;
      confirmation.select(option.value);
    },
  }), cleanup);
};
