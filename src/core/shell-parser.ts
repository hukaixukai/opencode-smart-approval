import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { Language, Parser } from "web-tree-sitter";
import type { Node } from "web-tree-sitter";

type ParsedTreeVisitor<T> = (root: Node) => T;

let languagePromise: Promise<Language> | undefined;

export const resolveWasmPaths = (): { readonly core: string; readonly grammar: string } => {
  // 1. 尝试常规 resolve
  let corePath: string | undefined;
  try {
    corePath = fileURLToPath(import.meta.resolve("web-tree-sitter/web-tree-sitter.wasm"));
  } catch {}

  if (!corePath || !existsSync(corePath)) {
    const candidate1 = join(homedir(), ".config/opencode/node_modules/web-tree-sitter/web-tree-sitter.wasm");
    const candidate2 = resolve(__dirname, "../node_modules/web-tree-sitter/web-tree-sitter.wasm");
    const candidate3 = join(homedir(), ".cache/opencode/node_modules/web-tree-sitter/web-tree-sitter.wasm");
    if (existsSync(candidate1)) corePath = candidate1;
    else if (existsSync(candidate2)) corePath = candidate2;
    else if (existsSync(candidate3)) corePath = candidate3;
    else corePath = candidate1;
  }

  // 2. Grammar wasm path
  let grammarPath = fileURLToPath(new URL("../../assets/tree-sitter-bash.wasm", import.meta.url));
  if (!existsSync(grammarPath)) {
    const candidateG1 = join(homedir(), ".config/opencode/plugins/smart-approval/assets/tree-sitter-bash.wasm");
    if (existsSync(candidateG1)) grammarPath = candidateG1;
  }

  return { core: corePath, grammar: grammarPath };
};

const loadLanguage = async (): Promise<Language> => {
  const paths = resolveWasmPaths();
  await Parser.init({ locateFile: () => paths.core });
  return Language.load(paths.grammar);
};

const shellLanguage = (): Promise<Language> => {
  languagePromise ??= loadLanguage();
  return languagePromise;
};

export const withShellTree = async <T>(source: string, visit: ParsedTreeVisitor<T>): Promise<T> => {
  const language = await shellLanguage();
  const parser = new Parser();
  try {
    parser.setLanguage(language);
    const tree = parser.parse(source);
    if (!tree) throw new Error("Tree-sitter returned no syntax tree");
    try {
      return visit(tree.rootNode);
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
};
