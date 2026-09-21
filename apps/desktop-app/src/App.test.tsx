/** @vitest-environment jsdom */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TextContext } from "@non-native-writing/application";
import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  App,
  type DesktopControllerFactory,
  type DesktopControllerPort,
} from "./App.js";
import type {
  DesktopAssistanceItem,
  DesktopAssistancePresentation,
  DesktopNativeIntentPresentation,
  DesktopNativeIntentTarget,
  PresentDesktopAssistance,
} from "./controller/desktop-engine-controller.js";
import type { DesktopProviderSettingsView } from "./settings/desktop-settings-controller.js";
import "./styles.css";

const desktopStyles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

function item(
  sourceText: string,
  options: Partial<DesktopAssistanceItem> = {},
): DesktopAssistanceItem {
  return Object.freeze({
    sourceText,
    status: "completed",
    statusMessage: "Analysis ready",
    nativeIntent: null,
    nativeIntentTracks: Object.freeze([]),
    normalizedTracks: Object.freeze([]),
    ...options,
  });
}

const COMPLETED_PRESENTATION: DesktopAssistancePresentation = Object.freeze({
  active: item("原文\nsource", {
    nativeIntentTracks: Object.freeze([
      Object.freeze({
        id: "native" as never,
        text: "含义第一行\nMeaning second line",
      }),
    ]),
    normalizedTracks: Object.freeze([
      Object.freeze({
        id: "normalized" as never,
        text: "Normalized first\n规范第二行",
      }),
    ]),
  }),
  recent: Object.freeze([
    item("Earlier.", {
      nativeIntentTracks: Object.freeze([
        Object.freeze({ id: "recent-native" as never, text: "Earlier intent" }),
      ]),
      normalizedTracks: Object.freeze([
        Object.freeze({ id: "recent-normalized" as never, text: "Earlier normalized" }),
      ]),
    }),
  ]),
});

class StubController implements DesktopControllerPort {
  readonly observed: TextContext[] = [];
  readonly present: PresentDesktopAssistance;
  readonly onObserve?: (context: TextContext) => void;
  disposed = false;
  confirmationResult: "confirmed" | "obsolete" = "confirmed";
  readonly actions: Array<{ name: string; args: readonly unknown[] }> = [];

  constructor(
    present: PresentDesktopAssistance,
    onObserve?: (context: TextContext) => void,
  ) {
    this.present = present;
    this.onObserve = onObserve;
  }

  observe(context: TextContext): void {
    this.observed.push(context);
    this.onObserve?.(context);
  }

  confirmNativeIntent(
    target: DesktopNativeIntentTarget,
    text: string,
  ): "confirmed" | "obsolete" {
    this.actions.push({ name: "confirmNativeIntent", args: [target, text] });
    return this.confirmationResult;
  }

  async addProfile(providerId: string): Promise<void> {
    this.actions.push({ name: "addProfile", args: [providerId] });
  }

  async updateProfile(profileId: string, patch: unknown): Promise<void> {
    this.actions.push({ name: "updateProfile", args: [profileId, patch] });
  }

  async setActiveProfile(profileId: string | null): Promise<void> {
    this.actions.push({ name: "setActiveProfile", args: [profileId] });
  }

  async deleteProfile(profileId: string): Promise<void> {
    this.actions.push({ name: "deleteProfile", args: [profileId] });
  }

  async saveCredential(profileId: string, secret: string): Promise<void> {
    this.actions.push({ name: "saveCredential", args: [profileId, secret] });
  }

  async removeCredential(profileId: string): Promise<void> {
    this.actions.push({ name: "removeCredential", args: [profileId] });
  }

  dispose(): void {
    this.disposed = true;
  }
}

