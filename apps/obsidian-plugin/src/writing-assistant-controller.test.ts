import {
  AnalysisCoordinator,
  createTextContext,
  type AnalysisConfiguration,
  type AnalysisProposal,
  type AnalysisProvider,
  type AnalysisSnapshot,
  type ContextSelector,
  type TextComposition,
  type TextRange,
} from "@non-native-writing/application";
import {
  NORMALIZED_TRACK_TYPE_ID,
  asTrackId,
} from "@non-native-writing/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_ANALYSIS_DEBOUNCE_MS } from "./debounced-analysis-scheduler.js";
import type { AnalysisConfigurationSource } from "./provider/analysis-configuration-source.js";
import type { WritingAssistantViewModel } from "./presentation.js";
import {
  WritingAssistantController,
  type ObservedTextContext,
  type WritingAssistantPresenter,
} from "./writing-assistant-controller.js";

interface PendingRequest {
  readonly snapshot: AnalysisSnapshot;
  readonly signal: AbortSignal;
  readonly resolve: (proposal: AnalysisProposal) => void;
}

class ControlledProvider implements AnalysisProvider {
  readonly requests: PendingRequest[] = [];

  analyze(
    snapshot: AnalysisSnapshot,
    signal: AbortSignal,
  ): Promise<AnalysisProposal> {
    return new Promise((resolve) => {
      this.requests.push({ snapshot, signal, resolve });
    });
  }
}

class RecordingPresenter implements WritingAssistantPresenter {
  readonly presentations: WritingAssistantViewModel[] = [];

  present(viewModel: WritingAssistantViewModel): void {
    this.presentations.push(viewModel);
  }

  get latest(): WritingAssistantViewModel {
    const latest = this.presentations.at(-1);
    if (latest === undefined) {
      throw new Error("No presentation has been recorded.");
    }

    return latest;
  }
}

class MutableAnalysisConfigurationSource
  implements AnalysisConfigurationSource
{
  #configuration: AnalysisConfiguration;
  readonly #listeners = new Set<() => void>();

  constructor() {
    this.#configuration = {
      assistPolicyFingerprint: "assist:test",
      styleProfileFingerprint: "style:test",
      languageConfigurationFingerprint: "languages:test",
      processorConfigurationFingerprint: "provider:one",
      targetLanguageId: "en",
      nativeLanguageId: "zh-CN",
    };
  }

  getConfiguration(): AnalysisConfiguration {
    return this.#configuration;
  }

  onDidChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  switchProvider(): void {
    this.#configuration = {
      ...this.#configuration,
      processorConfigurationFingerprint: "provider:two",
    };
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

interface Harness {
  readonly controller: WritingAssistantController;
  readonly presenter: RecordingPresenter;
  readonly provider: ControlledProvider;
}

interface SourceOptions {
  readonly cursorOffset?: number;
  readonly selection?: TextRange | null;
  readonly composition?: TextComposition | null;
}

function source(
  documentKey: string,
  text: string,
  options: SourceOptions = {},
): ObservedTextContext {
  return Object.freeze({
    documentKey,
    textContext: createTextContext({
      text,
      cursorOffset: options.cursorOffset ?? text.length,
      selection: options.selection ?? null,
      composition: options.composition ?? null,
    }),
  });
}

