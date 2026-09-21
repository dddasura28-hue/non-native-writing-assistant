import {
  assertTextReplacementMatches,
  createTextContext,
  type AnalysisConfiguration,
  type AnalysisProposal,
  type AnalysisProvider,
  type AnalysisSnapshot,
  type TextContext,
  type TextEditPort,
  type TextReplacement,
} from "@non-native-writing/application";
import {
  NATIVE_INTENT_TRACK_TYPE_ID,
  NORMALIZED_TRACK_TYPE_ID,
  asGenerationGroupId,
  asTrackId,
} from "@non-native-writing/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WritingModelError } from "@non-native-writing/model-integration";

import {
  DesktopEngineController,
  EMPTY_DESKTOP_ASSISTANCE,
  type DesktopAssistancePresentation,
} from "./desktop-engine-controller.js";
import type { DesktopAnalysisConfigurationSource } from "../provider/desktop-analysis-configuration-source.js";

class MutableConfigurationSource implements DesktopAnalysisConfigurationSource {
  #configuration: AnalysisConfiguration;
  readonly #listeners = new Set<() => void>();

  constructor(configuration = {
    assistPolicyFingerprint: "assist",
    styleProfileFingerprint: "style",
    languageConfigurationFingerprint: "languages",
    processorConfigurationFingerprint: "provider:a",
    targetLanguageId: "en",
    nativeLanguageId: "zh-CN",
  }) {
    this.#configuration = configuration;
  }

  getConfiguration(): AnalysisConfiguration {
    return this.#configuration;
  }

  onDidChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  switchProvider(fingerprint: string): void {
    this.#configuration = { ...this.#configuration, processorConfigurationFingerprint: fingerprint };
    for (const listener of this.#listeners) listener();
  }
}

interface PendingRequest {
  readonly snapshot: AnalysisSnapshot;
  readonly signal: AbortSignal;
  readonly resolve: (proposal: AnalysisProposal) => void;
  readonly reject: (error: unknown) => void;
}

class ControlledProvider implements AnalysisProvider {
  readonly requests: PendingRequest[] = [];
  readonly #ignoreAbort: boolean;

  constructor(ignoreAbort = false) {
    this.#ignoreAbort = ignoreAbort;
  }

  analyze(snapshot: AnalysisSnapshot, signal: AbortSignal): Promise<AnalysisProposal> {
    return new Promise((resolve, reject) => {
      const request = { snapshot, signal, resolve, reject };
      this.requests.push(request);
      if (!this.#ignoreAbort) {
        signal.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
      }
    });
  }

  complete(
    index: number,
    normalizedTexts: readonly string[] = [
      `normalized:${this.requests[index]!.snapshot.sourceText}`,
    ],
  ): void {
    const request = this.requests[index]!;
    const suffix = `${index}-${request.snapshot.sourceRevision}`;
    const generationGroupId = asGenerationGroupId(`test-generation-${suffix}`);
    request.resolve(
      Object.freeze({
        outputs: Object.freeze([
          Object.freeze({
            id: asTrackId(`test-native-${suffix}`),
            typeId: NATIVE_INTENT_TRACK_TYPE_ID,
            text: `native:${request.snapshot.sourceText}`,
            provenance: "model" as const,
            dependencyStamp: request.snapshot.dependencyStamp,
            generationGroupId,
            order: 1,
          }),
          ...normalizedTexts.map((text, variantIndex) => Object.freeze({
            id: asTrackId(`test-normalized-${suffix}-${variantIndex}`),
            typeId: NORMALIZED_TRACK_TYPE_ID,
            text,
            label: `Variant ${variantIndex + 1}`,
            provenance: "model" as const,
            dependencyStamp: request.snapshot.dependencyStamp,
            generationGroupId,
            order: variantIndex + 1,
          })),
        ]),
      }),
    );
  }

  fail(index: number): void {
    this.requests[index]!.reject(new Error("controlled failure"));
  }
}

class ControllerTextHost {
  current: TextContext;
  generation = 0;
  replaceCount = 0;
  lastReplacement: TextReplacement | null = null;

  constructor(
    private readonly controller: DesktopEngineController,
    initial: TextContext,
  ) {
    this.current = initial;
    this.publish();
  }

