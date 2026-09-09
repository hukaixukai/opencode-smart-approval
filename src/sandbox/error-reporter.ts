import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export const PLUGIN_ID = "opencode-smart-approval";
export const ERROR_LOG_PATH = path.join(os.homedir(), ".config/opencode/smart-approval.error.log");
export const ERROR_JSONL_PATH = path.join(os.homedir(), ".config/opencode/smart-approval.errors.jsonl");

export interface ErrorReport {
  timestamp: string;
  stage: string;
  pluginId: string;
  message: string;
  stack?: string;
  extra?: Record<string, unknown>;
}

function formatError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return { message: `${error.name}: ${error.message}`, stack: error.stack };
  }
  return { message: String(error) };
}

export function appendErrorReport(stage: string, error: unknown, extra?: Record<string, unknown>): void {
  const { message, stack } = formatError(error);
  const report: ErrorReport = {
    timestamp: new Date().toISOString(),
    stage,
    pluginId: PLUGIN_ID,
    message,
    ...(stack ? { stack } : {}),
    ...(extra ? { extra } : {}),
  };
  const line = `[${report.timestamp}] [${PLUGIN_ID}] ${stage}: ${message}\n${stack ?? ""}\n`;
  try {
    fs.mkdirSync(path.dirname(ERROR_LOG_PATH), { recursive: true });
    fs.appendFileSync(ERROR_LOG_PATH, line);
  } catch {}
  try {
    fs.appendFileSync(ERROR_JSONL_PATH, JSON.stringify(report) + "\n");
  } catch {}
  // Note: Do not console.error to avoid polluting TUI screen buffers
}

export async function reportToClient(client: unknown, stage: string, error: unknown, extra?: Record<string, unknown>): Promise<void> {
  const isApprovalBlock = (error as any)?.name === "CommandApprovalError";
  if (!isApprovalBlock) {
    appendErrorReport(stage, error, extra);
  }
  try {
    const app = (client as any)?.app;
    if (app && typeof app.log === "function" && !isApprovalBlock) {
      const { message, stack } = formatError(error);
      await app.log({
        body: {
          service: PLUGIN_ID,
          level: "error",
          message: `[SmartApproval] ${stage} 失败，已自动降级。详情见 ${ERROR_LOG_PATH}: ${message}`,
          extra: {
            stage,
            error: message,
            stack: stack?.slice(0, 2000),
            ...extra,
          },
        },
      });
    }
  } catch (e) {
    // logging must never throw
  }
}

export async function reportInfo(client: unknown, message: string, extra?: Record<string, unknown>): Promise<void> {
  try {
    const app = (client as any)?.app;
    if (app && typeof app.log === "function") {
      await app.log({
        body: {
          service: PLUGIN_ID,
          level: "info",
          message,
          extra,
        },
      });
    }
  } catch {}
}
