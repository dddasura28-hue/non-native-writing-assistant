/** @vitest-environment jsdom */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  TextContext,
  TextEditPort,
} from "@non-native-writing/application";
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
  DesktopNormalizedAcceptTarget,
  DesktopNormalizedPresentation,
  PresentDesktopAssistance,
} from "./controller/desktop-engine-controller.js";
import {
  EMPTY_GLOBAL_DESKTOP_ASSISTANCE,
  type GlobalDesktopAssistantPresentation,
  type PresentGlobalDesktopAssistant,
} from "./controller/global-desktop-assistant-controller.js";
import type { DesktopProviderSettingsView } from "./settings/desktop-settings-controller.js";
import type { TextareaTextAnchor } from "./host/textarea-text-anchor.js";
import "./styles.css";

const desktopStyles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

function item(
  sourceText: string,
  options: Partial<DesktopAssistanceItem> = {},
): DesktopAssistanceItem {
  return Object.freeze({
    targetKind: "cursor-unit",
    sourceText,
    status: "completed",
    statusMessage: "Analysis ready",
    inlineStatusMessage: undefined,
    nativeIntent: null,
    nativeIntentTracks: Object.freeze([]),
    normalizedTracks: Object.freeze([]),
    ...options,
  });
}

function normalized(
  id: string,
  text: string,
  options: Partial<DesktopNormalizedPresentation> = {},
): DesktopNormalizedPresentation {
  return Object.freeze({
    id: id as never,
    text,
    canAccept: false,
    acceptTarget: null,
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
      normalized("normalized", "Normalized first\n规范第二行"),
    ]),
  }),
  recent: Object.freeze([
    item("Earlier.", {
      nativeIntentTracks: Object.freeze([
        Object.freeze({ id: "recent-native" as never, text: "Earlier intent" }),
      ]),
      normalizedTracks: Object.freeze([
        normalized("recent-normalized", "Earlier normalized"),
      ]),
    }),
  ]),
});

class StubController implements DesktopControllerPort {
  readonly observed: TextContext[] = [];
  editPort: TextEditPort | null = null;
  readonly present: PresentDesktopAssistance;
  readonly presentGlobal?: PresentGlobalDesktopAssistant;
  readonly onObserve?: (context: TextContext) => void;
  disposed = false;
  confirmationResult: "confirmed" | "obsolete" = "confirmed";
  acceptReplacementText: string | null = null;
  readonly actions: Array<{ name: string; args: readonly unknown[] }> = [];

  constructor(
    present: PresentDesktopAssistance,
    onObserve?: (context: TextContext) => void,
    presentGlobal?: PresentGlobalDesktopAssistant,
  ) {
    this.present = present;
    this.onObserve = onObserve;
    this.presentGlobal = presentGlobal;
  }

  observe(context: TextContext, editPort?: TextEditPort | null): void {
    this.observed.push(context);
    if (editPort !== undefined) {
      this.editPort = editPort;
    }
    this.onObserve?.(context);
  }

  confirmNativeIntent(
    target: DesktopNativeIntentTarget,
    text: string,
  ): "confirmed" | "obsolete" {
    this.actions.push({ name: "confirmNativeIntent", args: [target, text] });
    return this.confirmationResult;
  }

  async acceptNormalized(
    target: DesktopNormalizedAcceptTarget,
  ): Promise<"accepted" | "obsolete"> {
    this.actions.push({ name: "acceptNormalized", args: [target] });
    if (this.acceptReplacementText !== null && this.editPort !== null) {
      await this.editPort.replace({
        range: target.range,
        expectedText: target.expectedText,
        replacementText: this.acceptReplacementText,
      });
    }
    return "accepted";
  }

  async analyzeWindowsActiveTextSurface(): Promise<"unavailable"> {
    this.actions.push({ name: "analyzeWindowsActiveTextSurface", args: [] });
    return "unavailable";
  }