  edit(next: TextContext): void {
    this.generation += 1;
    this.current = next;
    this.publish();
  }

  invalidateSession(): void {
    this.generation += 1;
  }

  private publish(suppressAutomaticAnalysis = false): void {
    this.controller.observe(this.current, this.capturePort(this.current), {
      suppressAutomaticAnalysis,
    });
  }

  private capturePort(captured: TextContext): TextEditPort {
    const capturedGeneration = this.generation;
    let consumed = false;
    return {
      replace: (replacement) => {
        if (consumed || capturedGeneration !== this.generation) {
          throw new Error("Captured editor session is no longer current.");
        }
        if (this.current.text !== captured.text) {
          throw new Error("Captured editor session is no longer current.");
        }
        assertTextReplacementMatches(this.current.text, replacement);
        consumed = true;
        this.replaceCount += 1;
        this.lastReplacement = replacement;
        const text =
          this.current.text.slice(0, replacement.range.start) +
          replacement.replacementText +
          this.current.text.slice(replacement.range.end);
        const cursorOffset =
          replacement.range.start + replacement.replacementText.length;
        this.generation += 1;
        this.current = context(text, cursorOffset);
        this.publish(true);
      },
    };
  }
}

function context(
  text: string,
  cursorOffset = text.length,
  options: {
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
    cursorOffset,
    selection: options.selection ?? null,
    composition: options.composition ?? null,
  });
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("DesktopEngineController", () => {
  let provider: ControlledProvider;
  let presentations: DesktopAssistancePresentation[];
  let controller: DesktopEngineController;

  beforeEach(() => {
    vi.useFakeTimers();
    provider = new ControlledProvider();
    presentations = [];
    controller = new DesktopEngineController(
      provider,
      (presentation) => presentations.push(presentation),
    );
  });

  afterEach(() => {
    controller.dispose();
    vi.useRealTimers();
  });

  const latest = (): DesktopAssistancePresentation => presentations.at(-1)!;

  it("keeps empty input neutral without calling the provider", async () => {
    controller.observe(context(""));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(provider.requests).toHaveLength(0);
    expect(latest()).toEqual(EMPTY_DESKTOP_ASSISTANCE);
  });

  it("debounces unfinished text for 700 ms", async () => {
    controller.observe(context("unfinished"));
    await vi.advanceTimersByTimeAsync(699);
    expect(provider.requests).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]!.snapshot.sourceText).toBe("unfinished");
  });

