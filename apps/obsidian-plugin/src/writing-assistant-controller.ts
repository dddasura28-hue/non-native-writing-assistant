import {
  AnalysisCoordinator,
  type AnalysisConfiguration,
  type AnalysisOutcome,
} from "@non-native-writing/application";
import {
  WritingSegment,
  asSegmentId,
  asTrackId,
} from "@non-native-writing/core";
import type { TrackId } from "@non-native-writing/core";

import { DebouncedAnalysisScheduler } from "./debounced-analysis-scheduler.js";
import { DEVELOPMENT_ANALYSIS_CONFIGURATION } from "./development-configuration.js";
import {
  StaticAnalysisConfigurationSource,
  type AnalysisConfigurationSource,
} from "./provider/analysis-configuration-source.js";
import {
  createViewModel,
  statusForOutcome,
  type AnalysisStatus,
  type WritingAssistantViewModel,
} from "./presentation.js";

export interface WritingAssistantPresenter {
  present(viewModel: WritingAssistantViewModel): void;
}

export interface ObservedDocumentSource {
  readonly documentKey: string;
  readonly text: string;
}

export interface WritingAssistantControllerOptions {
  readonly debounceMs?: number;
  readonly getAutomaticPresenter?: GetWritingAssistant;
  readonly analysisConfigurationSource?: AnalysisConfigurationSource;
}

export type RevealWritingAssistant = () => Promise<WritingAssistantPresenter>;
export type GetWritingAssistant = () => Promise<
  WritingAssistantPresenter | undefined
>;

interface DocumentState {
  readonly documentKey: string;
  readonly segment: WritingSegment;
  documentRunNumber: number;
  visibleTrackIds: readonly TrackId[];
  status: AnalysisStatus;
  statusDetail?: string;
}

interface SourceActivation {
  readonly documentState: DocumentState;
  readonly documentChanged: boolean;
  readonly shouldAutomaticallyAnalyze: boolean;
}

export class WritingAssistantController {
  readonly #coordinator: AnalysisCoordinator;
  readonly #revealWritingAssistant: RevealWritingAssistant;
  readonly #getAutomaticPresenter: GetWritingAssistant;
  readonly #debouncedAnalysis: DebouncedAnalysisScheduler<ObservedDocumentSource>;
  readonly #analysisConfigurationSource: AnalysisConfigurationSource;
  readonly #unsubscribeAnalysisConfiguration: () => void;
  readonly #documents = new Map<string, DocumentState>();

  #activeDocumentKey: string | undefined;
  #nextSegmentNumber = 0;
  #presentationGeneration = 0;
  #disposed = false;

