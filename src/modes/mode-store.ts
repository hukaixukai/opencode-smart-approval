import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  ApprovalModeSchema,
  MasterApprovalConfigSchema,
  PermissionPresetSchema,
  SpaceDefinitionSchema,
  type ApprovalMode,
  type MasterApprovalConfig,
  type PermissionPreset,
} from "../permissions/master-schema";
import {
  effectivePolicyPath,
  loadMasterPolicy,
  saveMasterPolicyAtomic,
} from "../permissions/master-config";
import { normalizeModeDraftDisplayNames as normalizeDraftDisplayNames } from "../display-names";

export const normalizeModeDraftDisplayNames = normalizeDraftDisplayNames;

const MODE_ID = /^[a-z][a-z0-9_]{1,63}$/u;
const PRESET_SUFFIX = /^[a-z][a-z0-9_]{0,63}$/u;
const PROTECTED_MODES = new Set(["delegate", "full_allow"]);

export const ModeDraftSchema = z.object({
  mode: ApprovalModeSchema.extend({
    id: z.string().regex(MODE_ID),
    spaces: z.array(SpaceDefinitionSchema).min(1),
  }).strict(),
  presets: z.array(PermissionPresetSchema.strict()).min(1),
}).strict();

export type ModeDraft = z.infer<typeof ModeDraftSchema>;

export type ModeMutationResult = {
  readonly modeID: string;
  readonly revision: string;
};

const revisionForPath = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

export const policyRevision = (directory?: string): string => revisionForPath(effectivePolicyPath(directory));

const assertRevision = (directory: string | undefined, expected: string | undefined): void => {
  if (expected !== undefined && policyRevision(directory) !== expected) {
    throw new Error("approval policy changed while the mode was being authored");
  }
};

const referencedPresetIDs = (mode: ApprovalMode): readonly string[] => [
  ...mode.spaces.map((space) => space.preset),
  mode.other.preset,
];

const validateRuleExpressions = (preset: PermissionPreset): void => {
  for (const rule of [...preset.rules.allow, ...preset.rules.deny]) {
    try {
      const expression = rule.match.includes("*")
        ? `^${rule.match.replace(/\*/gu, ".*")}$`
        : `^${rule.match}$`;
      new RegExp(expression, "u");
    } catch {
      throw new Error(`invalid rule expression in preset ${preset.id}: ${rule.match}`);
    }
  }
};

const validateDraft = (input: unknown): ModeDraft => {
  const draft = normalizeModeDraftDisplayNames(ModeDraftSchema.parse(input));
  if (PROTECTED_MODES.has(draft.mode.id)) throw new Error(`protected mode ID: ${draft.mode.id}`);

  const spaceIDs = new Set<string>();
  for (const space of draft.mode.spaces) {
    if (spaceIDs.has(space.id)) throw new Error(`duplicate space ID: ${space.id}`);
    spaceIDs.add(space.id);
    for (const path of space.paths) {
      if (!(path.startsWith("/") || path.startsWith("~/")) || /[$\0\r\n]/u.test(path)) {
        throw new Error(`invalid space path: ${path}`);
      }
    }
  }

  const presetIDs = new Set<string>();
  const prefix = `${draft.mode.id}.`;
  for (const preset of draft.presets) {
    const suffix = preset.id.startsWith(prefix) ? preset.id.slice(prefix.length) : "";
    if (!PRESET_SUFFIX.test(suffix)) throw new Error(`preset ID must use namespace ${prefix}<name>: ${preset.id}`);
    if (presetIDs.has(preset.id)) throw new Error(`duplicate preset ID: ${preset.id}`);
    presetIDs.add(preset.id);
    validateRuleExpressions(preset);
  }
  for (const presetID of referencedPresetIDs(draft.mode)) {
    if (!presetIDs.has(presetID)) {
      throw new Error(`referenced preset must be included in this submission: ${presetID}`);
    }
  }
  return draft;
};

const validateCompletePolicy = (config: MasterApprovalConfig): MasterApprovalConfig => {
  const parsed = MasterApprovalConfigSchema.parse(config);
  if (!parsed.modes[parsed.active_mode]) throw new Error(`active mode does not exist: ${parsed.active_mode}`);
  for (const [modeKey, mode] of Object.entries(parsed.modes)) {
    if (modeKey !== mode.id) throw new Error(`mode key does not match ID: ${modeKey}`);
    for (const presetID of referencedPresetIDs(mode)) {
      if (!parsed.presets[presetID]) throw new Error(`mode ${mode.id} references missing preset ${presetID}`);
    }
  }
  for (const [presetKey, preset] of Object.entries(parsed.presets)) {
    if (presetKey !== preset.id) throw new Error(`preset key does not match ID: ${presetKey}`);
  }
  return parsed;
};

export const createMode = (
  directory: string | undefined,
  input: unknown,
  expectedRevision?: string,
): ModeMutationResult => {
  const draft = validateDraft(input);
  assertRevision(directory, expectedRevision);
  const current = loadMasterPolicy(directory);
  if (current.modes[draft.mode.id]) throw new Error(`mode already exists: ${draft.mode.id}`);
  for (const preset of draft.presets) {
    if (current.presets[preset.id]) throw new Error(`preset already exists: ${preset.id}`);
  }
  const next = validateCompletePolicy({
    ...current,
    modes: { ...current.modes, [draft.mode.id]: draft.mode },
    presets: {
      ...current.presets,
      ...Object.fromEntries(draft.presets.map((preset) => [preset.id, preset])),
    },
  });
  saveMasterPolicyAtomic(next, directory);
  return { modeID: draft.mode.id, revision: policyRevision(directory) };
};

export const deleteMode = (directory: string | undefined, modeID: string): ModeMutationResult => {
  if (PROTECTED_MODES.has(modeID)) throw new Error(`protected mode cannot be deleted: ${modeID}`);
  const current = loadMasterPolicy(directory);
  if (current.active_mode === modeID) throw new Error(`active mode cannot be deleted: ${modeID}`);
  if (!current.modes[modeID]) throw new Error(`mode does not exist: ${modeID}`);

  const modes = { ...current.modes };
  delete modes[modeID];
  const referenced = new Set(Object.values(modes).flatMap(referencedPresetIDs));
  const presets = Object.fromEntries(Object.entries(current.presets).filter(([presetID]) =>
    !presetID.startsWith(`${modeID}.`) || referenced.has(presetID)
  ));
  const next = validateCompletePolicy({ ...current, modes, presets });
  saveMasterPolicyAtomic(next, directory);
  return { modeID, revision: policyRevision(directory) };
};

export const isProtectedMode = (modeID: string): boolean => PROTECTED_MODES.has(modeID);
