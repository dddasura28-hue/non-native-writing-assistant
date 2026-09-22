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

  it("keeps Windows UIA behind one fixed-purpose native capture event", () => {
    const adapter = readFileSync(
      resolve(
        repositoryRoot,
        "apps/desktop-app/src/native/windows-active-text-surface.ts",
      ),
      "utf8",
    );
    expect(adapter).not.toMatch(
      /HWND|processId|windowTitle|runtimeId|AutomationElement|SendInput|SendKeys|clipboard/,
    );
    const shortcutBridge = readFileSync(
      resolve(
        repositoryRoot,
        "apps/desktop-app/src/native/windows-global-shortcut-bridge.ts",
      ),
      "utf8",
    );
    expect(shortcutBridge).toContain('"windows-global-capture"');
    expect(shortcutBridge).not.toMatch(
      /HWND|processId|windowTitle|runtimeId|AutomationElement|SendInput|SendKeys|clipboard/,
    );

    const rustRoot = resolve(
      repositoryRoot,
      "apps/desktop-app/src-tauri/src/windows",
    );
    const rustSource = readdirSync(rustRoot)
      .filter((name) => name.endsWith(".rs"))
      .map((name) => readFileSync(resolve(rustRoot, name), "utf8"))
      .join("\n");
    expect(rustSource).not.toMatch(
      /SendInput|SendKeys|OpenClipboard|SetClipboardData|RegisterHotKey/,
    );
    const shortcutSource = readFileSync(
      resolve(
        repositoryRoot,
        "apps/desktop-app/src-tauri/src/global_shortcut.rs",
      ),
      "utf8",
    );
    expect(shortcutSource).not.toMatch(/set_focus\s*\(/u);
  });

  it("configures one hidden non-focusable reusable global assistant window", () => {
    const config = JSON.parse(readFileSync(
      resolve(repositoryRoot, "apps/desktop-app/src-tauri/tauri.conf.json"),
      "utf8",
    )) as {
      app: { windows: Array<Record<string, unknown>> };
    };
    const assistant = config.app.windows.filter(
      (window) => window.label === "global-assistant",
    );

    expect(assistant).toHaveLength(1);
    expect(assistant[0]).toMatchObject({
      visible: false,
      focus: false,
      focusable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
    });
  });

  it("keeps shortcut registration native and grants only the event bridge", () => {
    const cargo = readFileSync(
      resolve(repositoryRoot, "apps/desktop-app/src-tauri/Cargo.toml"),
      "utf8",
    );
    const desktopPackage = JSON.parse(readFileSync(
      resolve(repositoryRoot, "apps/desktop-app/package.json"),
      "utf8",
    )) as { dependencies: Record<string, string> };
    const mainCapability = JSON.parse(readFileSync(
      resolve(
        repositoryRoot,
        "apps/desktop-app/src-tauri/capabilities/desktop-shell.json",
      ),
      "utf8",
    )) as { permissions: string[] };

    expect(cargo).toContain('tauri-plugin-global-shortcut = "=2.3.2"');
    expect(desktopPackage.dependencies)
      .not.toHaveProperty("@tauri-apps/plugin-global-shortcut");
    expect(mainCapability.permissions).toEqual([
      "core:event:allow-listen",
      "core:event:allow-unlisten",
      "core:event:allow-emit-to",
    ]);
    const assistantCapability = JSON.parse(readFileSync(
      resolve(
        repositoryRoot,
        "apps/desktop-app/src-tauri/capabilities/global-assistant.json",
      ),
      "utf8",
    )) as { permissions: string[] };
    expect(assistantCapability.permissions).toEqual([
      "core:event:allow-listen",
      "core:event:allow-unlisten",
    ]);
  });
});