  constructor(
    coordinator: AnalysisCoordinator,
    revealWritingAssistant: RevealWritingAssistant,
    options: WritingAssistantControllerOptions = {},
  ) {
    this.#coordinator = coordinator;
    this.#revealWritingAssistant = revealWritingAssistant;
    this.#getAutomaticPresenter =
      options.getAutomaticPresenter ?? revealWritingAssistant;
    this.#analysisConfigurationSource =
      options.analysisConfigurationSource ??
      new StaticAnalysisConfigurationSource(
        DEVELOPMENT_ANALYSIS_CONFIGURATION,
      );
    this.#unsubscribeAnalysisConfiguration =
      this.#analysisConfigurationSource.onDidChange(() => {
        this.#handleAnalysisConfigurationChange();
      });
    this.#debouncedAnalysis = new DebouncedAnalysisScheduler(
      (source) => {
        void this.#analyzeSource(source, false).catch(() => {
          // Automatic host failures remain quiet; analysis failures are rendered.
        });
      },
      options.debounceMs,
    );
  }

  scheduleAutomaticAnalysis(source: ObservedDocumentSource): void {
    if (this.#disposed) {
      return;
    }

    const activation = this.#activateSource(source);
    const state = activation.documentState;

    if (activation.documentChanged) {
      this.#debouncedAnalysis.cancel();
    }

    if (source.text.length === 0) {
      this.#debouncedAnalysis.cancel();
      this.#coordinator.cancelAnalysis(state.segment.id);
      state.documentRunNumber += 1;
      resetPresentationState(state);
      this.#queuePresentation(state);
      return;
    }

    if (activation.shouldAutomaticallyAnalyze) {
      resetPresentationState(state);
      this.#debouncedAnalysis.schedule(source);
    }

    this.#queuePresentation(state);
  }

  async analyze(
    source: ObservedDocumentSource,
  ): Promise<AnalysisOutcome | undefined> {
    return this.#analyzeSource(source, true);
  }

  presentActive(presenter: WritingAssistantPresenter): void {
    if (this.#activeDocumentKey === undefined) {
      return;
    }

    const state = this.#documents.get(this.#activeDocumentKey);
    if (state !== undefined) {
      presenter.present(viewModelFor(state));
    }
  }

  async #analyzeSource(
    source: ObservedDocumentSource,
    revealView: boolean,
  ): Promise<AnalysisOutcome | undefined> {
    if (this.#disposed) {
      return undefined;
    }

    this.#debouncedAnalysis.cancel();
    const state = this.#activateSource(source).documentState;
    const documentRunNumber = ++state.documentRunNumber;

    this.#coordinator.cancelAnalysis(state.segment.id);

    if (source.text.length === 0) {
      resetPresentationState(state);
      const presenter = await this.#getPresenter(revealView);
      if (
        presenter !== undefined &&
        this.#isCurrentDocumentRun(state, documentRunNumber)
      ) {
        presenter.present(viewModelFor(state));
      }
      return undefined;
    }

    state.status = "Analyzing";
    state.statusDetail = undefined;
    state.visibleTrackIds = Object.freeze([]);

    const presenter = await this.#getPresenter(revealView);
    if (!this.#isCurrentDocumentRun(state, documentRunNumber)) {
      return undefined;
    }

    presenter?.present(viewModelFor(state));

    const outcome = await this.#coordinator.analyze(
      state.segment,
      this.#analysisConfigurationSource.getConfiguration(),
    );

    if (state.documentRunNumber !== documentRunNumber || this.#disposed) {
      return outcome;
    }

    state.status = statusForOutcome(outcome);
    state.statusDetail =
      outcome.status === "failed" ? describeError(outcome.error) : undefined;
    state.visibleTrackIds =
      outcome.status === "applied"
        ? outcome.appliedTrackIds
        : Object.freeze([]);

    if (
      presenter !== undefined &&
      this.#activeDocumentKey === state.documentKey
    ) {
      this.#presentationGeneration += 1;
      presenter.present(viewModelFor(state));
    }

    return outcome;
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }

    this.#disposed = true;
    this.#presentationGeneration += 1;
    this.#unsubscribeAnalysisConfiguration();
    this.#debouncedAnalysis.dispose();

    for (const state of this.#documents.values()) {
      state.documentRunNumber += 1;
      this.#coordinator.cancelAnalysis(state.segment.id);
    }
  }

  #handleAnalysisConfigurationChange(): void {
    if (this.#disposed) {
      return;
    }

    const configuration: AnalysisConfiguration =
      this.#analysisConfigurationSource.getConfiguration();
    for (const state of this.#documents.values()) {
      // Update the dependency context before cancellation so any late result
      // is stale by DependencyStamp comparison, even if transport ignores abort.
      this.#coordinator.updateConfiguration(state.segment.id, configuration);
      this.#coordinator.cancelAnalysis(state.segment.id);
      state.documentRunNumber += 1;
      resetPresentationState(state);
      if (state.documentKey === this.#activeDocumentKey) {
        this.#queuePresentation(state);
      }
    }
  }

  #activateSource(source: ObservedDocumentSource): SourceActivation {
    const previousState =
      this.#activeDocumentKey === undefined
        ? undefined
        : this.#documents.get(this.#activeDocumentKey);
    const documentChanged = this.#activeDocumentKey !== source.documentKey;

    let state = this.#documents.get(source.documentKey);
    const documentCreated = state === undefined;

    if (state === undefined) {
      const segmentNumber = ++this.#nextSegmentNumber;
      state = {
        documentKey: source.documentKey,
        segment: WritingSegment.create({
          id: asSegmentId(`obsidian-segment-${segmentNumber}`),
          sourceTrackId: asTrackId(`obsidian-source-${segmentNumber}`),
          sourceText: source.text,
        }),
        documentRunNumber: 0,
        visibleTrackIds: Object.freeze([]),
        status: "Idle",
      };
      this.#documents.set(source.documentKey, state);
    }

    if (documentChanged && previousState !== undefined) {
      previousState.documentRunNumber += 1;
      this.#coordinator.cancelAnalysis(previousState.segment.id);
      if (previousState.status === "Analyzing") {
        previousState.status = "Aborted";
        previousState.statusDetail = undefined;
        previousState.visibleTrackIds = Object.freeze([]);
      }
    }

    const sourceChanged = state.segment.sourceText !== source.text;
    if (sourceChanged) {
      state.documentRunNumber += 1;
      this.#coordinator.cancelAnalysis(state.segment.id);
      state.segment.updateSourceText(source.text);
      resetPresentationState(state);
    }

    this.#activeDocumentKey = source.documentKey;

    return {
      documentState: state,
      documentChanged,
      shouldAutomaticallyAnalyze:
        source.text.length > 0 &&
        (documentCreated ||
          sourceChanged ||
          (documentChanged && state.status !== "Applied")),
    };
  }

  #queuePresentation(state: DocumentState): void {
    const presentationGeneration = ++this.#presentationGeneration;
    void this.#presentState(state, presentationGeneration).catch(() => {
      // Automatic view synchronization should not create repeated Notices.
    });
  }

  async #presentState(
    state: DocumentState,
    presentationGeneration: number,
  ): Promise<void> {
    const presenter = await this.#getAutomaticPresenter();
    if (
      presenter === undefined ||
      this.#disposed ||
      this.#activeDocumentKey !== state.documentKey ||
      this.#presentationGeneration !== presentationGeneration
    ) {
      return;
    }

    presenter.present(viewModelFor(state));
  }

  async #getPresenter(
    revealView: boolean,
  ): Promise<WritingAssistantPresenter | undefined> {
    if (revealView) {
      return this.#revealWritingAssistant();
    }

    try {
      return await this.#getAutomaticPresenter();
    } catch {
      return undefined;
    }
  }

  // This routes presentation to the active host document. DependencyStamp
  // comparison in AnalysisCoordinator remains the result-correctness check.
  #isCurrentDocumentRun(
    state: DocumentState,
    documentRunNumber: number,
  ): boolean {
    return (
      !this.#disposed &&
      this.#activeDocumentKey === state.documentKey &&
      state.documentRunNumber === documentRunNumber
    );
  }
}

function resetPresentationState(state: DocumentState): void {
  state.status = "Idle";
  state.statusDetail = undefined;
  state.visibleTrackIds = Object.freeze([]);
}

function viewModelFor(state: DocumentState): WritingAssistantViewModel {
  return createViewModel(
    state.segment,
    state.status,
    state.visibleTrackIds,
    state.statusDetail,
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "Analysis failed.";
}