  async acceptWindowsNormalized(
    target: DesktopNormalizedAcceptTarget,
  ): Promise<"obsolete"> {
    this.actions.push({ name: "acceptWindowsNormalized", args: [target] });
    return "obsolete";
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
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function renderApp(
    factory?: DesktopControllerFactory,
    measureTextAnchor?: (
      textarea: HTMLTextAreaElement,
      container: HTMLElement,
      caretOffset: number,
    ) => TextareaTextAnchor | null,
  ): void {
    const resolvedFactory =
      factory ?? ((present: PresentDesktopAssistance) => new StubController(present));
    act(() => root.render(
      <App
        createController={resolvedFactory}
        measureTextAnchor={measureTextAnchor}
      />,
    ));
  }

  function renderWithPresentation(
    presentation: DesktopAssistancePresentation,
    measureTextAnchor?: (
      textarea: HTMLTextAreaElement,
      container: HTMLElement,
      caretOffset: number,
    ) => TextareaTextAnchor | null,
  ): StubController {
    let instance!: StubController;
    const factory: DesktopControllerFactory = (present) => {
      instance = new StubController(present);
      return instance;
    };
    renderApp(factory, measureTextAnchor);
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

  it("shows an accessible Accept control for each current Normalized variant", () => {
    const firstTarget = normalizedAcceptTarget({
      trackId: "normalized-first" as never,
    });
    const secondTarget = normalizedAcceptTarget({
      trackId: "normalized-second" as never,
    });
    const instance = renderWithPresentation({
      active: item("Old.", {
        normalizedTracks: Object.freeze([
          normalized("normalized-first", "First wording.", {
            label: "Concise",
            canAccept: true,
            acceptTarget: firstTarget,
          }),
          normalized("normalized-second", "Second wording.", {
            label: "Natural",
            canAccept: true,
            acceptTarget: secondTarget,
          }),
        ]),
      }),
      recent: [],
    });

    const acceptButtons = [
      ...container.querySelectorAll<HTMLButtonElement>(".normalized-accept"),
    ];
    expect(acceptButtons.map((candidate) => candidate.getAttribute("aria-label")))
      .toEqual([
        "Accept Normalized variant Concise",
        "Accept Normalized variant Natural",
      ]);
    expect(acceptButtons.every((candidate) => !candidate.disabled)).toBe(true);

    act(() => acceptButtons[1]!.click());
    expect(instance.actions).toContainEqual({
      name: "acceptNormalized",
      args: [secondTarget],
    });
  });

  it("does not expose an enabled Accept control for stale wording", () => {
    renderWithPresentation({
      active: item("Current source", {
        normalizedTracks: Object.freeze([
          normalized("stale-normalized", "Old wording"),
        ]),
      }),
      recent: [],
    });

    expect(
      container.querySelector<HTMLButtonElement>(".normalized-accept")?.disabled,
    ).toBe(true);
  });

  it("applies Accept through the captured edit port and synchronizes the textarea", async () => {
    let instance!: StubController;
    const target = normalizedAcceptTarget();
    const factory: DesktopControllerFactory = (present) => {
      instance = new StubController(present, (observed) => {
        if (observed.text === "New\n新.") {
          present({ active: item(observed.text), recent: [] });
        }
      });
      instance.acceptReplacementText = "New\n新.";
      return instance;
    };
    renderApp(factory);
    const editor = container.querySelector("#writing-editor") as HTMLTextAreaElement;
    act(() => enterText(editor, "Old."));
    act(() => instance.present({
      active: item("Old.", {
        nativeIntent: nativeIntent("Transient draft"),
        normalizedTracks: Object.freeze([
          normalized("normalized-one", "New\n新.", {
            canAccept: true,
            acceptTarget: target,
          }),
        ]),
      }),
      recent: [],
    }));

    await act(async () => {
      button("Accept")?.click();
      await Promise.resolve();
    });

    expect(editor.value).toBe("New\n新.");
    expect(editor.selectionStart).toBe("New\n新.".length);
    expect(editor.selectionEnd).toBe("New\n新.".length);
    expect(instance.observed.at(-1)?.text).toBe("New\n新.");
    expect(container.querySelector('[aria-label="Native Intent draft"]')).toBeNull();
  });

  it("replaces only an explicit selected source range", async () => {
    let instance!: StubController;
    const source = "AA Old. ZZ";
    const target = normalizedAcceptTarget({
      kind: "selection",
      unitId: undefined,
      range: Object.freeze({ start: 3, end: 7 }),
    });
    renderApp((present) => {
      instance = new StubController(present);
      instance.acceptReplacementText = "New text.";
      return instance;
    });
    const editor = container.querySelector("#writing-editor") as HTMLTextAreaElement;
    act(() => enterText(editor, source));
    act(() => {
      editor.setSelectionRange(3, 7);
      editor.dispatchEvent(new Event("select", { bubbles: true }));
      instance.present({
        active: item("Old.", {
          normalizedTracks: Object.freeze([
            normalized("normalized-one", "New text.", {
              canAccept: true,
              acceptTarget: target,
            }),
          ]),
        }),
        recent: [],
      });
    });

    await act(async () => {
      button("Accept")?.click();
      await Promise.resolve();
    });

    expect(editor.value).toBe("AA New text. ZZ");
    expect(editor.selectionStart).toBe(3 + "New text.".length);
    expect(editor.selectionEnd).toBe(editor.selectionStart);
  });

  it("renders the compact stale-edit failure status", () => {
    renderWithPresentation({
      active: item("Current source", {
        status: "idle",
        statusMessage: "Source changed; suggestion is no longer current.",
        inlineStatusMessage: "Source changed; suggestion is no longer current.",
        normalizedTracks: Object.freeze([
          normalized("stale-normalized", "Old wording"),
        ]),
      }),
      recent: [],
    }, visibleTextAnchor);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Source changed; suggestion is no longer current.",
    );
    const inline = container.querySelector('[aria-label="Inline assistance"]')!;
    expect(inline.textContent).toBe(
      "Source changed; suggestion is no longer current.",
    );
    expect(inline.textContent).not.toContain("Old wording");
    expect(inline.querySelector("button")).toBeNull();
  });

  it("renders only the primary current Normalized variant inline", () => {
    const target = normalizedAcceptTarget();
    renderWithPresentation({
      active: item("Current source.", {
        normalizedTracks: Object.freeze([
          normalized("primary", "Primary wording.", {
            label: "Primary",
            canAccept: true,
            acceptTarget: target,
          }),
          normalized("alternative", "Alternative wording.", {
            label: "Alternative",
            canAccept: true,
            acceptTarget: normalizedAcceptTarget({
              trackId: "alternative" as never,
            }),
          }),
        ]),
      }),
      recent: [],
    }, visibleTextAnchor);

    const inline = container.querySelector('[aria-label="Inline assistance"]')!;
    expect(inline.textContent).toContain("Primary wording.");
    expect(inline.textContent).not.toContain("Alternative wording.");
    expect(inline.querySelector<HTMLButtonElement>(
      '[aria-label="Accept inline Normalized variant Primary"]',
    )?.disabled).toBe(false);
    expect(container.querySelector(".assistance-pane")?.textContent)
      .toContain("Alternative wording.");
    const sideButtons = container.querySelectorAll<HTMLButtonElement>(
      ".assistance-pane .normalized-accept",
    );
    expect(sideButtons[0]?.disabled).toBe(false);
    expect(container.querySelector(".assistance-pane")?.textContent)
      .toContain("Primary wording.");
    expect(desktopStyles).toMatch(
      /\.inline-assistance\s*\{[^}]*position:\s*absolute;[^}]*max-block-size:\s*10rem;/s,
    );
  });

