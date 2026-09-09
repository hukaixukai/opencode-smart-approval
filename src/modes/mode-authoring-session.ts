export type ModeAuthoringGrant = {
  readonly sessionID: string;
  readonly directory: string;
  readonly requirement: string;
  readonly revision: string;
  readonly createdAt: number;
};

export type ModeAuthoringCommand = {
  readonly command: string;
  readonly arguments: string;
  readonly sessionID: string;
  readonly directory: string;
  readonly revision: string;
};

type ModeAuthoringMessageInput = {
  readonly sessions: ModeAuthoringSessions;
  readonly sessionID: string;
  readonly directory: string;
  readonly revision: string;
  readonly parts: Array<{ type?: string; text?: string; synthetic?: boolean }>;
};

const CREATION_COMMANDS = new Set(["approval-edit", "ae", "approval-new", "an"]);

export class ModeAuthoringSessions {
  readonly #grants = new Map<string, ModeAuthoringGrant>();

  authorizeCommand(input: ModeAuthoringCommand): ModeAuthoringGrant | undefined {
    const requirement = input.arguments.trim();
    if (!CREATION_COMMANDS.has(input.command) || requirement.length === 0) return undefined;
    const grant: ModeAuthoringGrant = Object.freeze({
      sessionID: input.sessionID,
      directory: input.directory,
      requirement,
      revision: input.revision,
      createdAt: Date.now(),
    });
    this.#grants.set(input.sessionID, grant);
    return grant;
  }

  require(sessionID: string): ModeAuthoringGrant {
    const grant = this.#grants.get(sessionID);
    if (!grant) throw new Error("this session is not authorized to create an approval mode; use /ae <requirement> or /an <requirement>");
    return grant;
  }

  complete(sessionID: string): void {
    this.#grants.delete(sessionID);
  }

  revoke(_reason: "idle" | "error" | "deleted", sessionID: string): void {
    this.#grants.delete(sessionID);
  }

  dispose(): void {
    this.#grants.clear();
  }
}

export const modeAuthoringPrompt = (requirement: string): string => `
You are creating one new Smart Approval mode from the user's requirement below.

User requirement:
${requirement}

Use the current conversation for intent and paths. You may read command-approval.jsonc and related project files for reference, but the mode policy file is read-only: never edit, overwrite, move, or delete it. Inspect the approval_mode_create tool schema, then call it exactly once with one new mode and every permission preset it references. Mode IDs use lowercase letters, digits, and underscores. Preset IDs must be namespaced as <mode_id>.<name>. Include at least one space and an other fallback. Display names must be short Chinese labels: do not use English words, brackets, parentheses, or explanatory suffixes in mode, space, or preset names. Keep the gray-list strategy in the structured undecided_strategy field; do not encode it in names. Do not activate, overwrite, delete, or directly edit configuration files. If validation rejects the draft, correct it and call the tool again before replying.
`.trim();

export const modeAuthoringPromptParts = (requirement: string): Array<{ type: "text"; text: string; synthetic?: boolean }> => [
  { type: "text", text: requirement },
  { type: "text", text: modeAuthoringPrompt(requirement), synthetic: true },
];

/**
 * OpenCode's TUI sends slash commands with arguments through chat.message
 * instead of command.executed. Append only an internal synthetic authoring
 * instruction, preserving the original user prompt and normal chat.
 */
export const authorizeModeAuthoringMessage = (input: ModeAuthoringMessageInput): ModeAuthoringGrant | undefined => {
  const part = input.parts.find((candidate) => candidate.type === "text" && candidate.synthetic !== true && typeof candidate.text === "string");
  if (!part?.text) return undefined;
  const match = part.text.match(/^\/(approval-edit|ae|approval-new|an)\s+([\s\S]+)$/);
  if (!match?.[2]?.trim()) return undefined;

  const grant = input.sessions.authorizeCommand({
    command: match[1],
    arguments: match[2],
    sessionID: input.sessionID,
    directory: input.directory,
    revision: input.revision,
  });
  if (!grant) return undefined;
  input.parts.push(...modeAuthoringPromptParts(grant.requirement).slice(1));
  return grant;
};
