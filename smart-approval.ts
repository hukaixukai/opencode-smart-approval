/**
 * Smart Approval Isolated Loader
 * Location: ~/.config/opencode/plugins/smart-approval.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const PLUGIN_ID = "smart-approval";
const ERROR_LOG = path.join(os.homedir(), ".config/opencode/smart-approval.error.log");

function appendLog(stage: string, error: unknown) {
  const msg = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const stack = error instanceof Error ? error.stack ?? "" : "";
  const line = `[${new Date().toISOString()}] [${PLUGIN_ID} loader] ${stage}: ${msg}\n${stack}\n`;
  try {
    fs.mkdirSync(path.dirname(ERROR_LOG), { recursive: true });
    fs.appendFileSync(ERROR_LOG, line);
  } catch {}
}

export default {
  id: "smart-approval",
  server: async (input: any) => {
    try {
      if (process.env.OPENCODE_DISABLE_SMART_APPROVAL === "1" || process.env.OPENCODE_DISABLE_PLUGINS === "1") {
        return {};
      }
      let mod: any;
      try {
        mod = await import("./smart-approval/src/index.ts");
      } catch (e) {
        appendLog("import:./smart-approval/src/index.ts", e);
        return {};
      }

      const serverFn = mod?.default?.server ?? mod?.server;
      if (typeof serverFn !== "function") {
        appendLog("resolve:serverFn", new Error("smart-approval/src/index.ts does not export server"));
        return {};
      }

      try {
        const hooks = await serverFn(input);
        return hooks ?? {};
      } catch (e) {
        appendLog("serverFn:execution", e);
        return {};
      }
    } catch (e) {
      appendLog("loader:server:outer", e);
      return {};
    }
  },
} satisfies import("@opencode-ai/plugin").PluginModule;
