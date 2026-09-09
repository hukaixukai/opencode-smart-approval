import { tool } from "@opencode-ai/plugin";
import { createMode, ModeDraftSchema } from "./mode-store";
import type { ModeAuthoringSessions } from "./mode-authoring-session";

export const createModeAuthoringTool = (sessions: ModeAuthoringSessions) => tool({
  description: [
    "Create one new Smart Approval mode from a user-authorized /ae <requirement> or /an <requirement> turn.",
    "Submit the complete mode and all of its new namespaced permission presets.",
    "Use short Chinese display names without English words, brackets, parentheses, or explanatory suffixes; the plugin normalizes names before saving.",
    "The tool validates and atomically saves the policy; it never activates or overwrites modes.",
  ].join(" "),
  args: ModeDraftSchema.shape,
  async execute(args, context) {
    const grant = sessions.require(context.sessionID);
    const result = createMode(grant.directory, args, grant.revision);
    sessions.complete(context.sessionID);
    return JSON.stringify({
      ok: true,
      modeID: result.modeID,
      active: false,
      restartRequired: true,
      message: `Mode ${result.modeID} was created. Please restart OpenCode, then use /ae to review and activate it.`,
    });
  },
});