function createHarness(): Harness {
  const provider = new ControlledProvider();
  const presenter = new RecordingPresenter();
  const controller = new WritingAssistantController(
    new AnalysisCoordinator(provider),
    async () => presenter,
  );

  return { controller, presenter, provider };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function resolveApplied(request: PendingRequest): void {
  request.resolve(Object.freeze({ outputs: Object.freeze([]) }));
}

function resolveNormalized(
  request: PendingRequest,
  text: string,
  id: string,
): void {
  request.resolve(
    Object.freeze({
      outputs: Object.freeze([
        Object.freeze({
          id: asTrackId(id),
          typeId: NORMALIZED_TRACK_TYPE_ID,
          text,
          provenance: "model" as const,
          dependencyStamp: request.snapshot.dependencyStamp,
        }),
      ]),
    }),
  );
}

async function resolveNormalizedAndFlush(
  request: PendingRequest,
  text: string,
  id: string,
): Promise<void> {
  resolveNormalized(request, text, id);
  await flushMicrotasks();
}

describe("WritingAssistantController automatic analysis", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces rapid source changes into one analysis of the latest text", async () => {
    const { controller, provider } = createHarness();

    controller.scheduleAutomaticAnalysis(source("note-a.md", "First"));
    controller.scheduleAutomaticAnalysis(source("note-a.md", "Second"));
    controller.scheduleAutomaticAnalysis(source("note-a.md", "Latest"));

    await vi.advanceTimersByTimeAsync(DEFAULT_ANALYSIS_DEBOUNCE_MS);
    await flushMicrotasks();

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.snapshot.sourceText).toBe("Latest");
    controller.dispose();
  });

  it("sends only the active paragraph with adjacent semantic context", async () => {
    const { controller, presenter, provider } = createHarness();
    const markdown = "# Heading\n\nMixed source 文本\n\nFinal paragraph.";
    const cursorOffset = markdown.indexOf("source");

    const analysis = controller.analyze(
      source("localized-note.md", markdown, { cursorOffset }),
    );
    await flushMicrotasks();
    const request = provider.requests[0];
    if (request === undefined) {
      throw new Error("Localized analysis did not start.");
    }

    expect(request.snapshot).toMatchObject({
      sourceText: "Mixed source 文本",
      beforeContext: "# Heading",
      afterContext: "Final paragraph.",
    });
    expect(presenter.latest.sourceText).toBe("Mixed source 文本");

    resolveApplied(request);
    await analysis;
    controller.dispose();
  });

  it("routes selector output into the existing WritingSegment analysis path", async () => {
    const provider = new ControlledProvider();
    const presenter = new RecordingPresenter();
    const contextSelector: ContextSelector = {
      select(context) {
        return Object.freeze({
          activeText: context.text.slice(2, 8),
          sourceRange: Object.freeze({ start: 2, end: 8 }),
          beforeContext: context.text.slice(0, 2),
          afterContext: context.text.slice(8),
        });
      },
    };
    const controller = new WritingAssistantController(
      new AnalysisCoordinator(provider),
      async () => presenter,
      { contextSelector },
    );

    const analysis = controller.analyze(
      source("selection.md", "--active--"),
    );
    await flushMicrotasks();
    const request = provider.requests[0];
    if (request === undefined) {
      throw new Error("Selected-context analysis did not start.");
    }

    expect(request.snapshot.sourceText).toBe("active");
    expect(presenter.latest.sourceText).toBe("active");

    resolveApplied(request);
    await analysis;
    controller.dispose();
  });

  it("sends an explicit selection to the model request exactly", async () => {
    const { controller, presenter, provider } = createHarness();
    const text = "Before block\n\nSelect this\nand this\n\nAfter block";
    const start = text.indexOf("Select");
    const end = text.indexOf("\n\nAfter");

    const analysis = controller.analyze(
      source("selected.md", text, {
        cursorOffset: start,
        selection: { start, end },
      }),
    );
    await flushMicrotasks();
    const request = provider.requests[0];
    if (request === undefined) {
      throw new Error("Explicit-selection analysis did not start.");
    }

    expect(request.snapshot).toMatchObject({
      sourceText: "Select this\nand this",
      beforeContext: "Before block",
      afterContext: "After block",
    });
    expect(presenter.latest.sourceText).toBe("Select this\nand this");

    resolveApplied(request);
    await analysis;
    controller.dispose();
  });

  it("renders only normalized output for the active paragraph", async () => {
    const { controller, presenter, provider } = createHarness();
    const text = "Context A\n\nDraft B\n\nContext C";
    const analysis = controller.analyze(
      source("normalized.md", text, { cursorOffset: text.indexOf("B") }),
    );
    await flushMicrotasks();
    const request = provider.requests[0];
    if (request === undefined) {
      throw new Error("Active-paragraph analysis did not start.");
    }

    resolveNormalized(request, "Normalized B", "normalized-active-b");
    await analysis;

    expect(presenter.latest.sourceText).toBe("Draft B");
    expect(presenter.latest.normalizedTracks).toEqual([
      expect.objectContaining({ text: "Normalized B" }),
    ]);
    expect(presenter.latest.normalizedTracks[0]?.text).not.toContain(
      "Context A",
    );
    expect(presenter.latest.normalizedTracks[0]?.text).not.toContain(
      "Context C",
    );
    controller.dispose();
  });

  it("invalidates a pending result when only surrounding context changes", async () => {
    const { controller, presenter, provider } = createHarness();
    const original = "Before A\n\nActive B\n\nAfter C";
    const pending = controller.analyze(
      source("context-change.md", original, {
        cursorOffset: original.indexOf("Active"),
      }),
    );
    await flushMicrotasks();
    const request = provider.requests[0];
    if (request === undefined) {
      throw new Error("Context-sensitive analysis did not start.");
    }

    const revised = "Before revised\n\nActive B\n\nAfter C";
    controller.scheduleAutomaticAnalysis(
      source("context-change.md", revised, {
        cursorOffset: revised.indexOf("Active"),
      }),
    );
    await flushMicrotasks();

    expect(request.signal.aborted).toBe(true);
    resolveNormalized(request, "Stale active", "stale-context-output");
    await expect(pending).resolves.toEqual({ status: "stale" });
    expect(presenter.latest.sourceText).toBe("Active B");
    expect(presenter.latest.normalizedTracks).toEqual([]);
    controller.dispose();
  });

  it("prevents a late result from repainting another block in the same document", async () => {
    const { controller, presenter, provider } = createHarness();
    const text = "Block A\n\nBlock B\n\nBlock C";
    const pending = controller.analyze(
      source("block-switch.md", text, {
        cursorOffset: text.indexOf("Block B"),
      }),
    );
    await flushMicrotasks();
    const request = provider.requests[0];
    if (request === undefined) {
      throw new Error("First block analysis did not start.");
    }

    controller.scheduleAutomaticAnalysis(
      source("block-switch.md", text, {
        cursorOffset: text.indexOf("Block C"),
      }),
    );
    await flushMicrotasks();

    expect(request.signal.aborted).toBe(true);
    resolveNormalized(request, "Normalized B", "late-block-b");
    await expect(pending).resolves.toEqual({ status: "stale" });
    expect(presenter.latest.sourceText).toBe("Block C");
    expect(presenter.latest.status).toBe("Idle");
    expect(presenter.latest.normalizedTracks).toEqual([]);
    controller.dispose();
  });

  it("rebinds identical text at a different source range", async () => {
    const { controller, presenter, provider } = createHarness();
    const text = "Same text\n\nSame text";
    const firstAnalysis = controller.analyze(
      source("identical-blocks.md", text, { cursorOffset: 1 }),
    );
    await flushMicrotasks();
    const firstRequest = provider.requests[0];
    if (firstRequest === undefined) {
      throw new Error("First identical block analysis did not start.");
    }

    controller.scheduleAutomaticAnalysis(
      source("identical-blocks.md", text, {
        cursorOffset: text.lastIndexOf("Same text") + 1,
      }),
    );
    await vi.advanceTimersByTimeAsync(DEFAULT_ANALYSIS_DEBOUNCE_MS);
    await flushMicrotasks();
    expect(provider.requests).toHaveLength(1);
    expect(firstRequest.signal.aborted).toBe(true);

    resolveNormalized(firstRequest, "Wrong location", "old-identical-block");
    await expect(firstAnalysis).resolves.toEqual({ status: "stale" });
    await flushMicrotasks();
    const secondRequest = provider.requests[1]!;

    expect(secondRequest.snapshot.segmentId).toBe(firstRequest.snapshot.segmentId);
    expect(secondRequest.snapshot.dependencyStamp.contextFingerprint).not.toBe(
      firstRequest.snapshot.dependencyStamp.contextFingerprint,
    );
    expect(secondRequest.snapshot.sourceText).toBe("Same text");

    expect(presenter.latest.normalizedTracks).toEqual([]);

    resolveApplied(secondRequest);
    await flushMicrotasks();
    controller.dispose();
  });

  it("resets the debounce interval after a later edit", async () => {
    const { controller, provider } = createHarness();

    controller.scheduleAutomaticAnalysis(source("note-a.md", "First"));
    await vi.advanceTimersByTimeAsync(DEFAULT_ANALYSIS_DEBOUNCE_MS - 100);

    controller.scheduleAutomaticAnalysis(source("note-a.md", "Second"));
    await vi.advanceTimersByTimeAsync(DEFAULT_ANALYSIS_DEBOUNCE_MS - 1);
    expect(provider.requests).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.snapshot.sourceText).toBe("Second");
    controller.dispose();
  });

  it("does not let a pending result for document A repaint document B", async () => {
    const { controller, presenter, provider } = createHarness();
    const analysisA = controller.analyze(source("note-a.md", "Source A"));
    await flushMicrotasks();
    const requestA = provider.requests[0];
    if (requestA === undefined) {
      throw new Error("Document A analysis did not start.");
    }

    controller.scheduleAutomaticAnalysis(source("note-b.md", "Source B"));
    await flushMicrotasks();
    expect(requestA.signal.aborted).toBe(true);

    resolveApplied(requestA);
    await analysisA;

    expect(presenter.latest.sourceText).toBe("Source B");
    expect(presenter.latest.status).toBe("Idle");
    controller.dispose();
  });

  it("updates the presented source immediately when documents switch", async () => {
    const { controller, presenter } = createHarness();

    controller.scheduleAutomaticAnalysis(source("note-a.md", "Source A"));
    await flushMicrotasks();
    expect(presenter.latest.sourceText).toBe("Source A");

    controller.scheduleAutomaticAnalysis(source("note-b.md", "Source B"));
    await flushMicrotasks();
    expect(presenter.latest.sourceText).toBe("Source B");
    controller.dispose();
  });

  it("presents an empty document as Idle without calling the provider", async () => {
    const { controller, presenter, provider } = createHarness();

    controller.scheduleAutomaticAnalysis(source("empty.md", ""));
    await vi.advanceTimersByTimeAsync(DEFAULT_ANALYSIS_DEBOUNCE_MS * 2);
    await flushMicrotasks();

    expect(provider.requests).toHaveLength(0);
    expect(presenter.latest).toMatchObject({
      sourceText: "",
      status: "Idle",
      nativeIntentTracks: [],
      normalizedTracks: [],
    });
    controller.dispose();
  });

  it("treats a cursor in a blank separator as neutral without calling the provider", async () => {
    const { controller, presenter, provider } = createHarness();
    const text = "Block A\n\nBlock B";

    controller.scheduleAutomaticAnalysis(
      source("blank-region.md", text, { cursorOffset: 8 }),
    );
    await vi.advanceTimersByTimeAsync(DEFAULT_ANALYSIS_DEBOUNCE_MS * 2);
    await flushMicrotasks();

    expect(provider.requests).toHaveLength(0);
    expect(presenter.latest).toMatchObject({ sourceText: "", status: "Idle" });
    controller.dispose();
  });

  it("does not automatically analyze uncommitted IME composition", async () => {
    const { controller, provider } = createHarness();
    const text = "Composing.";

    controller.scheduleAutomaticAnalysis(
      source("composition.md", text, {
        composition: { start: 0, end: text.length, text },
      }),
    );
    await vi.advanceTimersByTimeAsync(DEFAULT_ANALYSIS_DEBOUNCE_MS * 2);
    await flushMicrotasks();

    expect(provider.requests).toHaveLength(0);
    controller.dispose();
  });

  it("does not apply cursor-local automatic triggers to explicit selections", async () => {
    const { controller, provider } = createHarness();
    const text = "Selected sentence.";

    controller.scheduleAutomaticAnalysis(
      source("automatic-selection.md", text, {
        selection: { start: 0, end: text.length },
      }),
    );
    await vi.advanceTimersByTimeAsync(DEFAULT_ANALYSIS_DEBOUNCE_MS * 2);
    await flushMicrotasks();

    expect(provider.requests).toHaveLength(0);
    controller.dispose();
  });

  it("routes manual and automatic requests through the same coordinator path", async () => {
    const { controller, presenter, provider } = createHarness();
    const automaticText = "Before\n\nAutomatic\n\nAfter";

    controller.scheduleAutomaticAnalysis(
      source("note-a.md", automaticText, {
        cursorOffset: automaticText.indexOf("Automatic"),
      }),
    );
    await vi.advanceTimersByTimeAsync(DEFAULT_ANALYSIS_DEBOUNCE_MS);
    await flushMicrotasks();
    const automaticRequest = provider.requests[0];
    if (automaticRequest === undefined) {
      throw new Error("Automatic analysis did not start.");
    }
    resolveApplied(automaticRequest);
    await flushMicrotasks();
    expect(presenter.latest.status).toBe("Applied");

    const manualText = "Before\n\nManual\n\nAfter";
    const manualAnalysis = controller.analyze(
      source("note-a.md", manualText, {
        cursorOffset: manualText.indexOf("Manual"),
      }),
    );
    await flushMicrotasks();
    const manualRequest = provider.requests[1];
    if (manualRequest === undefined) {
      throw new Error("Manual analysis did not start.");
    }

    expect(
      provider.requests.map((request) => request.snapshot.sourceText),
    ).toEqual(["Automatic", "Manual"]);

    resolveApplied(manualRequest);
    await manualAnalysis;
    expect(presenter.latest.status).toBe("Applied");
    controller.dispose();
  });

  it("prevents pending debounced work from running after disposal", async () => {
    const { controller, provider } = createHarness();

    controller.scheduleAutomaticAnalysis(source("note-a.md", "Pending"));
    controller.dispose();

    await vi.advanceTimersByTimeAsync(DEFAULT_ANALYSIS_DEBOUNCE_MS * 2);
    await flushMicrotasks();
    expect(provider.requests).toHaveLength(0);
  });

  it("cancels and invalidates pending analysis when its configuration source changes", async () => {
    const provider = new ControlledProvider();
    const presenter = new RecordingPresenter();
    const configuration = new MutableAnalysisConfigurationSource();
    const controller = new WritingAssistantController(
      new AnalysisCoordinator(provider),
      async () => presenter,
      { analysisConfigurationSource: configuration },
    );
    const outcome = controller.analyze(source("note-a.md", "Pending"));
    await flushMicrotasks();
    const request = provider.requests[0];
    if (request === undefined) {
      throw new Error("Analysis did not start.");
    }

    configuration.switchProvider();
    expect(request.signal.aborted).toBe(true);
    resolveApplied(request);

    await expect(outcome).resolves.toEqual({ status: "stale" });
    expect(presenter.latest.status).toBe("Idle");
    controller.dispose();
  });
});