  it("uses the existing Accept identity from the inline action", () => {
    const target = normalizedAcceptTarget();
    const instance = renderWithPresentation({
      active: item("Old.", {
        normalizedTracks: Object.freeze([
          normalized("normalized-one", "New.", {
            canAccept: true,
            acceptTarget: target,
          }),
        ]),
      }),
      recent: [],
    }, visibleTextAnchor);

    act(() => container.querySelector<HTMLButtonElement>(
      '[aria-label^="Accept inline Normalized"]',
    )?.click());

    expect(instance.actions).toContainEqual({
      name: "acceptNormalized",
      args: [target],
    });
  });

  it("shows analyzing without stale inline wording", () => {
    renderWithPresentation({
      active: item("Current source", {
        status: "analyzing",
        statusMessage: "Analyzing…",
        inlineStatusMessage: "Analyzing…",
        normalizedTracks: Object.freeze([
          normalized("stale", "Stale wording"),
        ]),
      }),
      recent: [],
    }, visibleTextAnchor);

    const inline = container.querySelector('[aria-label="Inline assistance"]')!;
    expect(inline.textContent).toBe("Analyzing…");
    expect(inline.textContent).not.toContain("Stale wording");
  });

  it("removes stale inline wording when the active presentation changes", () => {
    const instance = renderWithPresentation({
      active: item("Old source", {
        normalizedTracks: Object.freeze([
          normalized("current", "Current wording"),
        ]),
      }),
      recent: [],
    }, visibleTextAnchor);
    expect(container.querySelector('[aria-label="Inline assistance"]')?.textContent)
      .toContain("Current wording");

    act(() => instance.present({
      active: item("New source", {
        status: "idle",
        statusMessage: "Waiting for a complete thought",
      }),
      recent: [],
    }));
    expect(container.querySelector('[aria-label="Inline assistance"]')).toBeNull();
  });