describe("desktop engine UI", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function renderApp(factory?: DesktopControllerFactory): void {
    const resolvedFactory =
      factory ?? ((present: PresentDesktopAssistance) => new StubController(present));
    act(() => root.render(<App createController={resolvedFactory} />));
  }

  function renderWithPresentation(
    presentation: DesktopAssistancePresentation,
  ): StubController {
    let instance!: StubController;
    const factory: DesktopControllerFactory = (present) => {
      instance = new StubController(present);
      return instance;
    };
    renderApp(factory);
    act(() => instance.present(presentation));
    return instance;
  }

  function enterText(editor: HTMLTextAreaElement, value: string): void {
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    if (valueSetter === undefined) {
      throw new Error("The textarea value setter is unavailable.");
    }
    valueSetter.call(editor, value);
    editor.setSelectionRange(value.length, value.length);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("renders the active source exactly", () => {
    renderWithPresentation(COMPLETED_PRESENTATION);
    const source = container.querySelector(
      ".assistance-result.is-active .assistance-card .track-text",
    );
    expect(source?.textContent).toBe("原文\nsource");
  });

  it("renders Native Intent output", () => {
    renderWithPresentation(COMPLETED_PRESENTATION);
    expect(container.textContent).toContain("含义第一行");
    expect(container.textContent).toContain("Meaning second line");
  });

  it("renders Normalized output", () => {
    renderWithPresentation(COMPLETED_PRESENTATION);
    expect(container.textContent).toContain("Normalized first");
    expect(container.textContent).toContain("规范第二行");
  });

  it("renders recent assistance separately from the active unit", () => {
    renderWithPresentation(COMPLETED_PRESENTATION);
    const recent = container.querySelector(".recent-assistance");
    expect(recent?.textContent).toContain("Earlier.");
    expect(recent?.textContent).toContain("Earlier intent");
  });

  it("shows configuration-required state instead of development analysis", () => {
    renderApp();
    expect(container.querySelector(".configuration-badge")?.textContent).toBe(
      "Configuration required",
    );
    expect(container.textContent).not.toContain("Development analysis");
  });

  it("renders the analyzing state", () => {
    renderWithPresentation({
      active: item("Draft", {
        status: "analyzing",
        statusMessage: "Analyzing…",
      }),
      recent: [],
    });
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Analyzing…",
    );
  });

  it("renders a safe failed state without exposing an error object", () => {
    renderWithPresentation({
      active: item("Draft", {
        status: "failed",
        statusMessage: "Analysis failed. Continue editing or try again.",
      }),
      recent: [],
    });
    expect(container.textContent).toContain("Analysis failed");
    expect(container.textContent).not.toContain("controlled failure");
  });

  it("renders multiline Native Intent in one preserved text block", () => {
    renderWithPresentation(COMPLETED_PRESENTATION);
    const blocks = [...container.querySelectorAll(".track-text")];
    const native = blocks.find((block) => block.textContent?.startsWith("含义"));
    expect(native?.textContent).toBe("含义第一行\nMeaning second line");
    expect(desktopStyles).toMatch(/\.track-text\s*\{[^}]*white-space:\s*pre-wrap;/s);
  });

  it("renders multiline Normalized output in one preserved text block", () => {
    renderWithPresentation(COMPLETED_PRESENTATION);
    const blocks = [...container.querySelectorAll(".track-text")];
    const normalized = blocks.find((block) =>
      block.textContent?.startsWith("Normalized"),
    );
    expect(normalized?.textContent).toBe("Normalized first\n规范第二行");
  });

  it("renders an editable inferred Native Intent with explicit actions", () => {
    const intent = nativeIntent("第一行\n\nMeaning 😀");
    renderWithPresentation({
      active: item("Source", { nativeIntent: intent }),
      recent: [],
    });

    const draft = container.querySelector(
      '[aria-label="Native Intent draft"]',
    ) as HTMLTextAreaElement;
    expect(draft.value).toBe("第一行\n\nMeaning 😀");
    expect(draft.wrap).toBe("soft");
    expect(button("Confirm")).not.toBeUndefined();
    expect(button("Reset Draft")).not.toBeUndefined();
  });

  it("keeps draft editing local and confirms the exact text", () => {
    const intent = nativeIntent("Inferred");
    const instance = renderWithPresentation({
      active: item("Source remains", { nativeIntent: intent }),
      recent: [],
    });
    const writing = container.querySelector("#writing-editor") as HTMLTextAreaElement;
    const draft = container.querySelector(
      '[aria-label="Native Intent draft"]',
    ) as HTMLTextAreaElement;
    const exact = "编辑后\n\n1. emoji 😀\n2. trailing  ";

    act(() => enterText(draft, exact));

    expect(writing.value).toBe("");
    expect(instance.actions).toEqual([]);
    act(() => button("Confirm")?.click());
    expect(instance.actions).toContainEqual({
      name: "confirmNativeIntent",
      args: [intent.target, exact],
    });
  });

  it.each([
    ["inferred", "Inferred current"],
    ["confirmed", "Confirmed current"],
  ] as const)("resets a %s draft to its current semantic value", (state, value) => {
    renderWithPresentation({
      active: item("Source", { nativeIntent: nativeIntent(value, state) }),
      recent: [],
    });
    const draft = container.querySelector(
      '[aria-label="Native Intent draft"]',
    ) as HTMLTextAreaElement;
    act(() => enterText(draft, "Local edits"));
    act(() => button("Reset Draft")?.click());
    expect(draft.value).toBe(value);
  });

  it("does not let a background inferred result overwrite the edited draft", () => {
    const initial = nativeIntent("Initial model value");
    const instance = renderWithPresentation({
      active: item("Source", { nativeIntent: initial }),
      recent: [],
    });
    const draft = container.querySelector(
      '[aria-label="Native Intent draft"]',
    ) as HTMLTextAreaElement;
    act(() => enterText(draft, "My local draft"));

    act(() => instance.present({
      active: item("Source", {
        nativeIntent: nativeIntent("Later model value", "inferred", {
          trackId: "native-later",
          trackRevision: 4,
        }),
      }),
      recent: [],
    }));

    expect((container.querySelector(
      '[aria-label="Native Intent draft"]',
    ) as HTMLTextAreaElement).value).toBe("My local draft");
  });

  it("discards the draft when the active semantic target changes", () => {
    const instance = renderWithPresentation({
      active: item("Unit one", { nativeIntent: nativeIntent("Intent one") }),
      recent: [],
    });
    const draft = container.querySelector(
      '[aria-label="Native Intent draft"]',
    ) as HTMLTextAreaElement;
    act(() => enterText(draft, "Unconfirmed unit one edit"));

    act(() => instance.present({
      active: item("Unit two", {
        nativeIntent: nativeIntent("Intent two", "inferred", {
          segmentId: "segment-two",
          unitId: "unit-two",
        }),
      }),
      recent: [],
    }));

    expect((container.querySelector(
      '[aria-label="Native Intent draft"]',
    ) as HTMLTextAreaElement).value).toBe("Intent two");
  });

  it("shows a safe obsolete-target message when confirmation is rejected", () => {
    const instance = renderWithPresentation({
      active: item("Source", { nativeIntent: nativeIntent("Intent") }),
      recent: [],
    });
    instance.confirmationResult = "obsolete";
    act(() => button("Confirm")?.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "earlier source",
    );
  });

  it("shows the Confirmed indicator and retains confirmed text in a failed state", () => {
    renderWithPresentation({
      active: item("Source", {
        status: "failed",
        statusMessage: "Network request failed",
        nativeIntent: nativeIntent("确认仍然存在", "confirmed"),
      }),
      recent: [],
    });
    expect(container.querySelector(".confirmed-indicator")?.textContent).toBe(
      "Confirmed",
    );
    expect((container.querySelector(
      '[aria-label="Native Intent draft"]',
    ) as HTMLTextAreaElement).value).toBe("确认仍然存在");
    expect(container.textContent).toContain("Network request failed");
  });

  it("keeps Recent Assistance read-only", () => {
    renderWithPresentation({
      active: null,
      recent: [item("Recent", {
        nativeIntent: nativeIntent("Recent confirmed", "confirmed"),
        nativeIntentTracks: Object.freeze([
          Object.freeze({ id: "recent" as never, text: "Recent confirmed" }),
        ]),
      })],
    });
    const recent = container.querySelector(".recent-assistance")!;
    expect(recent.textContent).toContain("Recent confirmed");
    expect(recent.querySelector("textarea")).toBeNull();
    expect([...recent.querySelectorAll("button")]).toHaveLength(0);
  });

  it("clears a transient draft when the assistance session resets", () => {
    const presentation = {
      active: item("Source", { nativeIntent: nativeIntent("Original") }),
      recent: [],
    };
    const instance = renderWithPresentation(presentation);
    act(() => enterText(
      container.querySelector('[aria-label="Native Intent draft"]')!,
      "Transient edit",
    ));
    act(() => instance.present({ active: null, recent: [] }));
    act(() => instance.present(presentation));
    expect((container.querySelector(
      '[aria-label="Native Intent draft"]',
    ) as HTMLTextAreaElement).value).toBe("Original");
  });

  it("updates assistance on cursor navigation without mutating editor text", () => {
    let instance!: StubController;
    const factory: DesktopControllerFactory = (present) => {
      instance = new StubController(present, (observed) => {
        present({
          active: item(observed.cursorOffset < 5 ? "First." : "Second."),
          recent: [],
        });
      });
      return instance;
    };
    renderApp(factory);
    const editor = container.querySelector("textarea")!;
    act(() => enterText(editor, "First. Second."));
    const exactText = editor.value;

    act(() => {
      editor.setSelectionRange(1, 1);
      editor.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "ArrowLeft" }));
    });
    expect(container.querySelector(".is-active")?.textContent).toContain("First.");

    act(() => {
      editor.setSelectionRange(9, 9);
      editor.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector(".is-active")?.textContent).toContain("Second.");
    expect(editor.value).toBe(exactText);
  });

  it("preserves mixed-language input and explicit soft wrapping", () => {
    renderApp();
    const editor = container.querySelector("textarea")!;
    const value = `这是中文${"uninterrupted".repeat(30)}English`;
    act(() => enterText(editor, value));

    expect(editor.wrap).toBe("soft");
    expect(editor.value).toBe(value);
    expect(editor.value).not.toContain("\n");
    expect(getComputedStyle(editor).textAlign).toBe("start");
  });

  it("disposes the controller when React unmounts", () => {
    let instance!: StubController;
    renderApp((present) => {
      instance = new StubController(present);
      return instance;
    });
    act(() => root.unmount());
    expect(instance.disposed).toBe(true);
    root = createRoot(container);
  });

  it("keeps only one live controller pipeline under StrictMode", () => {
    const instances: StubController[] = [];
    const factory: DesktopControllerFactory = (present) => {
      const instance = new StubController(present);
      instances.push(instance);
      return instance;
    };
    act(() =>
      root.render(
        <StrictMode>
          <App createController={factory} />
        </StrictMode>,
      ),
    );
    expect(instances).toHaveLength(2);
    expect(instances[0]!.disposed).toBe(true);
    expect(instances[1]!.disposed).toBe(false);
    const disposedObservationCount = instances[0]!.observed.length;

    const editor = container.querySelector("textarea")!;
    act(() => enterText(editor, "one pipeline"));
    expect(instances[0]!.observed).toHaveLength(disposedObservationCount);
    expect(instances[1]!.observed.at(-1)?.text).toBe("one pipeline");
  });

  it("opens provider settings and can add a profile", () => {
    let instance!: StubController;
    const settings: DesktopProviderSettingsView = {
      loading: false,
      activeProfileId: null,
      configurationRequired: true,
      providers: [{ id: "openai", name: "OpenAI" }],
      compatibilityModes: ["json-schema", "json-object", "prompt-json"],
      profiles: [],
    };
    renderApp((present, presentSettings) => {
      instance = new StubController(present);
      presentSettings(settings);
      return instance;
    });
    act(() => (container.querySelector("[aria-expanded]") as HTMLButtonElement).click());
    expect(container.querySelector('[aria-label="Provider settings"]')).not.toBeNull();
    act(() => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Add Profile")?.click();
    });
    expect(instance.actions).toContainEqual({ name: "addProfile", args: ["openai"] });
  });

  it("keeps arbitrary model IDs editable and switches the active profile", () => {
    let instance!: StubController;
    const settings = configuredSettingsView();
    renderApp((present, presentSettings) => {
      instance = new StubController(present);
      presentSettings(settings);
      return instance;
    });
    act(() => (container.querySelector("[aria-expanded]") as HTMLButtonElement).click());
    const model = container.querySelector('[aria-label="Model ID"]') as HTMLInputElement;
    act(() => setInputValue(model, "future-model-any-string"));
    const active = container.querySelector('[aria-label="Active profile"]') as HTMLSelectElement;
    act(() => setSelectValue(active, "profile-one"));
    expect(instance.actions).toContainEqual({
      name: "updateProfile",
      args: ["profile-one", { modelId: "future-model-any-string" }],
    });
    expect(instance.actions).toContainEqual({
      name: "setActiveProfile",
      args: ["profile-one"],
    });
  });

  it("clears the API key after save and never renders a stored key", async () => {
    let instance!: StubController;
    renderApp((present, presentSettings) => {
      instance = new StubController(present);
      presentSettings(configuredSettingsView());
      return instance;
    });
    act(() => (container.querySelector("[aria-expanded]") as HTMLButtonElement).click());
    const keyInput = container.querySelector('[aria-label="API key"]') as HTMLInputElement;
    act(() => setInputValue(keyInput, "typed-secret-never-render"));
    await act(async () => {
      keyInput.closest("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(instance.actions).toContainEqual({
      name: "saveCredential",
      args: ["profile-one", "typed-secret-never-render"],
    });
    expect(keyInput.value).toBe("");
    expect(container.textContent).toContain("API key: Configured");
    expect(container.textContent).not.toContain("typed-secret-never-render");
  });

  it("shows custom endpoint fields only for custom providers", () => {
    renderApp((present, presentSettings) => {
      presentSettings(configuredSettingsView("openai-compatible"));
      return new StubController(present);
    });
    act(() => (container.querySelector("[aria-expanded]") as HTMLButtonElement).click());
    expect(container.querySelector('[aria-label="Base URL"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Compatibility mode"]')).not.toBeNull();
  });
});

