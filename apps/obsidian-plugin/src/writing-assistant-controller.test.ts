import {
  AnalysisCoordinator,
  type AnalysisProposal,
  type AnalysisProvider,
  type AnalysisSnapshot,
} from "@non-native-writing/application";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_ANALYSIS_DEBOUNCE_MS } from "./debounced-analysis-scheduler.js";
import type { WritingAssistantViewModel } from "./presentation.js";
import {
  WritingAssistantController,
  type ObservedDocumentSource,
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

interface Harness {
  readonly controller: WritingAssistantController;
  readonly presenter: RecordingPresenter;
  readonly provider: ControlledProvider;
}

function source(documentKey: string, text: string): ObservedDocumentSource {
  return Object.freeze({ documentKey, text });
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
}

function resolveApplied(request: PendingRequest): void {
  request.resolve(Object.freeze({ outputs: Object.freeze([]) }));
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

  it("routes manual and automatic requests through the same coordinator path", async () => {
    const { controller, presenter, provider } = createHarness();

    controller.scheduleAutomaticAnalysis(source("note-a.md", "Automatic"));
    await vi.advanceTimersByTimeAsync(DEFAULT_ANALYSIS_DEBOUNCE_MS);
    await flushMicrotasks();
    const automaticRequest = provider.requests[0];
    if (automaticRequest === undefined) {
      throw new Error("Automatic analysis did not start.");
    }
    resolveApplied(automaticRequest);
    await flushMicrotasks();
    expect(presenter.latest.status).toBe("Applied");

    const manualAnalysis = controller.analyze(
      source("note-a.md", "Manual"),
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
});
