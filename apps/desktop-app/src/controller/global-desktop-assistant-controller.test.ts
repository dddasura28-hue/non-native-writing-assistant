import {
  createHostCapabilities,
  createTextContext,
  type AnalysisConfiguration,
  type AnalysisProposal,
  type AnalysisProvider,
  type AnalysisSnapshot,
  type HostCapabilities,
  type TextContext,
} from "@non-native-writing/application";
import {
  NATIVE_INTENT_TRACK_TYPE_ID,
  NORMALIZED_TRACK_TYPE_ID,
  asGenerationGroupId,
  asTrackId,
} from "@non-native-writing/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DESKTOP_ANALYSIS_CONFIGURATION,
  type DesktopNormalizedAcceptTarget,
} from "./desktop-engine-controller.js";
import {
  GlobalDesktopAssistantController,
  type GlobalDesktopAssistantPresentation,
} from "./global-desktop-assistant-controller.js";
import { FakeActiveTextSurface } from "../host/fake-active-text-surface.js";
import type { DesktopAnalysisConfigurationSource } from "../provider/desktop-analysis-configuration-source.js";

const FULL_CAPABILITIES = createHostCapabilities({
  canReplaceText: true,
  canObserveComposition: true,
  canObserveSelection: true,
  canProvideSurroundingText: true,
});

interface PendingRequest {
  readonly snapshot: AnalysisSnapshot;
  readonly signal: AbortSignal;
  readonly resolve: (proposal: AnalysisProposal) => void;
}

class ControlledProvider implements AnalysisProvider {
  readonly requests: PendingRequest[] = [];

  analyze(snapshot: AnalysisSnapshot, signal: AbortSignal): Promise<AnalysisProposal> {
    return new Promise((resolve) => {
      this.requests.push({ snapshot, signal, resolve });
    });
  }

  complete(index: number, normalized = "Normalized result."): void {
    const request = this.requests[index]!;
    const group = asGenerationGroupId(`global-generation-${index}`);
    request.resolve(Object.freeze({
      outputs: Object.freeze([
        Object.freeze({
          id: asTrackId(`global-native-${index}`),
          typeId: NATIVE_INTENT_TRACK_TYPE_ID,
          text: `Intent: ${request.snapshot.sourceText}`,
          provenance: "model" as const,
          dependencyStamp: request.snapshot.dependencyStamp,
          generationGroupId: group,
          order: 1,
        }),
        Object.freeze({
          id: asTrackId(`global-normalized-${index}`),
          typeId: NORMALIZED_TRACK_TYPE_ID,
          text: normalized,
          provenance: "model" as const,
          dependencyStamp: request.snapshot.dependencyStamp,
          generationGroupId: group,
          order: 1,
        }),
      ]),
    }));
  }
}

class MutableConfigurationSource implements DesktopAnalysisConfigurationSource {
  #configuration: AnalysisConfiguration = DESKTOP_ANALYSIS_CONFIGURATION;
  readonly #listeners = new Set<() => void>();

  getConfiguration(): AnalysisConfiguration {
    return this.#configuration;
  }

  onDidChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  switchProfile(): void {
    this.#configuration = Object.freeze({
      ...this.#configuration,
      processorConfigurationFingerprint:
        `${this.#configuration.processorConfigurationFingerprint}|next`,
    });
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

function textContext(
  text: string,
  options: {
    readonly cursorOffset?: number;
    readonly selection?: { readonly start: number; readonly end: number } | null;
    readonly composition?: {
      readonly start: number;
      readonly end: number;
      readonly text: string;
    } | null;
  } = {},
): TextContext {
  return createTextContext({
    text,
    cursorOffset: options.cursorOffset ?? text.length,
    selection: options.selection ?? null,
    composition: options.composition ?? null,
  });
}