  it.each([
    ["empty editor", { active: null, recent: [] }],
    ["blank separator", { active: null, recent: [] }],
  ])("hides inline assistance for %s", (_name, presentation) => {
    renderWithPresentation(presentation, visibleTextAnchor);
    expect(container.querySelector('[aria-label="Inline assistance"]')).toBeNull();
  });

  it("hides inline assistance for an explicit selection target", () => {
    renderWithPresentation({
      active: item("Selected source", {
        targetKind: "explicit-selection",
        normalizedTracks: Object.freeze([
          normalized("selection", "Selected wording", {
            canAccept: true,
            acceptTarget: normalizedAcceptTarget({ kind: "selection" }),
          }),
        ]),
      }),
      recent: [],
    }, visibleTextAnchor);

    expect(container.querySelector('[aria-label="Inline assistance"]')).toBeNull();
    expect(container.querySelector(".assistance-pane")?.textContent)
      .toContain("Selected wording");
  });

  it("suppresses inline assistance during composition and restores it after compositionend", () => {
    renderWithPresentation({
      active: item("A😀B", {
        normalizedTracks: Object.freeze([
          normalized("emoji", "A🙂B"),
        ]),
      }),
      recent: [],
    }, visibleTextAnchor);
    const editor = container.querySelector("#writing-editor") as HTMLTextAreaElement;
    act(() => enterText(editor, "A😀B"));
    expect(container.querySelector('[aria-label="Inline assistance"]')).not.toBeNull();

    act(() => editor.dispatchEvent(new CompositionEvent(
      "compositionstart",
      { bubbles: true, data: "文" },
    )));
    expect(container.querySelector('[aria-label="Inline assistance"]')).toBeNull();

    act(() => editor.dispatchEvent(new CompositionEvent(
      "compositionupdate",
      { bubbles: true, data: "文字" },
    )));
    expect(container.querySelector('[aria-label="Inline assistance"]')).toBeNull();

    act(() => editor.dispatchEvent(new CompositionEvent(
      "compositionend",
      { bubbles: true, data: "文" },
    )));
    expect(container.querySelector('[aria-label="Inline assistance"]')).not.toBeNull();
  });

  it("keeps inline failure output compact and provider-detail free", () => {
    renderWithPresentation({
      active: item("Source", {
        status: "failed",
        statusMessage: "Provider request failed",
        inlineStatusMessage: "Assistance unavailable",
      }),
      recent: [],
    }, visibleTextAnchor);

    const inline = container.querySelector('[aria-label="Inline assistance"]')!;
    expect(inline.textContent).toBe("Assistance unavailable");
    expect(inline.textContent).not.toContain("Provider request failed");
  });

  it("keeps configuration-required detail in the side panel and hides inline", () => {
    renderWithPresentation({
      active: item("Source", {
        status: "failed",
        statusMessage: "Configuration required",
      }),
      recent: [],
    }, visibleTextAnchor);

    expect(container.querySelector('[aria-label="Inline assistance"]')).toBeNull();
    expect(container.querySelector(".assistance-pane")?.textContent)
      .toContain("Configuration required");
  });

