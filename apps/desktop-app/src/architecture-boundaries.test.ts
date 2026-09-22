import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

function filesBelow(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory()
      ? filesBelow(path)
      : /\.[cm]?tsx?$/.test(path)
        ? [path]
        : [];
  });
}

describe("desktop dependency boundaries", () => {
  it("keeps React, Tauri and the desktop host out of reusable packages", () => {
    for (const packageName of ["core", "application", "model-integration"]) {
      const sourceRoot = resolve(repositoryRoot, "packages", packageName, "src");
      for (const file of filesBelow(sourceRoot)) {
        const source = readFileSync(file, "utf8");
        expect(source, file).not.toMatch(
          /(?:@tauri-apps|\breact(?:-dom)?\b|apps[\\/]desktop-app)/,
        );
      }
    }
  });

  it("keeps all Tauri package dependencies inside the desktop app", () => {
    const manifests = [
      "package.json",
      "apps/dev-ai-gateway/package.json",
      "apps/obsidian-plugin/package.json",
      "packages/core/package.json",
      "packages/application/package.json",
      "packages/model-integration/package.json",
    ];

    for (const manifestPath of manifests) {
      const manifest = JSON.parse(
        readFileSync(resolve(repositoryRoot, manifestPath), "utf8"),
      ) as Record<string, Record<string, string> | undefined>;
      const dependencies = {
        ...manifest.dependencies,
        ...manifest.devDependencies,
      };
      expect(
        Object.keys(dependencies).filter((name) => name.startsWith("@tauri-apps/")),
        manifestPath,
      ).toEqual([]);
    }
  });

  it("keeps the future external-host boundary free of native platform APIs", () => {
    const boundaryFiles = [
      "apps/desktop-app/src/host/active-text-surface.ts",
      "apps/desktop-app/src/host/fake-active-text-surface.ts",
      "apps/desktop-app/src/controller/global-desktop-assistant-controller.ts",
    ];

    for (const relativePath of boundaryFiles) {
      const source = readFileSync(resolve(repositoryRoot, relativePath), "utf8");
      expect(source, relativePath).not.toMatch(
        /@tauri-apps|navigator\.|document\.|window\.|HWND|UIAutomation|clipboard|globalShortcut/,
      );
    }
  });
});