function createHarness(
  context: TextContext,
  capabilities: HostCapabilities = FULL_CAPABILITIES,
  configurationSource?: DesktopAnalysisConfigurationSource,
) {
  const surface = new FakeActiveTextSurface(context, capabilities);
  const provider = new ControlledProvider();
  const presentations: GlobalDesktopAssistantPresentation[] = [];
  const controller = new GlobalDesktopAssistantController(
    surface,
    provider,
    (presentation) => presentations.push(presentation),
    configurationSource === undefined ? {} : { configurationSource },
  );
  return {
    surface,
    provider,
    presentations,
    controller,
    latest: () => presentations.at(-1)!,
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}

async function analyzeAndComplete(
  harness: ReturnType<typeof createHarness>,
  normalized = "Normalized result.",
): Promise<void> {
  const requestIndex = harness.provider.requests.length;
  const pending = harness.controller.analyzeActiveTextSurface();
  await flush();
  expect(harness.provider.requests).toHaveLength(requestIndex + 1);
  harness.provider.complete(requestIndex, normalized);
  await expect(pending).resolves.toBe("applied");
  await flush();
}

function currentTarget(
  harness: ReturnType<typeof createHarness>,
): DesktopNormalizedAcceptTarget {
  return harness.latest().assistance.active!.normalizedTracks[0]!.acceptTarget!;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GlobalDesktopAssistantController", () => {
  it("captures a full-capability host and presents existing-engine output", async () => {
    const harness = createHarness(textContext("this have problem"));

    await analyzeAndComplete(harness, "this has a problem");

    expect(harness.surface.captureCount).toBe(1);
    expect(harness.provider.requests[0]!.snapshot.sourceText).toBe("this have problem");
    expect(harness.latest()).toMatchObject({
      hostAvailable: true,
      readOnly: false,
      automaticRealtimeAllowed: true,
      manualAnalysisAllowed: true,
      guardedAcceptAllowed: true,
      sourceText: "this have problem",
      status: "completed",
    });
    expect(harness.latest().assistance.active?.nativeIntent?.text)
      .toBe("Intent: this have problem");
    expect(harness.latest().assistance.active?.normalizedTracks[0]?.text)
      .toBe("this has a problem");
  });

  it("returns a neutral state when the active host is unavailable", async () => {
    const harness = createHarness(textContext("Unavailable."));
    harness.surface.setAvailable(false);

    await expect(harness.controller.analyzeActiveTextSurface())
      .resolves.toBe("unavailable");

    expect(harness.latest()).toMatchObject({
      hostAvailable: false,
      status: "no-host",
      sourceText: null,
    });
    expect(harness.provider.requests).toHaveLength(0);
  });

  it("does not analyze an empty captured text window", async () => {
    const harness = createHarness(textContext(""));

    await expect(harness.controller.analyzeActiveTextSurface())
      .resolves.toBe("empty");

    expect(harness.latest()).toMatchObject({
      hostAvailable: true,
      status: "empty",
      sourceText: "",
    });
    expect(harness.provider.requests).toHaveLength(0);
  });

  it("captures but does not call the provider when configuration is required", async () => {
    const harness = createHarness(textContext("Captured without a profile."));

    await expect(harness.controller.analyzeActiveTextSurface({
      configurationRequired: true,
    })).resolves.toBe("configuration-required");

    expect(harness.surface.captureCount).toBe(1);
    expect(harness.provider.requests).toHaveLength(0);
    expect(harness.latest()).toMatchObject({
      hostAvailable: true,
      sourceText: "Captured without a profile.",
      status: "configuration-required",
      guardedAcceptAllowed: false,
    });
  });

  it("performs a fresh capture for every manual invocation", async () => {
    const harness = createHarness(textContext("First."));
    await analyzeAndComplete(harness, "First normalized.");
    harness.surface.setContext(textContext("Second."));
    await analyzeAndComplete(harness, "Second normalized.");

    expect(harness.surface.captureCount).toBe(2);
    expect(harness.provider.requests.map((request) => request.snapshot.sourceText))
      .toEqual(["First.", "Second."]);
  });

  it("keeps a whole explicit multi-sentence selection as the target", async () => {
    const selected = "This have issue. It cost too much.";
    const source = `Before ${selected} After`;
    const start = "Before ".length;
    const harness = createHarness(textContext(source, {
      cursorOffset: start + selected.length,
      selection: { start, end: start + selected.length },
    }));

    await analyzeAndComplete(
      harness,
      "This has an issue. It costs too much.",
    );

    expect(harness.provider.requests[0]!.snapshot.sourceText).toBe(selected);
    expect(harness.latest().assistance.active?.targetKind)
      .toBe("explicit-selection");
    expect(currentTarget(harness).range).toEqual({
      start,
      end: start + selected.length,
    });
  });

  it("does not invent context for a selected-text-only capture", async () => {
    const selected = "只有 selected text 😀";
    const capabilities = createHostCapabilities({
      ...FULL_CAPABILITIES,
      canProvideSurroundingText: false,
    });
    const harness = createHarness(textContext(selected, {
      selection: { start: 0, end: selected.length },
    }), capabilities);

    await analyzeAndComplete(harness);

    expect(harness.provider.requests[0]!.snapshot).toMatchObject({
      sourceText: selected,
      beforeContext: "",
      afterContext: "",
    });
    expect(harness.latest().sourceText).toBe(selected);
  });

  it("analyzes read-only captures but never prepares Accept", async () => {
    const capabilities = createHostCapabilities({
      ...FULL_CAPABILITIES,
      canReplaceText: false,
    });
    const harness = createHarness(textContext("Read only."), capabilities);

    await analyzeAndComplete(harness, "Readable result.");

    expect(harness.latest()).toMatchObject({
      readOnly: true,
      guardedAcceptAllowed: false,
      status: "completed",
    });
    const normalized = harness.latest().assistance.active!.normalizedTracks[0]!;
    expect(normalized.text).toBe("Readable result.");
    expect(normalized.canAccept).toBe(false);
    expect(normalized.acceptTarget).toBeNull();
    expect(harness.surface.replacementCount).toBe(0);
  });

  it("keeps manual analysis available but realtime ineligible without composition observation", async () => {
    const capabilities = createHostCapabilities({
      ...FULL_CAPABILITIES,
      canObserveComposition: false,
    });
    const configuration = new MutableConfigurationSource();
    const harness = createHarness(
      textContext("Manual capture."),
      capabilities,
      configuration,
    );

    await analyzeAndComplete(harness);
    expect(harness.latest()).toMatchObject({
      automaticRealtimeAllowed: false,
      manualAnalysisAllowed: true,
    });

    configuration.switchProfile();
    await flush();
    expect(harness.provider.requests).toHaveLength(1);
    expect(harness.latest().guardedAcceptAllowed).toBe(false);
  });

  it("blocks manual and automatic analysis during observed composition", async () => {
    const harness = createHarness(textContext("A文B", {
      cursorOffset: 2,
      composition: { start: 1, end: 2, text: "文" },
    }));

    await expect(harness.controller.analyzeActiveTextSurface())
      .resolves.toBe("composition-active");

    expect(harness.latest()).toMatchObject({
      status: "composition-active",
      automaticRealtimeAllowed: false,
      manualAnalysisAllowed: false,
      guardedAcceptAllowed: false,
    });
    expect(harness.provider.requests).toHaveLength(0);
  });

  it("applies a valid external replacement through the captured one-shot port", async () => {
    const harness = createHarness(textContext("this have problem"));
    await analyzeAndComplete(harness, "this has a problem");
    const target = currentTarget(harness);

    await expect(harness.controller.acceptNormalized(target))
      .resolves.toBe("accepted");

    expect(harness.surface.context.text).toBe("this has a problem");
    expect(harness.surface.replacementCount).toBe(1);
    expect(harness.surface.lastReplacement).toMatchObject({
      expectedText: "this have problem",
      replacementText: "this has a problem",
      range: { start: 0, end: "this have problem".length },
    });
    expect(harness.latest()).toMatchObject({
      status: "updated",
      guardedAcceptAllowed: false,
      assistance: { active: null, recent: [] },
    });
  });

  it("changes only the exact selected range", async () => {
    const source = "AA old text ZZ";
    const harness = createHarness(textContext(source, {
      cursorOffset: 11,
      selection: { start: 3, end: 11 },
    }));
    await analyzeAndComplete(harness, "new");

    await harness.controller.acceptNormalized(currentTarget(harness));

    expect(harness.surface.context.text).toBe("AA new ZZ");
    expect(harness.surface.context.cursorOffset).toBe(6);
    expect(harness.surface.context.selection).toBeNull();
  });

  it("rejects old Accept after external Source changes", async () => {
    const harness = createHarness(textContext("this have problem"));
    await analyzeAndComplete(harness, "this has a problem");
    const target = currentTarget(harness);
    harness.surface.setContext(textContext("this have serious problem"));

    await expect(harness.controller.acceptNormalized(target))
      .resolves.toBe("obsolete");

    expect(harness.surface.context.text).toBe("this have serious problem");
    expect(harness.surface.replacementCount).toBe(0);
    expect(harness.latest().statusMessage).toContain("no longer current");
  });

  it("rejects the old port when the host session changes with identical text", async () => {
    const harness = createHarness(textContext("hello"));
    await analyzeAndComplete(harness, "Hello.");
    const target = currentTarget(harness);
    harness.surface.invalidateSession();

    await expect(harness.controller.acceptNormalized(target))
      .resolves.toBe("obsolete");

    expect(harness.surface.context.text).toBe("hello");
    expect(harness.surface.replacementCount).toBe(0);
  });

  it("cannot reuse a consumed external edit or Accept target", async () => {
    const harness = createHarness(textContext("Once."));
    await analyzeAndComplete(harness, "Only once.");
    const target = currentTarget(harness);

    await expect(harness.controller.acceptNormalized(target))
      .resolves.toBe("accepted");
    await expect(harness.controller.acceptNormalized(target))
      .resolves.toBe("obsolete");

    expect(harness.surface.context.text).toBe("Only once.");
    expect(harness.surface.replacementCount).toBe(1);
  });

  it("leaves external text unchanged when the host rejects replacement", async () => {
    const harness = createHarness(textContext("Keep this."));
    await analyzeAndComplete(harness, "Replace this.");
    harness.surface.failNextReplacement();

    await expect(harness.controller.acceptNormalized(currentTarget(harness)))
      .resolves.toBe("obsolete");

    expect(harness.surface.context.text).toBe("Keep this.");
    expect(harness.surface.replacementCount).toBe(0);
    expect(harness.latest().guardedAcceptAllowed).toBe(false);
  });

  it("invalidates old actions after a capability change", async () => {
    const harness = createHarness(textContext("Capabilities."));
    await analyzeAndComplete(harness, "Writable.");
    const oldTarget = currentTarget(harness);
    harness.surface.setCapabilities(createHostCapabilities({
      ...FULL_CAPABILITIES,
      canReplaceText: false,
    }));
    await analyzeAndComplete(harness, "Read only now.");

    await expect(harness.controller.acceptNormalized(oldTarget))
      .resolves.toBe("obsolete");
    expect(harness.latest().readOnly).toBe(true);
    expect(harness.latest().assistance.active?.normalizedTracks[0]?.canAccept)
      .toBe(false);
  });

  it("invalidates old Accept on provider-profile dependency change without auto-analysis", async () => {
    const configuration = new MutableConfigurationSource();
    const harness = createHarness(
      textContext("Profile source."),
      FULL_CAPABILITIES,
      configuration,
    );
    await analyzeAndComplete(harness, "Profile result.");
    const target = currentTarget(harness);

    configuration.switchProfile();
    await flush();

    expect(harness.provider.requests).toHaveLength(1);
    expect(harness.latest().assistance.active?.normalizedTracks).toEqual([]);
    await expect(harness.controller.acceptNormalized(target))
      .resolves.toBe("obsolete");
  });

  it.each([
    ["multiline", "First line.\n第二行。", "First line.\n第二行更自然。"],
    ["Chinese", "这个方法有问题。", "这个方法存在问题。"],
    ["emoji UTF-16", "A😀B", "A🙂更好B"],
    ["mixed CJK/Latin", "这个 API have issue.", "这个 API has an issue."],
  ])("preserves exact %s capture and replacement text", async (
    _name,
    source,
    replacement,
  ) => {
    const harness = createHarness(textContext(source, {
      selection: { start: 0, end: source.length },
    }));
    await analyzeAndComplete(harness, replacement);
    const target = currentTarget(harness);

    expect(harness.provider.requests[0]!.snapshot.sourceText).toBe(source);
    expect(target.range).toEqual({ start: 0, end: source.length });
    await harness.controller.acceptNormalized(target);
    expect(harness.surface.context.text).toBe(replacement);
  });

  it("removes an old presentation as soon as a new target invocation starts", async () => {
    const harness = createHarness(textContext("Old target."));
    await analyzeAndComplete(harness, "Old result.");
    const oldTarget = currentTarget(harness);
    harness.surface.setContext(textContext("New target."));

    const pending = harness.controller.analyzeActiveTextSurface();
    expect(harness.latest().status).toBe("capturing");
    await expect(harness.controller.acceptNormalized(oldTarget))
      .resolves.toBe("obsolete");
    await flush();
    expect(harness.latest().sourceText).toBe("New target.");
    harness.provider.complete(1, "New result.");
    await expect(pending).resolves.toBe("applied");
  });

  it("prevents a late old-host result from repainting a newer host", async () => {
    const harness = createHarness(textContext("Host A."));
    const first = harness.controller.analyzeActiveTextSurface();
    await flush();
    harness.surface.setContext(textContext("Host B."));
    const second = harness.controller.analyzeActiveTextSurface();
    await flush();

    harness.provider.complete(0, "Late A.");
    await expect(first).resolves.toBe("obsolete");
    await flush();
    expect(harness.latest().sourceText).toBe("Host B.");
    expect(harness.latest().assistance.active?.normalizedTracks)
      .not.toContainEqual(expect.objectContaining({ text: "Late A." }));

    harness.provider.complete(1, "Current B.");
    await expect(second).resolves.toBe("applied");
    expect(harness.latest().assistance.active?.normalizedTracks[0]?.text)
      .toBe("Current B.");
  });

  it("blocks late presentation after controller cleanup", async () => {
    const harness = createHarness(textContext("Dispose me."));
    const pending = harness.controller.analyzeActiveTextSurface();
    await flush();
    const countBeforeDispose = harness.presentations.length;
    harness.controller.dispose();
    harness.provider.complete(0, "Too late.");

    await expect(pending).resolves.toBe("obsolete");
    await flush();
    expect(harness.presentations).toHaveLength(countBeforeDispose);
  });

  it("uses no browser or native API in deterministic external-host tests", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const harness = createHarness(textContext("Local fake."));

    await analyzeAndComplete(harness);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