  it("never creates inline cards for Recent Assistance", () => {
    renderWithPresentation({
      active: null,
      recent: [item("Recent.", {
        normalizedTracks: Object.freeze([
          normalized("recent", "Recent wording", {
            canAccept: true,
            acceptTarget: normalizedAcceptTarget(),
          }),
        ]),
      })],
    }, visibleTextAnchor);

    expect(container.querySelectorAll('[aria-label="Inline assistance"]'))
      .toHaveLength(0);
    expect(container.querySelector(".recent-assistance")?.textContent)
      .toContain("Recent wording");
    expect(container.querySelector(".recent-assistance .normalized-accept"))
      .toBeNull();
    expect(desktopStyles).toMatch(
      /\.recent-assistance \.assistance-card\s*\{[^}]*background:\s*transparent;/s,
    );
    expect(desktopStyles).toMatch(
      /\.primary-button:focus-visible,[\s\S]*outline:\s*3px solid/s,
    );
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

  it("does not overwrite an in-progress Native Intent draft when inline wording updates", () => {
    const targetIntent = nativeIntent("Initial intent");
    const instance = renderWithPresentation({
      active: item("Source.", {
        nativeIntent: targetIntent,
        normalizedTracks: Object.freeze([
          normalized("first", "First current wording."),
        ]),
      }),
      recent: [],
    }, visibleTextAnchor);
    const draft = container.querySelector<HTMLTextAreaElement>(
      '[aria-label="Native Intent draft"]',
    )!;
    act(() => enterText(draft, "My unfinished intent draft"));

    act(() => instance.present({
      active: item("Source.", {
        nativeIntent: targetIntent,
        normalizedTracks: Object.freeze([
          normalized("second", "New authoritative wording."),
        ]),
      }),
      recent: [],
    }));

    expect(draft.value).toBe("My unfinished intent draft");
    expect(container.querySelector('[aria-label="Inline assistance"]')?.textContent)
      .toContain("New authoritative wording.");
    expect(container.querySelector(".assistance-pane")?.textContent)
      .toContain("New authoritative wording.");
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
        normalizedTracks: Object.freeze([
          normalized("recent-normalized", "Recent wording", {
            canAccept: true,
            acceptTarget: normalizedAcceptTarget(),
          }),
        ]),
      })],
    });
    const recent = container.querySelector(".recent-assistance")!;
    expect(recent.textContent).toContain("Recent confirmed");
    expect(recent.textContent).toContain("Recent wording");
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
    const measure = vi.fn(visibleTextAnchor);
    const factory: DesktopControllerFactory = (present) => {
      instance = new StubController(present, (observed) => {
        const sourceText = observed.cursorOffset < 5 ? "First." : "Second.";
        present({
          active: item(sourceText, {
            normalizedTracks: Object.freeze([
              normalized(
                `normalized-${sourceText}`,
                `Normalized ${sourceText}`,
              ),
            ]),
          }),
          recent: [],
        });
      });
      return instance;
    };
    renderApp(factory, measure);
    const editor = container.querySelector("textarea")!;
    act(() => enterText(editor, "First. Second."));
    const exactText = editor.value;

    act(() => {
      editor.setSelectionRange(1, 1);
      editor.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "ArrowLeft" }));
    });
    expect(container.querySelector(".is-active")?.textContent).toContain("First.");
    expect(container.querySelector('[aria-label="Inline assistance"]')?.textContent)
      .toContain("Normalized First.");

    const measurementsBeforeMove = measure.mock.calls.length;
    act(() => {
      editor.setSelectionRange(9, 9);
      editor.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector(".is-active")?.textContent).toContain("Second.");
    expect(container.querySelector('[aria-label="Inline assistance"]')?.textContent)
      .toContain("Normalized Second.");
    expect(measure.mock.calls.length).toBeGreaterThan(measurementsBeforeMove);
    expect(editor.value).toBe(exactText);
    expect(instance.actions).toEqual([]);
  });

  it("remeasures on textarea scroll and hides or restores an offscreen anchor", () => {
    let visible = true;
    const measure = vi.fn(() => ({
      ...visibleTextAnchor(),
      visible,
    }));
    renderWithPresentation({
      active: item("Scrollable source.", {
        normalizedTracks: Object.freeze([
          normalized("scroll", "Near-caret wording"),
        ]),
      }),
      recent: [],
    }, measure);
    const editor = container.querySelector("#writing-editor") as HTMLTextAreaElement;
    expect(container.querySelector('[aria-label="Inline assistance"]')).not.toBeNull();

    visible = false;
    act(() => editor.dispatchEvent(new Event("scroll", { bubbles: true })));
    expect(container.querySelector('[aria-label="Inline assistance"]')).toBeNull();

    visible = true;
    act(() => editor.dispatchEvent(new Event("scroll", { bubbles: true })));
    expect(container.querySelector('[aria-label="Inline assistance"]')).not.toBeNull();
    expect(measure.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("requests remeasurement when the editor or pane resizes", () => {
    const observers: Array<{
      callback: ResizeObserverCallback;
      targets: Element[];
    }> = [];
    class FakeResizeObserver {
      readonly record: { callback: ResizeObserverCallback; targets: Element[] };
      constructor(callback: ResizeObserverCallback) {
        this.record = { callback, targets: [] };
        observers.push(this.record);
      }
      observe(target: Element): void {
        this.record.targets.push(target);
      }
      disconnect(): void {}
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const measure = vi.fn(visibleTextAnchor);
    renderWithPresentation({
      active: item("Resizable source.", {
        normalizedTracks: Object.freeze([
          normalized("resize", "Responsive wording"),
        ]),
      }),
      recent: [],
    }, measure);
    const editor = container.querySelector("#writing-editor")!;
    const pane = container.querySelector(".writing-pane")!;
    const initialMeasurements = measure.mock.calls.length;
    const geometryObserver = observers.find(
      (observer) =>
        observer.targets.includes(editor) && observer.targets.includes(pane),
    );

    act(() => geometryObserver?.callback([], {} as ResizeObserver));

    expect(measure.mock.calls.length).toBeGreaterThan(initialMeasurements);
    const afterObserver = measure.mock.calls.length;
    act(() => globalThis.dispatchEvent(new Event("resize")));
    expect(measure.mock.calls.length).toBeGreaterThan(afterObserver);
  });

  it("repositions for actual card dimensions without remeasuring the caret", () => {
    const observers: Array<{
      callback: ResizeObserverCallback;
      targets: Element[];
    }> = [];
    class FakeResizeObserver {
      readonly record: { callback: ResizeObserverCallback; targets: Element[] };
      constructor(callback: ResizeObserverCallback) {
        this.record = { callback, targets: [] };
        observers.push(this.record);
      }
      observe(target: Element): void {
        this.record.targets.push(target);
      }
      disconnect(): void {}
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const measure = vi.fn(() => ({
      left: 340,
      top: 160,
      lineHeight: 24,
      visible: true,
    }));
    const instance = renderWithPresentation({
      active: item("Source.", {
        normalizedTracks: Object.freeze([
          normalized("short", "Short wording."),
        ]),
      }),
      recent: [],
    }, measure);
    const pane = container.querySelector<HTMLElement>(".writing-pane")!;
    const card = container.querySelector<HTMLElement>(
      '[aria-label="Inline assistance"]',
    )!;
    Object.defineProperties(pane, {
      clientWidth: { configurable: true, value: 400 },
      clientHeight: { configurable: true, value: 250 },
    });
    let cardHeight = 40;
    vi.spyOn(card, "getBoundingClientRect").mockImplementation(() => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 180,
      bottom: cardHeight,
      width: 180,
      height: cardHeight,
      toJSON: () => ({}),
    }));
    const notifyCardResize = (): void => {
      const observer = [...observers].reverse().find((candidate) =>
        candidate.targets.includes(card));
      observer?.callback([], {} as ResizeObserver);
    };

    act(notifyCardResize);
    expect(card.dataset.placement).toBe("below");
    expect(card.style.left).toBe("212px");
    const measurementsBeforeContentChange = measure.mock.calls.length;
    const longText = "A long normalized suggestion ".repeat(30);

    act(() => instance.present({
      active: item("Source.", {
        normalizedTracks: Object.freeze([
          normalized("long", longText),
        ]),
      }),
      recent: [],
    }));
    cardHeight = 100;
    act(notifyCardResize);

    expect(measure).toHaveBeenCalledTimes(measurementsBeforeContentChange);
    expect(card.dataset.placement).toBe("above");
    expect(card.style.top).toBe("54px");
    expect(card.textContent).toContain(longText);
    expect(desktopStyles).toMatch(
      /\.inline-assistance-text\s*\{[^}]*max-block-size:\s*5rem;[^}]*overflow:\s*hidden;/s,
    );
  });

  it("preserves Source and its selection during inline pointerdown", () => {
    const target = normalizedAcceptTarget();
    const instance = renderWithPresentation({
      active: item("Old.", {
        normalizedTracks: Object.freeze([
          normalized("pointer", "New.", {
            canAccept: true,
            acceptTarget: target,
          }),
        ]),
      }),
      recent: [],
    }, visibleTextAnchor);
    const editor = container.querySelector<HTMLTextAreaElement>("#writing-editor")!;
    act(() => enterText(editor, "Old."));
    editor.setSelectionRange(2, 2);
    const accept = container.querySelector<HTMLButtonElement>(
      '[aria-label^="Accept inline Normalized"]',
    )!;

    act(() => accept.dispatchEvent(new Event("pointerdown", { bubbles: true })));

    expect(editor.value).toBe("Old.");
    expect(editor.selectionStart).toBe(2);
    expect(editor.selectionEnd).toBe(2);
    expect(instance.actions).toEqual([]);
    expect(accept.tagName).toBe("BUTTON");
    expect(accept.type).toBe("button");
  });

  it("applies inline Accept through the guarded port, clears the overlay, and restores editor focus", async () => {
    let instance!: StubController;
    const target = normalizedAcceptTarget({
      range: Object.freeze({ start: 3, end: 7 }),
    });
    const factory: DesktopControllerFactory = (present) => {
      instance = new StubController(present, (observed) => {
        if (observed.text === "AA New wording. ZZ") {
          present({ active: null, recent: [] });
        }
      });
      instance.acceptReplacementText = "New wording.";
      return instance;
    };
    renderApp(factory, visibleTextAnchor);
    const editor = container.querySelector("#writing-editor") as HTMLTextAreaElement;
    act(() => enterText(editor, "AA Old. ZZ"));
    act(() => instance.present({
      active: item("Old.", {
        nativeIntent: nativeIntent("旧含义", "confirmed"),
        normalizedTracks: Object.freeze([
          normalized("normalized-one", "New wording.", {
            canAccept: true,
            acceptTarget: target,
          }),
        ]),
      }),
      recent: [],
    }));

    await act(async () => {
      container.querySelector<HTMLButtonElement>(
        '[aria-label^="Accept inline Normalized"]',
      )?.click();
      await Promise.resolve();
    });

    expect(editor.value).toBe("AA New wording. ZZ");
    expect(editor.selectionStart).toBe(3 + "New wording.".length);
    expect(editor.selectionEnd).toBe(editor.selectionStart);
    expect(document.activeElement).toBe(editor);
    expect(container.querySelector('[aria-label="Inline assistance"]')).toBeNull();
    expect(container.querySelector('[aria-label="Native Intent draft"]')).toBeNull();
    expect(container.textContent).not.toContain("Accepted successfully");
  });

  it("cannot apply a stale inline target to newer Source", async () => {
    let instance!: StubController;
    renderApp((present) => {
      instance = new StubController(present);
      instance.acceptReplacementText = "New.";
      return instance;
    }, visibleTextAnchor);
    const editor = container.querySelector("#writing-editor") as HTMLTextAreaElement;
    act(() => enterText(editor, "Old."));
    act(() => instance.present({
      active: item("Old.", {
        normalizedTracks: Object.freeze([
          normalized("old", "New.", {
            canAccept: true,
            acceptTarget: normalizedAcceptTarget(),
          }),
        ]),
      }),
      recent: [],
    }));
    const staleButton = container.querySelector<HTMLButtonElement>(
      '[aria-label^="Accept inline Normalized"]',
    )!;

    act(() => enterText(editor, "Newer user text."));
    await act(async () => {
      staleButton.click();
      await Promise.resolve();
    });

    expect(editor.value).toBe("Newer user text.");
    expect(document.activeElement).toBe(editor);
  });

  it("removes inline output when a dependency refresh invalidates the result", () => {
    const instance = renderWithPresentation({
      active: item("Profile source.", {
        normalizedTracks: Object.freeze([
          normalized("profile-a", "Profile A wording"),
        ]),
      }),
      recent: [],
    }, visibleTextAnchor);
    expect(container.querySelector('[aria-label="Inline assistance"]')?.textContent)
      .toContain("Profile A wording");

    act(() => instance.present({
      active: item("Profile source.", {
        status: "analyzing",
        statusMessage: "Analyzing…",
        inlineStatusMessage: "Analyzing…",
        normalizedTracks: Object.freeze([]),
      }),
      recent: [],
    }));

    const inline = container.querySelector('[aria-label="Inline assistance"]')!;
    expect(inline.textContent).toBe("Analyzing…");
    expect(inline.textContent).not.toContain("Profile A wording");
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

  it("delays Windows capture so the user can refocus an external field", () => {
    vi.useFakeTimers();
    let instance!: StubController;
    const factory: DesktopControllerFactory = (
      present,
      _presentSettings,
      presentGlobal,
    ) => {
      instance = new StubController(present, undefined, presentGlobal);
      return instance;
    };
    renderApp(factory);

    const analyze = button("Analyze focused Windows field")!;
    act(() => analyze.click());

    expect(container.textContent).toContain(
      "Focus the external Windows text field now; capture starts in 3 seconds.",
    );
    expect(analyze.disabled).toBe(true);
    expect(instance.actions).not.toContainEqual({
      name: "analyzeWindowsActiveTextSurface",
      args: [],
    });

    act(() => vi.advanceTimersByTime(3_000));

    expect(instance.actions).toContainEqual({
      name: "analyzeWindowsActiveTextSurface",
      args: [],
    });
    expect(analyze.disabled).toBe(false);
  });

  it("renders Windows external results in a separate read-only development section", () => {
    let instance!: StubController;
    const factory: DesktopControllerFactory = (
      present,
      _presentSettings,
      presentGlobal,
    ) => {
      instance = new StubController(present, undefined, presentGlobal);
      return instance;
    };
    renderApp(factory);
    const externalPresentation: GlobalDesktopAssistantPresentation = {
      ...EMPTY_GLOBAL_DESKTOP_ASSISTANCE,
      hostAvailable: true,
      manualAnalysisAllowed: true,
      sourceText: "External text only.",
      status: "completed",
      statusMessage: "Analysis ready",
      assistance: {
        active: item("External text only.", {
          normalizedTracks: [
            normalized("external", "External normalized wording."),
          ],
        }),
        recent: [],
      },
    };

    act(() => instance.presentGlobal?.(externalPresentation));

    const section = container.querySelector(
      ".windows-external-development",
    )!;
    expect(section.textContent).toContain("Windows external-host development");
    expect(section.textContent).toContain("External text only.");
    expect(section.textContent).toContain("External normalized wording.");
    expect(section.textContent).toContain("Read-only");
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

function normalizedAcceptTarget(
  overrides: Partial<DesktopNormalizedAcceptTarget> = {},
): DesktopNormalizedAcceptTarget {
  return Object.freeze({
    kind: "unit" as const,
    segmentId: "segment-one" as never,
    unitId: "unit-one",
    sourceRevision: 1,
    sourceFingerprint: "unit-one:source" as never,
    trackId: "normalized-one" as never,
    trackRevision: 1,
    dependencyStamp: Object.freeze({
      sourceRevision: 1,
      assistPolicyFingerprint: "assist",
      styleProfileFingerprint: "style",
      languageConfigurationFingerprint: "languages",
      processorConfigurationFingerprint: "processor",
      contextFingerprint: "context",
    }),
    range: Object.freeze({ start: 0, end: 4 }),
    expectedText: "Old.",
    ...overrides,
  });
}

function visibleTextAnchor(): TextareaTextAnchor {
  return Object.freeze({
    left: 160,
    top: 180,
    lineHeight: 24,
    visible: true,
  });
}

function button(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
}