function configuredSettingsView(
  providerId = "openai",
): DesktopProviderSettingsView {
  return {
    loading: false,
    activeProfileId: null,
    configurationRequired: true,
    providers: [
      { id: "openai", name: "OpenAI" },
      { id: "openai-compatible", name: "OpenAI-compatible / custom" },
    ],
    compatibilityModes: ["json-schema", "json-object", "prompt-json"],
    profiles: [{
      id: "profile-one",
      name: "Primary",
      providerId,
      modelId: "initial-model",
      enabled: true,
      configured: true,
      valid: true,
      issues: [],
      ...(providerId === "openai-compatible"
        ? { baseUrl: "https://api.deepseek.com/v1", compatibilityMode: "json-object" as const }
        : {}),
    }],
  };
}

function setInputValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function setSelectValue(select: HTMLSelectElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function nativeIntent(
  text: string,
  state: "inferred" | "confirmed" = "inferred",
  overrides: {
    readonly segmentId?: string;
    readonly unitId?: string;
    readonly sourceRevision?: number;
    readonly trackId?: string;
    readonly trackRevision?: number;
  } = {},
): DesktopNativeIntentPresentation {
  return Object.freeze({
    text,
    state,
    target: Object.freeze({
      kind: "unit" as const,
      segmentId: (overrides.segmentId ?? "segment-one") as never,
      unitId: overrides.unitId ?? "unit-one",
      sourceRevision: overrides.sourceRevision ?? 1,
      trackId: (overrides.trackId ?? "native-one") as never,
      trackRevision: overrides.trackRevision ?? (state === "confirmed" ? 2 : 1),
    }),
  });
}

function button(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
}
