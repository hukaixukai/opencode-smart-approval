import { resolve } from "node:path";
import { effectivePolicyPath, globalPolicyPath, localPolicyPath } from "./master-config";

const READ_TOOLS = new Set(["read", "glob", "grep", "list", "search"]);
const MUTATING_COMMAND = /\b(?:rm|unlink|shred|mv|chmod|chown|truncate|tee)\b|(?:>>|>)/u;

const policyPaths = (directory: string): ReadonlySet<string> => new Set([
  resolve(globalPolicyPath()),
  resolve(localPolicyPath(directory)),
  resolve(effectivePolicyPath(directory)),
]);

export const isPolicyFilePath = (directory: string, value: unknown): boolean => {
  if (Array.isArray(value)) return value.some((item) => isPolicyFilePath(directory, item));
  if (typeof value !== "string" || value.trim().length === 0) return false;
  try {
    return policyPaths(directory).has(resolve(value));
  } catch {
    return false;
  }
};

export const isPolicyMutationDenied = (directory: string, tool: string, resource: unknown): boolean => {
  if (READ_TOOLS.has(tool)) return false;
  if (tool === "bash" || tool === "shell" || tool === "external_directory") {
    return typeof resource === "string" && resource.includes("command-approval.jsonc") && MUTATING_COMMAND.test(resource);
  }
  return isPolicyFilePath(directory, resource);
};
