const BRACKETED_SUFFIX = /\s*[\[（(].*?[\]）)]/gu;
const ENGLISH_WORD = /[A-Za-z]+/gu;

export const normalizeDisplayName = (name: string, fallback: string): string => {
  const cleaned = name
    .replace(BRACKETED_SUFFIX, "")
    .replace(ENGLISH_WORD, "")
    .replace(/[._-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return cleaned || fallback;
};

export const normalizeModeDraftDisplayNames = <T extends {
  mode: { name: string; spaces: Array<{ name: string }> };
  presets: Array<{ name: string }>;
}>(draft: T): T => ({
  ...draft,
  mode: {
    ...draft.mode,
    name: normalizeDisplayName(draft.mode.name, "未命名模式"),
    spaces: draft.mode.spaces.map((space) => ({
      ...space,
      name: normalizeDisplayName(space.name, "未命名空间"),
    })),
  },
  presets: draft.presets.map((preset) => ({
    ...preset,
    name: normalizeDisplayName(preset.name, "未命名预设"),
  })),
});
