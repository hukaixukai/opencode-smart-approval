import { appendErrorReport, reportToClient } from "./error-reporter";

export const DISABLE_ENV = "OPENCODE_DISABLE_SMART_APPROVAL";

export function isDisabled(): boolean {
  return process.env[DISABLE_ENV] === "1" || process.env["OPENCODE_DISABLE_PLUGINS"] === "1";
}

/**
 * Wrap a hook function with isolation: any exception is caught,
 * reported, and does not propagate to the host.
 * Returns undefined on error to let host continue (fail-open for isolation).
 * For security-critical hooks (like bash), caller may decide to enforce fail-closed separately.
 */
export function isolatedHook<T extends (...args: any[]) => Promise<any>>(
  name: string,
  fn: T,
  client?: unknown,
): T {
  const wrapped = async (...args: Parameters<T>): Promise<ReturnType<T> | undefined> => {
    try {
      return await fn(...args);
    } catch (error) {
      if ((error as any)?.name === "CommandApprovalError") {
        throw error;
      }
      await reportToClient(client, `hook:${name}`, error, { hook: name });
      // Do not rethrow unexpected crashes – isolation guarantee: plugin crash never kills host
      return undefined;
    }
  };
  return wrapped as T;
}

/**
 * Wrap an entire Hooks object, isolating each hook.
 * Tool definitions are passed through unchanged.
 */
export function isolateHooks(hooks: Record<string, any>, client?: unknown): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(hooks)) {
    if (key === "tool" && value && typeof value === "object") {
      out[key] = value;
      continue;
    }
    if (key === "dispose" && typeof value === "function") {
      out[key] = async () => {
        try {
          await value();
        } catch (e) {
          appendErrorReport("dispose", e, { hook: key });
        }
      };
      continue;
    }
    if (typeof value === "function") {
      out[key] = isolatedHook(key, value as any, client);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Safe dynamic import with isolation. Returns undefined on failure.
 */
export async function safeImport<T = any>(specifier: string, stage = `import:${specifier}`): Promise<T | undefined> {
  try {
    const mod = await import(specifier);
    return mod as T;
  } catch (error) {
    appendErrorReport(stage, error, { specifier });
    return undefined;
  }
}
