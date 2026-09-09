/**
 * Smart Approval - Unified Plugin Entry (Modes + Spaces + Presets Architecture)
 */
import type { Hooks, PluginInput, PluginModule } from "@opencode-ai/plugin";
import { createApprovalPluginIntegration, type ApprovalPluginInput } from "./core/approval-plugin-integration";
import { loadMasterPolicy, loadReviewerModelStrict } from "./permissions/master-config";
import { resolveSpaceForPath } from "./permissions/space-matcher";
import { createGenericPermissionHandler } from "./permissions/generic-handler";
import { appendErrorReport, reportToClient, reportInfo, PLUGIN_ID, ERROR_LOG_PATH } from "./sandbox/error-reporter";
import { isDisabled, isolateHooks } from "./sandbox/isolation";
import { createModeAuthoringTool } from "./modes/mode-authoring-tool";
import { authorizeModeAuthoringMessage, ModeAuthoringSessions, modeAuthoringPromptParts } from "./modes/mode-authoring-session";
import { policyRevision } from "./modes/mode-store";
import { isPolicyFilePath, isPolicyMutationDenied } from "./permissions/policy-file-guard";

// Re-export vendor core's createHook for bash
import { createHook as createBashHook } from "./core/index";

type ToolExecuteBefore = NonNullable<Hooks["tool.execute.before"]>;
type PermissionAsk = NonNullable<Hooks["permission.ask"]>;

const captureApprovalRootClient = (input: unknown): any | undefined => {
  const objectField = (obj: unknown, key: string) => typeof obj === "object" && obj !== null ? Reflect.get(obj as any, key) : undefined;
  const app = objectField(input, "app");
  const session = objectField(input, "session");
  const agents = objectField(app, "agents");
  const log = objectField(app, "log");
  const messages = objectField(session, "messages");
  const create = objectField(session, "create");
  const prompt = objectField(session, "prompt");
  const abort = objectField(session, "abort");
  const deleteSession = objectField(session, "delete");
  if (
    typeof agents !== "function" ||
    typeof log !== "function" ||
    typeof messages !== "function" ||
    typeof create !== "function" ||
    typeof prompt !== "function" ||
    typeof abort !== "function" ||
    typeof deleteSession !== "function"
  ) return undefined;
  return Object.freeze({
    app: Object.freeze({
      agents: async (options: any) => Reflect.apply(agents, app, [options]),
      log: async (options: any) => Reflect.apply(log, app, [options]),
    }),
    session: Object.freeze({
      messages: async (options: any) => Reflect.apply(messages, session, [options]),
      create: async (options: any) => Reflect.apply(create, session, [options]),
      prompt: async (options: any) => Reflect.apply(prompt, session, [options]),
      abort: async (options: any) => Reflect.apply(abort, session, [options]),
      delete: async (options: any) => Reflect.apply(deleteSession, session, [options]),
    }),
  });
};

const toApprovalInput = (input: PluginInput): (ApprovalPluginInput & { client: any }) | undefined => {
  try {
    const client = captureApprovalRootClient((input as any).client ?? input);
    const actualClient = client ?? (input as any).client;
    if (!actualClient) return undefined;
    const maybe = captureApprovalRootClient(actualClient);
    const finalClient = maybe ?? actualClient;
    return {
      directory: input.directory,
      client: finalClient,
      ...(input.project === undefined ? {} : { project: input.project }),
      ...(input.worktree === undefined ? {} : { worktree: input.worktree }),
    };
  } catch {
    return undefined;
  }
};