describe("WritingAssistantController incremental unit analysis", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("presents and analyzes only the cursor-active sentence", async () => {
    const { controller, presenter, provider } = createHarness();
    const text = "First. Second. Third.";
    const analysis = controller.analyze(
      source("units.md", text, { cursorOffset: text.indexOf("Second") + 2 }),
    );
    await flushMicrotasks();

    expect(presenter.latest.sourceText).toBe("Second.");
    expect(provider.requests[0]?.snapshot.sourceText).toBe("Second.");
    await resolveNormalizedAndFlush(
      provider.requests[0]!,
      "Normalized second.",
      "second-output",
    );
    await analysis;

    expect(presenter.latest).toMatchObject({
      sourceText: "Second.",
      status: "Applied",
    });
    expect(presenter.latest.normalizedTracks).toEqual([
      expect.objectContaining({ text: "Normalized second." }),
    ]);
    expect(provider.requests).toHaveLength(1);
    controller.dispose();
  });

  it("reanalyzes only the active edited sentence", async () => {
    const { controller, presenter, provider } = createHarness();
    const original = "One. Two. Three.";
    const firstAnalysis = controller.analyze(
      source("edit-unit.md", original, {
        cursorOffset: original.indexOf("Two") + 1,
      }),
    );
    await flushMicrotasks();
    await resolveNormalizedAndFlush(
      provider.requests[0]!,
      "Initial second.",
      "initial-second",
    );
    await firstAnalysis;

    const edited = "One. Duo! Three.";
    const secondAnalysis = controller.analyze(
      source("edit-unit.md", edited, {
        cursorOffset: edited.indexOf("Duo") + 1,
      }),
    );
    await flushMicrotasks();

    expect(provider.requests[1]?.snapshot.sourceText).toBe("Duo!");
    expect(presenter.latest.sourceText).toBe("Duo!");
    await resolveNormalizedAndFlush(
      provider.requests[1]!,
      "Edited second.",
      "edited-second",
    );
    await secondAnalysis;

    expect(provider.requests).toHaveLength(2);
    expect(presenter.latest.normalizedTracks).toEqual([
      expect.objectContaining({ text: "Edited second." }),
    ]);
    controller.dispose();
  });

  it("immediately analyzes a completed edit without invalidating earlier causal siblings", async () => {
    const { controller, presenter, provider } = createHarness();
    const original = "A. B. C.";
    const cursors = [
      original.indexOf("A"),
      original.indexOf("B"),
      original.indexOf("C"),
    ];

    for (const [index, cursorOffset] of cursors.entries()) {
      const pending = controller.analyze(
        source("lazy-siblings.md", original, { cursorOffset }),
      );
      await flushMicrotasks();
      expect(provider.requests[index]?.snapshot.sourceText).toBe(
        ["A.", "B.", "C."][index],
      );
      await resolveNormalizedAndFlush(
        provider.requests[index]!,
        `Initial ${index}.`,
        `lazy-initial-${index}`,
      );
      await pending;
    }

    const edited = "A. B. Changed C!";
    controller.scheduleAutomaticAnalysis(
      source("lazy-siblings.md", edited, { cursorOffset: edited.length }),
    );
    await flushMicrotasks();
    expect(presenter.latest.sourceText).toBe("Changed C!");
    expect(presenter.latest.normalizedTracks).toEqual([]);
    expect(provider.requests).toHaveLength(4);
    expect(provider.requests[3]?.snapshot.sourceText).toBe("Changed C!");
    await resolveNormalizedAndFlush(
      provider.requests[3]!,
      "Changed C normalized.",
      "lazy-changed-c",
    );

    controller.scheduleAutomaticAnalysis(
      source("lazy-siblings.md", edited, {
        cursorOffset: edited.indexOf("B"),
      }),
    );
    await flushMicrotasks();
    expect(presenter.latest.sourceText).toBe("B.");
    expect(presenter.latest.normalizedTracks).toEqual([
      expect.objectContaining({ text: "Initial 1." }),
    ]);
    expect(provider.requests).toHaveLength(4);
    controller.dispose();
  });

  it("moves presentation to edited sentence three", async () => {
    const { controller, presenter, provider } = createHarness();
    const original = "One. Two. Three.";
    const initial = controller.analyze(
      source("third.md", original, { cursorOffset: 1 }),
    );
    await flushMicrotasks();
    await resolveNormalizedAndFlush(
      provider.requests[0]!,
      "Initial one.",
      "third-initial-one",
    );
    await initial;

    const edited = "One. Two. Tres!!";
    const update = controller.analyze(
      source("third.md", edited, { cursorOffset: edited.length }),
    );
    await flushMicrotasks();

    expect(presenter.latest.sourceText).toBe("Tres!!");
    expect(provider.requests[1]?.snapshot.sourceText).toBe("Tres!!");
    await resolveNormalizedAndFlush(
      provider.requests[1]!,
      "Edited third.",
      "edited-third",
    );
    await update;
    expect(presenter.latest.sourceText).toBe("Tres!!");
    controller.dispose();
  });

  it("keeps a valid previous-unit request, caches it, and never repaints the new target", async () => {
    const { controller, presenter, provider } = createHarness();
    const text = "One. Two. Three.";
    const analysis = controller.analyze(
      source("cursor-move.md", text, {
        cursorOffset: text.indexOf("Two") + 1,
      }),
    );
    await flushMicrotasks();
    const sentenceTwoRequest = provider.requests[0]!;
    expect(sentenceTwoRequest.snapshot.sourceText).toBe("Two.");

    controller.scheduleAutomaticAnalysis(
      source("cursor-move.md", text, {
        cursorOffset: text.indexOf("Three") + 1,
      }),
    );
    await flushMicrotasks();
    expect(sentenceTwoRequest.signal.aborted).toBe(false);
    expect(presenter.latest.sourceText).toBe("Three.");

    await vi.advanceTimersByTimeAsync(DEFAULT_ANALYSIS_DEBOUNCE_MS);
    await flushMicrotasks();
    expect(provider.requests).toHaveLength(1);

    await resolveNormalizedAndFlush(
      sentenceTwoRequest,
      "Two normalized.",
      "cursor-two",
    );
    await expect(analysis).resolves.toMatchObject({ status: "applied" });
    expect(presenter.latest.sourceText).toBe("Three.");
    expect(presenter.latest.normalizedTracks).toEqual([]);

    expect(provider.requests[1]?.snapshot.sourceText).toBe("Three.");
    await resolveNormalizedAndFlush(
      provider.requests[1]!,
      "Three normalized.",
      "cursor-three",
    );
    expect(presenter.latest.sourceText).toBe("Three.");
    expect(presenter.latest.normalizedTracks).toEqual([
      expect.objectContaining({ text: "Three normalized." }),
    ]);

    controller.scheduleAutomaticAnalysis(
      source("cursor-move.md", text, {
        cursorOffset: text.indexOf("Two") + 1,
      }),
    );
    await flushMicrotasks();
    expect(provider.requests).toHaveLength(2);
    expect(presenter.latest.sourceText).toBe("Two.");
    expect(presenter.latest.normalizedTracks).toEqual([
      expect.objectContaining({ text: "Two normalized." }),
    ]);
    controller.dispose();
  });

  it("starts a completed sentence immediately and deduplicates repeated or whitespace events", async () => {
    const { controller, provider } = createHarness();

    controller.scheduleAutomaticAnalysis(source("completion.md", "I agree."));
    await flushMicrotasks();
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.snapshot.sourceText).toBe("I agree.");

    controller.scheduleAutomaticAnalysis(source("completion.md", "I agree."));
    controller.scheduleAutomaticAnalysis(source("completion.md", "I agree. "));
    await flushMicrotasks();
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.signal.aborted).toBe(false);

    resolveApplied(provider.requests[0]!);
    await flushMicrotasks();
    controller.dispose();
  });

  it("rejects an immediate result after terminal punctuation is deleted", async () => {
    const { controller, presenter, provider } = createHarness();

    controller.scheduleAutomaticAnalysis(source("delete-terminal.md", "Wrong."));
    await flushMicrotasks();
    const completedRequest = provider.requests[0]!;

    controller.scheduleAutomaticAnalysis(source("delete-terminal.md", "Wrong"));
    await flushMicrotasks();
    expect(completedRequest.signal.aborted).toBe(true);
    expect(presenter.latest.sourceText).toBe("Wrong");

    resolveNormalized(
      completedRequest,
      "Must not be cached.",
      "deleted-terminal-output",
    );
    await flushMicrotasks();
    expect(presenter.latest.sourceText).toBe("Wrong");
    expect(presenter.latest.normalizedTracks).toEqual([]);
    controller.dispose();
  });

  it("coalesces rapid completed sentences into sequential provider requests", async () => {
    const { controller, presenter, provider } = createHarness();

    controller.scheduleAutomaticAnalysis(source("rapid.md", "A."));
    controller.scheduleAutomaticAnalysis(source("rapid.md", "A. B."));
    controller.scheduleAutomaticAnalysis(source("rapid.md", "A. B. C."));
    await flushMicrotasks();

    expect(provider.requests.map((request) => request.snapshot.sourceText)).toEqual([
      "A.",
    ]);
    expect(presenter.latest.sourceText).toBe("C.");

    await resolveNormalizedAndFlush(
      provider.requests[0]!,
      "A normalized.",
      "rapid-a-output",
    );
    expect(provider.requests.map((request) => request.snapshot.sourceText)).toEqual([
      "A.",
      "B.",
    ]);
    expect(presenter.latest.sourceText).toBe("C.");
    expect(presenter.latest.normalizedTracks).toEqual([]);

    await resolveNormalizedAndFlush(
      provider.requests[1]!,
      "B normalized.",
      "rapid-b-output",
    );
    expect(provider.requests.map((request) => request.snapshot.sourceText)).toEqual([
      "A.",
      "B.",
      "C.",
    ]);
    await resolveNormalizedAndFlush(
      provider.requests[2]!,
      "C normalized.",
      "rapid-c-output",
    );
    expect(presenter.latest.normalizedTracks).toEqual([
      expect.objectContaining({ text: "C normalized." }),
    ]);
    controller.dispose();
  });

  it("analyzes an unfinished final unit after the existing debounce", async () => {
    const { controller, presenter, provider } = createHarness();
    const text = "I think this policy is";

    controller.scheduleAutomaticAnalysis(
      source("unfinished.md", text, { cursorOffset: text.length }),
    );
    await vi.advanceTimersByTimeAsync(DEFAULT_ANALYSIS_DEBOUNCE_MS - 1);
    expect(provider.requests).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(provider.requests[0]?.snapshot.sourceText).toBe(text);
    expect(presenter.latest.sourceText).toBe(text);
    resolveApplied(provider.requests[0]!);
    await flushMicrotasks();
    controller.dispose();
  });

  it("manual Analyze targets only the cursor-active unit", async () => {
    const { controller, provider } = createHarness();
    const text = "First. Second.";
    const analysis = controller.analyze(
      source("manual-units.md", text, { cursorOffset: text.length }),
    );
    await flushMicrotasks();

    expect(provider.requests[0]?.snapshot.sourceText).toBe("Second.");
    resolveApplied(provider.requests[0]!);
    await analysis;
    expect(provider.requests.map((request) => request.snapshot.sourceText)).toEqual([
      "Second.",
    ]);
    controller.dispose();
  });

  it("keeps an explicit single-sentence selection as one whole target", async () => {
    const { controller, provider } = createHarness();
    const text = "Before. Selected sentence. After.";
    const start = text.indexOf("Selected");
    const end = start + "Selected sentence.".length;
    const analysis = controller.analyze(
      source("single-selection.md", text, {
        cursorOffset: end,
        selection: { start, end },
      }),
    );
    await flushMicrotasks();

    expect(provider.requests[0]?.snapshot.sourceText).toBe(
      "Selected sentence.",
    );
    resolveApplied(provider.requests[0]!);
    await analysis;
    expect(provider.requests).toHaveLength(1);
    controller.dispose();
  });

  it("keeps an explicit multi-sentence selection as one whole target", async () => {
    const { controller, presenter, provider } = createHarness();
    const text = "First selected. Second selected. Outside.";
    const end = text.indexOf(" Outside");
    const selected = text.slice(0, end);
    const analysis = controller.analyze(
      source("multi-selection.md", text, {
        cursorOffset: end,
        selection: { start: 0, end },
      }),
    );
    await flushMicrotasks();

    expect(provider.requests[0]?.snapshot.sourceText).toBe(selected);
    expect(presenter.latest.sourceText).toBe(selected);
    resolveApplied(provider.requests[0]!);
    await analysis;
    expect(provider.requests).toHaveLength(1);
    controller.dispose();
  });

  it("refreshes only the active unit after a profile switch and lazily refreshes another", async () => {
    const provider = new ControlledProvider();
    const presenter = new RecordingPresenter();
    const configuration = new MutableAnalysisConfigurationSource();
    const controller = new WritingAssistantController(
      new AnalysisCoordinator(provider),
      async () => presenter,
      { analysisConfigurationSource: configuration },
    );
    const text = "One. Two. Three.";
    const cursors = [text.indexOf("One"), text.indexOf("Two"), text.indexOf("Three")];
    for (const [index, cursorOffset] of cursors.entries()) {
      const initial = controller.analyze(
        source("profile-switch.md", text, { cursorOffset }),
      );
      await flushMicrotasks();
      await resolveNormalizedAndFlush(
        provider.requests[index]!,
        `Provider one ${index}.`,
        `provider-one-output-${index}`,
      );
      await initial;
    }
    expect(presenter.latest.sourceText).toBe("Three.");

    configuration.switchProvider();
    await flushMicrotasks();
    expect(presenter.latest.normalizedTracks).toEqual([]);
    expect(provider.requests).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(DEFAULT_ANALYSIS_DEBOUNCE_MS);
    await flushMicrotasks();

    expect(provider.requests).toHaveLength(4);
    expect(provider.requests[3]?.snapshot.sourceText).toBe("Three.");
    expect(provider.requests[3]?.snapshot.dependencyStamp.processorConfigurationFingerprint)
      .toBe("provider:two");
    await resolveNormalizedAndFlush(
      provider.requests[3]!,
      "Provider two three.",
      "provider-two-output-three",
    );
    expect(presenter.latest.normalizedTracks[0]?.text).toBe("Provider two three.");

    controller.scheduleAutomaticAnalysis(
      source("profile-switch.md", text, { cursorOffset: text.indexOf("Two") }),
    );
    await flushMicrotasks();
    expect(presenter.latest.sourceText).toBe("Two.");
    expect(presenter.latest.normalizedTracks).toEqual([]);
    expect(provider.requests).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(DEFAULT_ANALYSIS_DEBOUNCE_MS);
    await flushMicrotasks();
    expect(provider.requests).toHaveLength(5);
    expect(provider.requests[4]?.snapshot.sourceText).toBe("Two.");
    expect(provider.requests[4]?.snapshot.dependencyStamp.processorConfigurationFingerprint)
      .toBe("provider:two");
    await resolveNormalizedAndFlush(
      provider.requests[4]!,
      "Provider two two.",
      "provider-two-output-two",
    );
    expect(presenter.latest.normalizedTracks[0]?.text).toBe("Provider two two.");
    controller.dispose();
  });
});
