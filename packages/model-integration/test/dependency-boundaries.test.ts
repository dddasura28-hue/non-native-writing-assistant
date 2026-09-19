import { readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packagesRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const allowed = {
  core: [],
  application: ["@non-native-writing/core"],
  "model-integration": ["zod"],
} satisfies Record<string, string[]>;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.[cm]?tsx?$/.test(path) ? [path] : [];
  }).sort();
}

// Includes static/type imports, re-exports, side effects, import types,
// dynamic imports and require. New dependencies require deliberate review.
function imports(source: string): string[] {
  return [...source.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)["']([^"']+)["']/g)]
    .map((match) => match[1]!);
}

function permitted(specifier: string, file: string, root: string, external: readonly string[]): boolean {
  if (!specifier.startsWith(".")) return external.includes(specifier);
  const destination = relative(root, resolve(dirname(file), specifier));
  return destination !== ".." && !destination.startsWith(`..\\`) && !destination.startsWith("../") && !isAbsolute(destination);
}

describe("reusable dependency boundaries", () => {
  for (const [name, external] of Object.entries(allowed)) {
    it(`${name} imports only its declared inward dependencies`, () => {
      const root = resolve(packagesRoot, name, "src");
      const manifest = JSON.parse(readFileSync(resolve(root, "../package.json"), "utf8"));
      for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
        for (const dependency of Object.keys(manifest[section] ?? {})) {
          expect(external, `${name}: ${dependency}`).toContain(dependency);
        }
      }
      for (const file of sourceFiles(root)) {
        const source = readFileSync(file, "utf8");
        for (const specifier of imports(source)) {
          expect(permitted(specifier, file, root, external), `${file}: ${specifier}`).toBe(true);
        }
        // Computed module loading cannot be checked deterministically.
        expect(source, file).not.toMatch(/\b(?:import|require)\s*\(\s*[^\s"']/);
        const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, "");
        expect(code, file).not.toMatch(/\b(?:window|document|HTMLElement|HTMLInputElement|HTMLTextAreaElement|Document|Element|Node|Range|Selection|CompositionEvent|KeyboardEvent|TFile|MarkdownView|WorkspaceLeaf|EditorView)\b/);
      }
    });
  }

  it("recognizes all supported dependency syntaxes", () => {
    expect(imports(`import type { X } from "a"; export { X } from "b"; export * from "c"; import "d"; import("e"); require("f"); type T = import("g").T;`)).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
  });

  it("rejects host imports, sibling internals and relative app escapes", () => {
    const root = resolve(packagesRoot, "application/src");
    const file = resolve(root, "boundary.ts");
    for (const specifier of ["obsidian", "obsidian/editor", "openai", "@non-native-writing/obsidian-plugin", "@non-native-writing/model-integration", "../../../apps/obsidian-plugin/src/main.js", "../../core/src/index.js", "node:fs"]) {
      expect(permitted(specifier, file, root, allowed.application), specifier).toBe(false);
    }
    expect(permitted("./text-context.js", file, root, allowed.application)).toBe(true);
    expect(permitted("@non-native-writing/core", file, root, allowed.application)).toBe(true);
  });
});