  it.each([".", "!", "?", "。", "！", "？"])(
    "triggers terminal %s immediately",
    (terminal) => {
      controller.observe(context(`Complete${terminal}`));
      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0]!.snapshot.sourceText).toBe(`Complete${terminal}`);
    },
  );

  it("does not treat commas or semicolons as immediate completion", async () => {
    controller.observe(context("Clause,"));
    expect(provider.requests).toHaveLength(0);
    controller.observe(context("Clause;"));
    expect(provider.requests).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(700);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]!.snapshot.sourceText).toBe("Clause;");
  });

  it("coalesces rapid keystrokes into one request for exact final text", async () => {
    controller.observe(context("a"));
    await vi.advanceTimersByTimeAsync(300);
    controller.observe(context("ab"));
    await vi.advanceTimersByTimeAsync(300);
    controller.observe(context("ab文"));
    await vi.advanceTimersByTimeAsync(700);

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]!.snapshot.sourceText).toBe("ab文");
  });

  it("analyzes only the active writing unit and preserves its exact source", () => {
    controller.observe(context("First.  第二句？ Third", 11));

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]!.snapshot.sourceText).toBe("第二句？");
  });

  it("provides causal same-block context and excludes later same-block text", () => {
    controller.observe(context("Earlier. Active. Later.", 12));

    expect(provider.requests[0]!.snapshot.sourceText).toBe("Active.");
    expect(provider.requests[0]!.snapshot.beforeContext).toBe("Earlier. ");
    expect(provider.requests[0]!.snapshot.afterContext).toBe("");
  });

  it("reuses cached analysis when navigating between completed units", async () => {
    const text = "One. Two.";
    controller.observe(context(text, 1));
    provider.complete(0);
    await flush();

    controller.observe(context(text, 6));
    await vi.advanceTimersByTimeAsync(700);
    provider.complete(1);
    await flush();

    controller.observe(context(text, 1));
    await vi.advanceTimersByTimeAsync(699);
    expect(provider.requests).toHaveLength(2);
    expect(latest().active?.sourceText).toBe("One.");
    expect(latest().active?.nativeIntentTracks[0]?.text).toBe("native:One.");
  });

  it("shows completed sibling units as bounded recent assistance", async () => {
    const text = "One. Two.";
    controller.observe(context(text, 1));
    provider.complete(0);
    await flush();
    controller.observe(context(text, 6));

    expect(latest().active?.sourceText).toBe("Two.");
    expect(latest().recent.map((item) => item.sourceText)).toEqual(["One."]);
  });

  it("keeps the current source active when a background unit completes", async () => {
    const text = "One. Two";
    controller.observe(context(text, 1));
    controller.observe(context(text, 6));

    provider.complete(0);
    await flush();

    expect(latest().active?.sourceText).toBe("Two");
    expect(latest().active?.nativeIntentTracks).toHaveLength(0);
    expect(latest().recent[0]?.sourceText).toBe("One.");
  });

  it("treats an explicit selection as the whole target and hides recent units", async () => {
    const text = "First. Select one. Select two. Last.";
    controller.observe(context(text, 1));
    provider.complete(0);
    await flush();

    controller.observe(
      context(text, 12, { selection: { start: 7, end: 30 } }),
    );
    await vi.advanceTimersByTimeAsync(1_000);

    expect(provider.requests).toHaveLength(1);
    expect(latest().active?.sourceText).toBe("Select one. Select two.");
    expect(latest().recent).toHaveLength(0);
  });

  it("analyzes an explicit selection through the whole-target path on demand", async () => {
    const text = "Before selected words after";
    const selected = context(text, 10, {
      selection: { start: 7, end: 21 },
    });
    const outcomePromise = controller.analyze(selected);

    expect(provider.requests[0]!.snapshot.sourceText).toBe("selected words");
    provider.complete(0);
    await expect(outcomePromise).resolves.toMatchObject({ status: "applied" });
    expect(latest().active?.normalizedTracks[0]?.text).toBe(
      "normalized:selected words",
    );
    expect(latest().recent).toHaveLength(0);
  });

  it("resumes cursor-local automatic analysis when a selection collapses", async () => {
    const text = "Selected. Cursor text";
    controller.observe(
      context(text, 4, { selection: { start: 0, end: 9 } }),
    );
    controller.observe(context(text, text.length));
    await vi.advanceTimersByTimeAsync(700);

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]!.snapshot.sourceText).toBe("Cursor text");
  });

  it("clears assistance in whitespace-only regions", async () => {
    controller.observe(context("Ready."));
    provider.complete(0);
    await flush();
    controller.observe(context("Ready.\n\n   \n\nLater", 10));

    expect(latest()).toEqual(EMPTY_DESKTOP_ASSISTANCE);
  });

  it("rejects late results after a source edit", async () => {
    controller.dispose();
    provider = new ControlledProvider(true);
    presentations = [];
    controller = new DesktopEngineController(
      provider,
      (presentation) => presentations.push(presentation),
    );
    controller.observe(context("Old draft"));
    await vi.advanceTimersByTimeAsync(700);
    controller.observe(context("New draft"));
    provider.complete(0);
    await flush();

    expect(latest().active?.sourceText).toBe("New draft");
    expect(latest().active?.nativeIntentTracks).toHaveLength(0);
  });

  it("invalidates a completed unit result when its source changes", async () => {
    controller.observe(context("Original."));
    provider.complete(0);
    await flush();
    expect(latest().active?.nativeIntentTracks[0]?.text).toBe("native:Original.");

    controller.observe(context("Original changed"));
    expect(latest().active?.sourceText).toBe("Original changed");
    expect(latest().active?.nativeIntentTracks).toHaveLength(0);
    expect(latest().active?.status).toBe("idle");
  });

  it("serializes rapid requests through the shared single-flight queue", async () => {
    const text = "One. Two.";
    controller.observe(context(text, 1));
    controller.observe(context(text, 6));
    await vi.advanceTimersByTimeAsync(700);

    expect(provider.requests).toHaveLength(1);
    provider.complete(0);
    await flush();
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]!.snapshot.sourceText).toBe("Two.");
  });

  it("contains a failed active request and preserves completed siblings", async () => {
    const text = "One. Two.";
    controller.observe(context(text, 1));
    provider.complete(0);
    await flush();
    controller.observe(context(text, 6));
    await vi.advanceTimersByTimeAsync(700);
    provider.fail(1);
    await flush();

    expect(latest().active?.status).toBe("failed");
    expect(latest().active?.statusMessage).toContain("failed");
    expect(latest().recent[0]?.nativeIntentTracks[0]?.text).toBe("native:One.");
  });

  it("cancels timers and ignores late callbacks after disposal", async () => {
    controller.observe(context("unfinished"));
    controller.dispose();
    const countAtDisposal = presentations.length;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(provider.requests).toHaveLength(0);
    expect(presentations).toHaveLength(countAtDisposal);
  });

  it("does not duplicate an immediate completion request for the same source", () => {
    controller.observe(context("Done."));
    controller.observe(context("Done."));
    expect(provider.requests).toHaveLength(1);
  });

  it("blocks automatic requests for a nonzero composing range", async () => {
    controller.observe(
      context("正在输入", 4, {
        composition: { start: 0, end: 4, text: "正在输入" },
      }),
    );
    await vi.advanceTimersByTimeAsync(1_000);

    expect(provider.requests).toHaveLength(0);
    expect(latest()).toEqual(EMPTY_DESKTOP_ASSISTANCE);
  });

  it("blocks automatic requests for a zero-width composition marker", async () => {
    controller.observe(
      context("Draft", 5, {
        composition: { start: 5, end: 5, text: "" },
      }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(provider.requests).toHaveLength(0);
  });

  it("cancels a pending debounce when composition starts", async () => {
    controller.observe(context("Draft"));
    await vi.advanceTimersByTimeAsync(400);
    controller.observe(
      context("Draft文", 6, {
        composition: { start: 5, end: 6, text: "文" },
      }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(provider.requests).toHaveLength(0);
  });

  it("suppresses a late active result throughout composition", async () => {
    controller.dispose();
    provider = new ControlledProvider(true);
    presentations = [];
    controller = new DesktopEngineController(
      provider,
      (presentation) => presentations.push(presentation),
    );
    controller.observe(context("Ready."));
    controller.observe(
      context("Ready.文", 7, {
        composition: { start: 6, end: 7, text: "文" },
      }),
    );
    provider.complete(0);
    await flush();

    expect(latest()).toEqual(EMPTY_DESKTOP_ASSISTANCE);
  });

  it("resumes immediate punctuation analysis after composition commits", () => {
    controller.observe(
      context("完成。", 3, {
        composition: { start: 0, end: 3, text: "完成。" },
      }),
    );
    expect(provider.requests).toHaveLength(0);

    controller.observe(context("完成。"));
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]!.snapshot.sourceText).toBe("完成。");
  });

  it("invalidates old presentation and reanalyzes the active unit after a profile switch", async () => {
    controller.dispose();
    provider = new ControlledProvider(true);
    presentations = [];
    const configuration = new MutableConfigurationSource();
    controller = new DesktopEngineController(
      provider,
      (presentation) => presentations.push(presentation),
      { configurationSource: configuration },
    );
    controller.observe(context("Ready."));
    provider.complete(0);
    await flush();
    expect(latest().active?.normalizedTracks).toHaveLength(1);

    configuration.switchProvider("provider:b");
    expect(latest().active?.normalizedTracks).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(700);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.snapshot.dependencyStamp).not.toBe(
      provider.requests[0]?.snapshot.dependencyStamp,
    );
  });

  it("does not let a previous-profile result repaint after switching", async () => {
    controller.dispose();
    provider = new ControlledProvider(true);
    presentations = [];
    const configuration = new MutableConfigurationSource();
    controller = new DesktopEngineController(
      provider,
      (presentation) => presentations.push(presentation),
      { configurationSource: configuration },
    );
    controller.observe(context("Ready."));
    configuration.switchProvider("provider:b");
    provider.complete(0);
    await flush();
    expect(latest().active?.normalizedTracks).toHaveLength(0);
    expect(latest().active?.sourceText).toBe("Ready.");
  });

  it("hides recent assistance produced under the previous profile", async () => {
    controller.dispose();
    provider = new ControlledProvider();
    presentations = [];
    const configuration = new MutableConfigurationSource();
    controller = new DesktopEngineController(
      provider,
      (presentation) => presentations.push(presentation),
      { configurationSource: configuration },
    );
    const text = "One. Two.";
    controller.observe(context(text, 1));
    provider.complete(0);
    await flush();
    controller.observe(context(text, 6));
    await vi.advanceTimersByTimeAsync(700);
    provider.complete(1);
    await flush();
    expect(latest().recent).toHaveLength(1);

    configuration.switchProvider("provider:b");
    expect(latest().active?.normalizedTracks).toHaveLength(0);
    expect(latest().recent).toHaveLength(0);
  });

  it("presents compact configuration errors while leaving observation usable", async () => {
    class ConfigurationFailureProvider implements AnalysisProvider {
      calls = 0;
      async analyze(): Promise<AnalysisProposal> {
        this.calls += 1;
        throw new WritingModelError("invalid-profile", "internal configuration detail");
      }
    }
    controller.dispose();
    const failure = new ConfigurationFailureProvider();
    presentations = [];
    controller = new DesktopEngineController(
      failure,
      (presentation) => presentations.push(presentation),
    );
    controller.observe(context("First."));
    await flush();
    expect(latest().active?.statusMessage).toBe("Configuration required");
    expect(JSON.stringify(latest())).not.toContain("internal configuration detail");
    controller.observe(context("Second."));
    expect(failure.calls).toBe(2);
  });

  it("confirms exact Native Intent without changing Source and regenerates immediately", async () => {
    controller.observe(context("Ready."));
    provider.complete(0);
    await flush();
    const target = latest().active!.nativeIntent!.target;
    const exact = "我确认的含义\n\n1. CJK 😀\n2. punctuation!  ";

    expect(controller.confirmNativeIntent(target, exact)).toBe("confirmed");

    expect(latest().active?.sourceText).toBe("Ready.");
    expect(latest().active?.nativeIntent).toMatchObject({
      text: exact,
      state: "confirmed",
    });
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]!.snapshot.sourceText).toBe("Ready.");
    expect(provider.requests[1]!.snapshot.confirmedNativeIntent?.text).toBe(exact);
    expect(
      provider.requests[1]!.snapshot.dependencyStamp.confirmedNativeIntentRevision,
    ).toBe(target.trackRevision + 1);

    provider.complete(1);
    await flush();
    expect(latest().active?.nativeIntent).toMatchObject({
      text: exact,
      state: "confirmed",
    });
    expect(latest().active?.normalizedTracks[0]?.text).toBe("normalized:Ready.");
  });

  it("rejects a stale target and removes confirmation after a source edit", async () => {
    controller.observe(context("Original."));
    provider.complete(0);
    await flush();
    const target = latest().active!.nativeIntent!.target;

    controller.observe(context("Changed."));

    expect(controller.confirmNativeIntent(target, "obsolete")).toBe("obsolete");
    expect(latest().active?.sourceText).toBe("Changed.");
    expect(latest().active?.nativeIntent?.state).not.toBe("confirmed");
    expect(provider.requests.at(-1)?.snapshot.confirmedNativeIntent).toBeUndefined();
  });

  it("keeps confirmation after generation failure and sends it again on retry", async () => {
    controller.observe(context("Retry."));
    provider.complete(0);
    await flush();
    const target = latest().active!.nativeIntent!.target;
    controller.confirmNativeIntent(target, "保留此确认");
    provider.fail(1);
    await flush();

    expect(latest().active?.status).toBe("failed");
    expect(latest().active?.nativeIntent).toMatchObject({
      text: "保留此确认",
      state: "confirmed",
    });

    const retry = controller.analyze(context("Retry."));
    expect(provider.requests[2]!.snapshot.confirmedNativeIntent?.text).toBe("保留此确认");
    provider.complete(2);
    await expect(retry).resolves.toMatchObject({ status: "applied" });
    expect(latest().active?.nativeIntent?.state).toBe("confirmed");
  });

  it("retains confirmation and regenerates with it after a profile switch", async () => {
    controller.dispose();
    provider = new ControlledProvider();
    presentations = [];
    const configuration = new MutableConfigurationSource();
    controller = new DesktopEngineController(
      provider,
      (presentation) => presentations.push(presentation),
      { configurationSource: configuration },
    );
    controller.observe(context("Profile."));
    provider.complete(0);
    await flush();
    controller.confirmNativeIntent(
      latest().active!.nativeIntent!.target,
      "跨模型保留",
    );
    provider.complete(1);
    await flush();

    configuration.switchProvider("provider:b");
    await vi.advanceTimersByTimeAsync(700);

    expect(latest().active?.nativeIntent).toMatchObject({
      text: "跨模型保留",
      state: "confirmed",
    });
    expect(latest().active?.normalizedTracks).toEqual([]);
    expect(provider.requests[2]!.snapshot.confirmedNativeIntent?.text).toBe("跨模型保留");
    expect(provider.requests[2]!.snapshot.dependencyStamp.processorConfigurationFingerprint)
      .toBe("provider:b");
  });

  it("keeps an edited inferred target confirmable while a background result completes", async () => {
    controller.dispose();
    provider = new ControlledProvider(true);
    presentations = [];
    const configuration = new MutableConfigurationSource();
    controller = new DesktopEngineController(
      provider,
      (presentation) => presentations.push(presentation),
      { configurationSource: configuration },
    );
    controller.observe(context("Race."));
    provider.complete(0);
    await flush();
    const draftTarget = latest().active!.nativeIntent!.target;

    configuration.switchProvider("provider:b");
    await vi.advanceTimersByTimeAsync(700);
    expect(provider.requests).toHaveLength(2);
    expect(controller.confirmNativeIntent(draftTarget, "用户草稿获胜")).toBe("confirmed");
    provider.complete(1);
    await flush();

    expect(latest().active?.nativeIntent).toMatchObject({
      text: "用户草稿获胜",
      state: "confirmed",
    });
    expect(provider.requests).toHaveLength(3);
    expect(provider.requests[2]!.snapshot.confirmedNativeIntent?.text).toBe("用户草稿获胜");
  });

  it("confirms a whole explicit selection and preserves it across context-only changes", async () => {
    const initial = context("AA\n\nselected\n\nZZ", 5, {
      selection: { start: 4, end: 12 },
    });
    const firstAnalysis = controller.analyze(initial);
    provider.complete(0);
    await expect(firstAnalysis).resolves.toMatchObject({ status: "applied" });
    const target = latest().active!.nativeIntent!.target;

    expect(controller.confirmNativeIntent(target, "整段选择的含义")).toBe("confirmed");
    expect(provider.requests[1]!.snapshot.sourceText).toBe("selected");
    expect(provider.requests[1]!.snapshot.confirmedNativeIntent?.text).toBe("整段选择的含义");
    provider.complete(1);
    await flush();

    controller.observe(context("BB\n\nselected\n\nYY", 5, {
      selection: { start: 4, end: 12 },
    }));

    expect(latest().active?.nativeIntent).toMatchObject({
      text: "整段选择的含义",
      state: "confirmed",
    });
    expect(latest().active?.normalizedTracks).toEqual([]);
    expect(provider.requests[2]!.snapshot.beforeContext).toBe("BB");
    expect(provider.requests[2]!.snapshot.confirmedNativeIntent?.text).toBe("整段选择的含义");
  });

  it("accepts the exact cursor-local unit and preserves surrounding text", async () => {
    const source = "Before. This method have problem. After.";
    const host = new ControllerTextHost(
      controller,
      context(source, source.indexOf("method")),
    );
    expect(provider.requests[0]?.snapshot.sourceText).toBe(
      "This method have problem.",
    );
    provider.complete(0, ["This method has a problem."]);
    await flush();

    const variant = latest().active!.normalizedTracks[0]!;
    expect(variant.canAccept).toBe(true);
    expect(variant.acceptTarget?.range).toEqual({ start: 8, end: 33 });
    await expect(
      controller.acceptNormalized(variant.acceptTarget!),
    ).resolves.toBe("accepted");

    expect(host.current.text).toBe("Before. This method has a problem. After.");
    expect(host.current.cursorOffset).toBe(34);
    expect(host.current.selection).toBeNull();
    expect(host.lastReplacement).toMatchObject({
      range: { start: 8, end: 33 },
      expectedText: "This method have problem.",
      replacementText: "This method has a problem.",
    });
    expect(latest().active?.normalizedTracks).toEqual([]);
  });

  it("accepts only the exact explicit multi-sentence selection", async () => {
    const source = "AA This have issue. It cost too much. ZZ";
    const start = source.indexOf("This");
    const end = source.indexOf(" ZZ");
    const host = new ControllerTextHost(
      controller,
      context(source, start, { selection: { start, end } }),
    );
    const analysis = controller.analyze(host.current);
    provider.complete(0, ["This has an issue. It costs too much."]);
    await expect(analysis).resolves.toMatchObject({ status: "applied" });
    const variant = latest().active!.normalizedTracks[0]!;

    await expect(
      controller.acceptNormalized(variant.acceptTarget!),
    ).resolves.toBe("accepted");

    expect(host.current.text).toBe(
      "AA This has an issue. It costs too much. ZZ",
    );
    expect(host.lastReplacement?.range).toEqual({ start, end });
    expect(host.lastReplacement?.expectedText).toBe(
      "This have issue. It cost too much.",
    );
    expect(host.current.cursorOffset).toBe(
      start + "This has an issue. It costs too much.".length,
    );
    expect(host.current.selection).toBeNull();
  });

  it.each([
    ["第一行有问题。", "第一行没有问题。"],
    ["A😀B.", "A🙂更好B。"],
    ["中文 English 有 problem.", "中文 English 没有 problem。"],
    ["Line source.", "First line.\n第二行。"],
  ])("preserves exact multilingual and multiline replacement text for %s", async (
    source,
    replacement,
  ) => {
    const host = new ControllerTextHost(controller, context(source));
    provider.complete(0, [replacement]);
    await flush();

    const target = latest().active!.normalizedTracks[0]!.acceptTarget!;
    await expect(controller.acceptNormalized(target)).resolves.toBe("accepted");

    expect(host.current.text).toBe(replacement);
    expect(host.current.cursorOffset).toBe(replacement.length);
    expect(host.lastReplacement?.replacementText).toBe(replacement);
  });

  it("applies the selected normalized variant rather than another variant", async () => {
    const host = new ControllerTextHost(controller, context("Needs work."));
    provider.complete(0, ["First wording.", "Selected wording."]);
    await flush();
    const variants = latest().active!.normalizedTracks;

    await controller.acceptNormalized(variants[1]!.acceptTarget!);

    expect(host.current.text).toBe("Selected wording.");
    expect(host.lastReplacement?.replacementText).toBe("Selected wording.");
    expect(host.replaceCount).toBe(1);
  });

  it("rejects an old Accept after a source edit and presents a compact status", async () => {
    const host = new ControllerTextHost(
      controller,
      context("This method have problem."),
    );
    provider.complete(0, ["This method has a problem."]);
    await flush();
    const target = latest().active!.normalizedTracks[0]!.acceptTarget!;

    host.edit(context("This method have serious problem."));
    await expect(controller.acceptNormalized(target)).resolves.toBe("obsolete");

    expect(host.current.text).toBe("This method have serious problem.");
    expect(host.replaceCount).toBe(0);
    expect(latest().active?.statusMessage).toBe(
      "Source changed; suggestion is no longer current.",
    );
    expect(latest().active?.normalizedTracks.every((track) => !track.canAccept))
      .toBe(true);
  });

  it("rejects when the captured host session changes after validation", async () => {
    const host = new ControllerTextHost(controller, context("Same text."));
    provider.complete(0, ["Replacement."]);
    await flush();
    const target = latest().active!.normalizedTracks[0]!.acceptTarget!;

    host.invalidateSession();
    await expect(controller.acceptNormalized(target)).resolves.toBe("obsolete");

    expect(host.current.text).toBe("Same text.");
    expect(host.replaceCount).toBe(0);
    expect(latest().active?.statusMessage).toContain("no longer current");
  });

  it("disables and rejects a result after a profile dependency change", async () => {
    controller.dispose();
    provider = new ControlledProvider();
    presentations = [];
    const configuration = new MutableConfigurationSource();
    controller = new DesktopEngineController(
      provider,
      (presentation) => presentations.push(presentation),
      { configurationSource: configuration },
    );
    const host = new ControllerTextHost(controller, context("Profile."));
    provider.complete(0, ["Updated profile wording."]);
    await flush();
    const target = latest().active!.normalizedTracks[0]!.acceptTarget!;

    configuration.switchProvider("provider:b");
    expect(latest().active?.normalizedTracks).toEqual([]);
    await expect(controller.acceptNormalized(target)).resolves.toBe("obsolete");
    expect(host.current.text).toBe("Profile.");
    expect(host.replaceCount).toBe(0);
  });

  it("accepts confirmed-intent output then clears old semantic state", async () => {
    const host = new ControllerTextHost(controller, context("Intent source."));
    provider.complete(0);
    await flush();
    controller.confirmNativeIntent(
      latest().active!.nativeIntent!.target,
      "用户确认的旧含义",
    );
    provider.complete(1, ["Confirmed intent wording."]);
    await flush();
    expect(latest().active?.nativeIntent?.state).toBe("confirmed");

    await controller.acceptNormalized(
      latest().active!.normalizedTracks[0]!.acceptTarget!,
    );

    expect(host.current.text).toBe("Confirmed intent wording.");
    expect(latest().active?.nativeIntent?.state).not.toBe("confirmed");
    expect(latest().active?.normalizedTracks).toEqual([]);
  });

  it("suppresses only the automatic request caused by Accept", async () => {
    const host = new ControllerTextHost(controller, context("Old wording."));
    provider.complete(0, ["Accepted wording."]);
    await flush();
    await controller.acceptNormalized(
      latest().active!.normalizedTracks[0]!.acceptTarget!,
    );
    expect(provider.requests).toHaveLength(1);

    const manual = controller.analyze(host.current);
    expect(provider.requests).toHaveLength(2);
    provider.complete(1);
    await expect(manual).resolves.toMatchObject({ status: "applied" });

    host.edit(context("Accepted wording. Next edit."));
    expect(provider.requests).toHaveLength(3);
    expect(provider.requests[2]!.snapshot.sourceText).toBe("Next edit.");
  });

  it("does not suppress a genuine edit while an asynchronous host edit is pending", async () => {
    let rejectReplace!: (error: unknown) => void;
    const pendingPort: TextEditPort = {
      replace: () => new Promise<void>((_resolve, reject) => {
        rejectReplace = reject;
      }),
    };
    controller.observe(context("Old."), pendingPort);
    provider.complete(0, ["Accepted."]);
    await flush();
    const pendingAccept = controller.acceptNormalized(
      latest().active!.normalizedTracks[0]!.acceptTarget!,
    );

    controller.observe(context("User edit."), { replace: () => undefined });
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]!.snapshot.sourceText).toBe("User edit.");

    rejectReplace(new Error("host race"));
    await expect(pendingAccept).resolves.toBe("obsolete");
  });

  it("cannot apply the same prepared Accept twice or after disposal", async () => {
    const host = new ControllerTextHost(controller, context("Once."));
    provider.complete(0, ["Only once."]);
    await flush();
    const target = latest().active!.normalizedTracks[0]!.acceptTarget!;

    await expect(controller.acceptNormalized(target)).resolves.toBe("accepted");
    await expect(controller.acceptNormalized(target)).resolves.toBe("obsolete");
    expect(host.current.text).toBe("Only once.");
    expect(host.replaceCount).toBe(1);

    controller.dispose();
    await expect(controller.acceptNormalized(target)).resolves.toBe("obsolete");
    expect(host.replaceCount).toBe(1);
  });
});