export default {
  id: "smart-approval",
  server: async (input: PluginInput) => {
    try {
      if (isDisabled()) {
        return {};
      }

      const approvalInput = toApprovalInput(input);
      const directory = input.directory;
      const masterConfig = loadMasterPolicy(directory);
      const spaceRes = resolveSpaceForPath(masterConfig, directory);
      const modeAuthoring = new ModeAuthoringSessions();

      let reviewerRuntimeProvider: (() => any) | undefined;
      let vendorHooks: Hooks = {};

      if (approvalInput) {
        try {
          const integration = createApprovalPluginIntegration(approvalInput, {
            reviewConfig: {
              model: masterConfig.reviewer.model,
              timeoutMs: masterConfig.reviewer.timeout_ms || 45000,
              contextMessages: masterConfig.reviewer.context_messages || 20,
              cleanupSession: masterConfig.reviewer.cleanup_session ?? true,
            },
            reviewModel: () => loadReviewerModelStrict(directory),
            createToolExecuteBefore: ({ directory: dir, reviewerRuntime, confirmationService }: any) => {
              reviewerRuntimeProvider = reviewerRuntime;
              return createBashHook(dir, {
                loadedPolicy: {
                  ok: true,
                  path: directory,
                  effectivePolicyPaths: [directory],
                  initialized: true,
                  policy: {
                    review: {
                      model: masterConfig.reviewer.model,
                      timeoutMs: masterConfig.reviewer.timeout_ms || 45000,
                      contextMessages: masterConfig.reviewer.context_messages || 20,
                      cleanupSession: masterConfig.reviewer.cleanup_session ?? true,
                    },
                    tirith: { enabled: true, timeoutMs: 5000, failOpen: false },
                    selfProtection: { enabled: true },
                    rules: [],
                  },
                },
                reviewerRuntime,
                confirmationRuntime: confirmationService,
              });
            },
          });
          vendorHooks = integration.hooks;
          reviewerRuntimeProvider = () => integration.reviewerRuntime();
        } catch (e) {
          await reportToClient(approvalInput.client, "vendorIntegration", e, { directory });
          vendorHooks = {};
        }
      }

      // Initialize full generic permission handler with Space Routing + Presets + Undecided Strategy
      const genericHandler = (() => {
        try {
          return createGenericPermissionHandler(directory, reviewerRuntimeProvider);
        } catch (e) {
          appendErrorReport("createGenericHandler", e, { directory });
          return undefined;
        }
      })();

      const permissionAsk: PermissionAsk = async (permInput: any, output: any) => {
        try {
          const req = permInput as any;
          const resource = req.pattern ?? req.metadata?.filePath ?? req.metadata?.path ?? req.title;
          if (isPolicyFilePath(directory, resource) && ["read", "glob", "grep", "list", "search"].includes(req.type ?? req.action)) {
            output.status = "allow";
            return;
          }
          if (isPolicyMutationDenied(directory, req.type ?? req.action ?? "unknown", resource)) {
            output.status = "deny";
            return;
          }
          if (!genericHandler) return;
          const verdict = await genericHandler.handlePermission({
            id: req.id ?? "unknown",
            type: req.type ?? req.action ?? "unknown",
            pattern: req.pattern,
            sessionID: req.sessionID ?? "unknown",
            messageID: req.messageID ?? "unknown",
            callID: req.callID,
            title: req.title ?? req.type ?? "",
            metadata: req.metadata ?? {},
            time: req.time ?? { created: Date.now() },
          });

          if (verdict === "allow") output.status = "allow";
          else if (verdict === "deny") output.status = "deny";
          else output.status = "ask";
        } catch (e) {
          appendErrorReport("permissionAsk", e, { input: (permInput as any)?.type });
        }
      };

      const toolBefore: ToolExecuteBefore = async (toolInput: any, toolOutput: any) => {
        try {
          const args = toolOutput.args ?? {};
          const command = args.command ?? args.cmd ?? "";
          const filePath = args.filePath ?? args.path ?? args.file ?? "";
          const resource = command || filePath || toolInput.tool;

          if (isPolicyFilePath(directory, resource) && ["read", "glob", "grep", "list", "search"].includes(toolInput.tool)) return;
          if (isPolicyMutationDenied(directory, toolInput.tool, resource)) {
            const { enforceVerdict } = await import("./core/verdict");
            enforceVerdict(toolInput.tool, {
              decision: "block",
              source: "rule",
              reasonSource: "policy",
              riskLevel: "high",
              userAuthorization: "unknown",
              categories: [{ id: "security.policy_file_protected", score: 1 }],
              reasons: ["command-approval.jsonc is readable but cannot be edited or deleted by the Agent"],
              matchedRuleLabels: [],
            });
          }
          if (!genericHandler) return;

          const verdict = await genericHandler.handlePermission({
            id: `tool:${toolInput.tool}:${toolInput.callID}`,
            type: toolInput.tool,
            pattern: resource,
            sessionID: toolInput.sessionID,
            messageID: "tool",
            callID: toolInput.callID,
            title: resource,
            metadata: { tool: toolInput.tool, command, filePath, ...args },
            time: { created: Date.now() },
          });

          if (verdict === "deny") {
            const { enforceVerdict } = await import("./core/verdict");
            enforceVerdict(toolInput.tool, {
              decision: "block",
              source: "rule",
              reasonSource: "policy",
              riskLevel: "high",
              userAuthorization: "unknown",
              categories: [{ id: "security.policy_denied", score: 1 }],
              reasons: [`action blocked by space '${spaceRes.space.name}' under preset '${spaceRes.preset.name}'`],
              matchedRuleLabels: [],
            });
          }
        } catch (e) {
          const isApproval = (e as any)?.name === "CommandApprovalError";
          if (isApproval) throw e;
          appendErrorReport("toolBefore", e, { tool: toolInput.tool });
        }
      };

      const vendorEvent = vendorHooks.event;
      const vendorChatMessage = vendorHooks["chat.message"];
      const modeAuthoringChatMessage: NonNullable<Hooks["chat.message"]> = async (chatInput, chatOutput) => {
        await vendorChatMessage?.(chatInput, chatOutput);
        authorizeModeAuthoringMessage({
          sessions: modeAuthoring,
          sessionID: chatInput.sessionID,
          directory,
          revision: policyRevision(directory),
          parts: chatOutput.parts as Array<{ type?: string; text?: string; synthetic?: boolean }>,
        });
      };
      const modeAuthoringEvent: NonNullable<Hooks["event"]> = async ({ event }) => {
        if (event.type === "command.executed") {
          const grant = modeAuthoring.authorizeCommand({
            command: event.properties.name,
            arguments: event.properties.arguments,
            sessionID: event.properties.sessionID,
            directory,
            revision: policyRevision(directory),
          });
          if (grant) {
            const session = (input as any).client?.session;
            const request = {
              path: { id: grant.sessionID },
              query: { directory: grant.directory },
              body: {
                parts: modeAuthoringPromptParts(grant.requirement),
                tools: { approval_mode_create: true, read: true, glob: true, grep: true, list: true },
              },
            };
            try {
              if (typeof session?.promptAsync === "function") {
                await session.promptAsync(request);
              } else if (typeof session?.prompt === "function") {
                void session.prompt(request).catch((error: unknown) => {
                  modeAuthoring.revoke("error", grant.sessionID);
                  appendErrorReport("modeAuthoring:prompt", error, { sessionID: grant.sessionID });
                });
              } else {
                throw new Error("OpenCode session prompt API is unavailable");
              }
            } catch (error) {
              modeAuthoring.revoke("error", grant.sessionID);
              appendErrorReport("modeAuthoring:prompt", error, { sessionID: grant.sessionID });
            }
          }
        } else if (event.type === "session.idle") {
          modeAuthoring.revoke("idle", event.properties.sessionID);
        } else if (event.type === "session.error" && event.properties.sessionID) {
          modeAuthoring.revoke("error", event.properties.sessionID);
        } else if (event.type === "session.deleted") {
          modeAuthoring.revoke("deleted", event.properties.info.id);
        }
      };

      const finalHooks: Hooks = {
        ...vendorHooks,
        tool: {
          ...(vendorHooks.tool ?? {}),
          approval_mode_create: createModeAuthoringTool(modeAuthoring),
        },
        event: async (eventInput) => {
          await modeAuthoringEvent(eventInput);
          await vendorEvent?.(eventInput);
        },
        "chat.message": modeAuthoringChatMessage,
        "tool.execute.before": toolBefore,
        "permission.ask": permissionAsk,
      };

      const originalDispose = (vendorHooks as any).dispose;
      if (originalDispose) {
        (finalHooks as any).dispose = async () => {
          modeAuthoring.dispose();
          try {
            await originalDispose();
          } catch (e) {
            appendErrorReport("dispose", e);
          }
        };
      } else {
        (finalHooks as any).dispose = async () => modeAuthoring.dispose();
      }

      try {
        await reportInfo(
          approvalInput?.client,
          `[smart-approval] Active Mode: ${masterConfig.active_mode} | Space: ${spaceRes.space.name} | Preset: ${spaceRes.preset.id} | Undecided: ${spaceRes.strategy}`,
        );
      } catch {}

      return isolateHooks(finalHooks as any, approvalInput?.client);
    } catch (error) {
      appendErrorReport("server:init", error, { directory: (input as any)?.directory });
      return {};
    }
  },
} satisfies PluginModule;
