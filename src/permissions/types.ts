export type PermissionAction =
  | "read"
  | "edit"
  | "glob"
  | "grep"
  | "list"
  | "bash"
  | "task"
  | "external_directory"
  | "todowrite"
  | "webfetch"
  | "websearch"
  | "lsp"
  | "skill"
  | "question"
  | "doom_loop"
  | string;

export interface GenericPermissionRequest {
  id: string;
  type: string;
  pattern?: string | string[];
  sessionID: string;
  messageID: string;
  callID?: string;
  title: string;
  metadata: Record<string, unknown>;
  time: { created: number };
}

export type PermissionVerdict = "allow" | "ask" | "deny";

export interface PermissionEvaluationContext {
  action: string;
  resources: string[];
  pattern?: string | string[];
  title: string;
  metadata: Record<string, unknown>;
}
