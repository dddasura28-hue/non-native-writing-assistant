import {
  AnalysisCoordinator,
  IncrementalUnitAnalysisCoordinator,
  LocalBlockContextSelector,
  SentenceUnitAnalysisTriggerPolicy,
  SimpleWritingUnitSegmenter,
  assertContextSelectionMapsToText,
  createAnalysisContext,
  createUnitAssistancePresentationModel,
  createUnitSourceFingerprint,
  createWholeAvailableAnalysisContext,
  selectCurrentWritingUnit,
  type AnalysisConfiguration,
  type AnalysisContext,
  type AnalysisOutcome,
  type ContextSelection,
  type ContextSelector,
  type TextContext,
  type UnitAnalysisRequestKind,
  type UnitAnalysisTriggerPolicy,
  type UnitSourceFingerprint,
  type WritingUnit,
  type WritingUnitSegmenter,
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
  createIncrementalViewModel,
  createViewModel,
  statusForOutcome,
  type AnalysisStatus,
  type WritingAssistantViewModel,
} from "./presentation.js";

export interface WritingAssistantPresenter {
  present(viewModel: WritingAssistantViewModel): void;
}

export interface ObservedTextContext {
  readonly documentKey: string;
  readonly textContext: TextContext;
}

export interface WritingAssistantControllerOptions {
  readonly debounceMs?: number;
  readonly getAutomaticPresenter?: GetWritingAssistant;
  readonly analysisConfigurationSource?: AnalysisConfigurationSource;
  readonly contextSelector?: ContextSelector;
  readonly writingUnitSegmenter?: WritingUnitSegmenter;
  readonly unitAnalysisTriggerPolicy?: UnitAnalysisTriggerPolicy;
}

export type RevealWritingAssistant = () => Promise<WritingAssistantPresenter>;
export type GetWritingAssistant = () => Promise<
  WritingAssistantPresenter | undefined
>;

interface DocumentState {
  readonly documentKey: string;
  segment: WritingSegment;
  readonly unitAnalysis: IncrementalUnitAnalysisCoordinator;
  units: readonly WritingUnit[];
  currentUnitId: string | null;
  explicitSelection: boolean;
  selectedSource: SelectedDocumentSource;
  configuration: AnalysisConfiguration;
  analysisTarget: DocumentAnalysisTarget | null;
  documentRunNumber: number;
  visibleTrackIds: readonly TrackId[];
  status: AnalysisStatus;
  statusDetail?: string;
  readonly immediateCompletionFingerprints: Set<UnitSourceFingerprint>;
}

interface SourceActivation {
  readonly documentState: DocumentState;
  readonly documentChanged: boolean;
  readonly shouldAutomaticallyAnalyze: boolean;
  readonly sourceChanged: boolean;
}

interface SelectedDocumentSource {
  readonly documentKey: string;
  readonly selection: ContextSelection | null;
  readonly explicitSelection: boolean;
  readonly cursorOffset: number;
  readonly compositionBlocked: boolean;
}

interface AutomaticAnalysisRequest {
  readonly source: SelectedDocumentSource;
  readonly kind: Exclude<UnitAnalysisRequestKind, "manual">;
}

interface DocumentAnalysisTarget {
  readonly selection: ContextSelection;
  readonly analysisContext: AnalysisContext;
}

const EMPTY_ANALYSIS_CONTEXT = createWholeAvailableAnalysisContext("");

export class WritingAssistantController {
  readonly #coordinator: AnalysisCoordinator;
  readonly #revealWritingAssistant: RevealWritingAssistant;
  readonly #getAutomaticPresenter: GetWritingAssistant;
  readonly #debouncedAnalysis: DebouncedAnalysisScheduler<AutomaticAnalysisRequest>;
  readonly #analysisConfigurationSource: AnalysisConfigurationSource;
  readonly #contextSelector: ContextSelector;
  readonly #writingUnitSegmenter: WritingUnitSegmenter;
  readonly #unitAnalysisTriggerPolicy: UnitAnalysisTriggerPolicy;
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
    this.#contextSelector =
      options.contextSelector ?? new LocalBlockContextSelector();
    this.#writingUnitSegmenter =
      options.writingUnitSegmenter ?? new SimpleWritingUnitSegmenter();
    this.#unitAnalysisTriggerPolicy =
      options.unitAnalysisTriggerPolicy ??
      new SentenceUnitAnalysisTriggerPolicy();
    this.#unsubscribeAnalysisConfiguration =
      this.#analysisConfigurationSource.onDidChange(() => {
        this.#handleAnalysisConfigurationChange();
      });
    this.#debouncedAnalysis = new DebouncedAnalysisScheduler(
      (request) => {
        void this.#analyzeSource(
          request.source,
          false,
          request.kind,
        ).catch(() => {
          // Automatic host failures remain quiet; analysis failures are rendered.
        });
      },
      options.debounceMs,
    );
  }

  scheduleAutomaticAnalysis(observed: ObservedTextContext): void {
    if (this.#disposed) {
      return;
    }

    const source = this.#selectContext(observed);
    const activation = this.#activateSource(source);
    const state = activation.documentState;

    if (activation.documentChanged) {
      this.#debouncedAnalysis.cancel();
    }

    if (source.selection === null) {
      this.#debouncedAnalysis.cancel();
      this.#coordinator.cancelAnalysis(state.segment.id);
      state.unitAnalysis.cancel();
      state.documentRunNumber += 1;
      resetPresentationState(state);
      this.#queuePresentation(state);
      return;
    }

    const currentUnit =
      state.currentUnitId === null
        ? null
        : state.unitAnalysis.getRecord(state.currentUnitId)?.unit ?? null;
    const currentFingerprint =
      currentUnit === null ? null : createUnitSourceFingerprint(currentUnit);
    const trigger = this.#unitAnalysisTriggerPolicy.decide({
      unit: currentUnit,
      automaticAnalysisNeeded: activation.shouldAutomaticallyAnalyze,
      sourceChanged: activation.sourceChanged,
      explicitSelection: source.explicitSelection,
      compositionBlocked: source.compositionBlocked,
      triggeredCompletionFingerprints:
        state.immediateCompletionFingerprints,
    });

    if (trigger !== "none") {
      resetPresentationState(state);
      const request: AutomaticAnalysisRequest = {
        source,
        kind: trigger === "immediate" ? "completion" : "debounced",
      };
      if (trigger === "immediate") {
        state.immediateCompletionFingerprints.add(currentFingerprint!);
        this.#debouncedAnalysis.scheduleImmediate(request);
      } else {
        this.#debouncedAnalysis.schedule(request);
      }
    }

    this.#queuePresentation(state);
  }

  async analyze(
    observed: ObservedTextContext,
  ): Promise<AnalysisOutcome | undefined> {
    return this.#analyzeSource(this.#selectContext(observed), true, "manual");
  }

  presentActive(presenter: WritingAssistantPresenter): void {
    if (this.#activeDocumentKey === undefined) {
      return;
    }

    const state = this.#documents.get(this.#activeDocumentKey);
    if (state !== undefined) {
      presenter.present(this.#viewModelFor(state));
    }
  }

  async #analyzeSource(
    source: SelectedDocumentSource,
    revealView: boolean,
    requestKind: UnitAnalysisRequestKind,
  ): Promise<AnalysisOutcome | undefined> {
    if (this.#disposed) {
      return undefined;
    }

    this.#debouncedAnalysis.cancel();
    const state = this.#activateSource(source).documentState;
    const documentRunNumber = ++state.documentRunNumber;

    this.#coordinator.cancelAnalysis(state.segment.id);

    if (
      source.selection === null ||
      (!state.explicitSelection && state.currentUnitId === null)
    ) {
      resetPresentationState(state);
      const presenter = await this.#getPresenter(revealView);
      if (
        presenter !== undefined &&
        this.#isCurrentDocumentRun(state, documentRunNumber)
      ) {
        presenter.present(this.#viewModelFor(state));
      }
      return undefined;
    }

    state.status = "Analyzing";
    state.statusDetail = undefined;
    state.visibleTrackIds = Object.freeze([]);

    const configuration = this.#analysisConfigurationSource.getConfiguration();
    state.configuration = configuration;
    const requestedUnitId = state.currentUnitId;
    const outcomePromise = state.explicitSelection
      ? this.#coordinator.analyze(
          state.segment,
          configuration,
          state.analysisTarget?.analysisContext ?? EMPTY_ANALYSIS_CONTEXT,
        )
      : state.unitAnalysis.analyze(
          requestedUnitId!,
          configuration,
          requestKind,
        );
    const presenter = await this.#getPresenter(revealView);
    if (this.#isCurrentDocumentRun(state, documentRunNumber)) {
      presenter?.present(this.#viewModelFor(state));
    }

    const outcome = await outcomePromise;

    if (state.documentRunNumber !== documentRunNumber || this.#disposed) {
      if (
        !this.#disposed &&
        outcome.status === "applied" &&
        this.#activeDocumentKey === state.documentKey &&
        !state.explicitSelection
      ) {
        // A still-current background unit may have completed after the cursor
        // advanced. Refresh the bounded recent-assistance snapshot without
        // changing the active unit's status or source.
        this.#queuePresentation(state);
      }
      return outcome;
    }

    state.status = isConfigurationRequired(outcome)
      ? "Configuration required"
      : statusForOutcome(outcome);
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
      presenter.present(this.#viewModelFor(state));
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
      state.unitAnalysis.cancel();
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
      state.configuration = configuration;
      state.unitAnalysis.updateConfiguration(configuration);
      this.#coordinator.cancelAnalysis(state.segment.id);
      state.documentRunNumber += 1;
      resetPresentationState(state);
      if (state.documentKey === this.#activeDocumentKey) {
        this.#queuePresentation(state);
        if (state.selectedSource.selection !== null) {
          this.#debouncedAnalysis.schedule({
            source: state.selectedSource,
            kind: "debounced",
          });
        }
      }
    }
  }

  #activateSource(source: SelectedDocumentSource): SourceActivation {
    const previousState =
      this.#activeDocumentKey === undefined
        ? undefined
        : this.#documents.get(this.#activeDocumentKey);
    const documentChanged = this.#activeDocumentKey !== source.documentKey;

    let state = this.#documents.get(source.documentKey);
    const documentCreated = state === undefined;
    const sourceText = source.selection?.activeText ?? "";
    const analysisTarget = createDocumentAnalysisTarget(source.selection);
    const configuration = this.#analysisConfigurationSource.getConfiguration();

    if (state === undefined) {
      state = {
        documentKey: source.documentKey,
        segment: this.#createSegment(sourceText),
        unitAnalysis: new IncrementalUnitAnalysisCoordinator(this.#coordinator),
        units: Object.freeze([]),
        currentUnitId: null,
        explicitSelection: source.explicitSelection,
        selectedSource: source,
        configuration,
        analysisTarget,
        documentRunNumber: 0,
        visibleTrackIds: Object.freeze([]),
        status: "Idle",
        immediateCompletionFingerprints: new Set(),
      };
      this.#documents.set(source.documentKey, state);
      this.#coordinator.updateAnalysisContext(
        state.segment.id,
        analysisTarget?.analysisContext ?? EMPTY_ANALYSIS_CONTEXT,
      );
    }

    if (documentChanged && previousState !== undefined) {
      previousState.documentRunNumber += 1;
      this.#coordinator.cancelAnalysis(previousState.segment.id);
      previousState.unitAnalysis.cancel();
      if (previousState.status === "Analyzing") {
        previousState.status = "Aborted";
        previousState.statusDetail = undefined;
        previousState.visibleTrackIds = Object.freeze([]);
      }
    }

    const sourceChanged = state.segment.sourceText !== sourceText;
    const sourceLocationChanged = !sameSourceRange(
      state.analysisTarget?.selection.sourceRange,
      analysisTarget?.selection.sourceRange,
    );
    const targetChanged =
      state.analysisTarget?.analysisContext.contextFingerprint !==
      analysisTarget?.analysisContext.contextFingerprint;
    const selectionModeChanged =
      state.explicitSelection !== source.explicitSelection;
    if (sourceLocationChanged || selectionModeChanged) {
      state.immediateCompletionFingerprints.clear();
    }
    if (sourceChanged || targetChanged || selectionModeChanged) {
      state.documentRunNumber += 1;
      this.#coordinator.cancelAnalysis(state.segment.id);
      if (sourceLocationChanged && !sourceChanged) {
        this.#coordinator.updateAnalysisContext(
          state.segment.id,
          analysisTarget?.analysisContext ?? EMPTY_ANALYSIS_CONTEXT,
        );
        state.segment = this.#createSegment(sourceText);
      } else if (sourceChanged) {
        state.segment.updateSourceText(sourceText);
      }
      state.analysisTarget = analysisTarget;
      this.#coordinator.updateAnalysisContext(
        state.segment.id,
        analysisTarget?.analysisContext ?? EMPTY_ANALYSIS_CONTEXT,
      );
      resetPresentationState(state);
    }

    state.explicitSelection = source.explicitSelection;
    state.selectedSource = source;
    state.configuration = configuration;
    const currentUnitChanged = this.#synchronizeUnitAnalysis(state, source);
    const activeUnitNeedsAnalysis =
      !state.explicitSelection &&
      state.currentUnitId !== null &&
      state.unitAnalysis.getCurrentResult(
        state.currentUnitId,
        configuration,
      ) === null;

    if (currentUnitChanged) {
      state.documentRunNumber += 1;
      if (
        !state.explicitSelection &&
        state.currentUnitId !== null &&
        !activeUnitNeedsAnalysis
      ) {
        state.status = "Applied";
        state.statusDetail = undefined;
        state.visibleTrackIds = Object.freeze([]);
      } else {
        resetPresentationState(state);
      }
    }

    this.#activeDocumentKey = source.documentKey;

    return {
      documentState: state,
      documentChanged,
      sourceChanged: documentCreated || sourceChanged,
      shouldAutomaticallyAnalyze:
        source.selection !== null &&
        (documentCreated ||
          sourceChanged ||
          targetChanged ||
          selectionModeChanged ||
          (currentUnitChanged && activeUnitNeedsAnalysis) ||
          (documentChanged && state.status !== "Applied")),
    };
  }

  #selectContext(observed: ObservedTextContext): SelectedDocumentSource {
    const selection = this.#contextSelector.select(observed.textContext);
    if (selection !== null) {
      assertContextSelectionMapsToText(observed.textContext, selection);
    }
    return Object.freeze({
      documentKey: observed.documentKey,
      selection,
      explicitSelection:
        selection !== null && observed.textContext.selection !== null,
      cursorOffset: observed.textContext.cursorOffset,
      compositionBlocked:
        selection === null && observed.textContext.composition !== null,
    });
  }

  #createSegment(sourceText: string): WritingSegment {
    const segmentNumber = ++this.#nextSegmentNumber;
    return WritingSegment.create({
      id: asSegmentId(`obsidian-segment-${segmentNumber}`),
      sourceTrackId: asTrackId(`obsidian-source-${segmentNumber}`),
      sourceText,
    });
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

    presenter.present(this.#viewModelFor(state));
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

  #synchronizeUnitAnalysis(
    state: DocumentState,
    source: SelectedDocumentSource,
  ): boolean {
    const previousCurrentUnitId = state.currentUnitId;
    if (source.selection === null || source.explicitSelection) {
      state.unitAnalysis.clear();
      state.units = Object.freeze([]);
      state.currentUnitId = null;
      state.immediateCompletionFingerprints.clear();
      return previousCurrentUnitId !== null;
    }

    const units = this.#writingUnitSegmenter.segment(
      source.selection.activeText,
    );
    state.unitAnalysis.synchronize(source.selection, units);
    state.unitAnalysis.updateConfiguration(state.configuration);
    state.units = units;
    const currentFingerprints = new Set(
      units.map((unit) => createUnitSourceFingerprint(unit)),
    );
    for (const fingerprint of state.immediateCompletionFingerprints) {
      if (!currentFingerprints.has(fingerprint)) {
        state.immediateCompletionFingerprints.delete(fingerprint);
      }
    }

    const cursorRelativeOffset = Math.min(
      Math.max(
        source.cursorOffset - source.selection.sourceRange.start,
        0,
      ),
      source.selection.activeText.length,
    );
    state.currentUnitId =
      selectCurrentWritingUnit(units, cursorRelativeOffset)?.id ?? null;
    return state.currentUnitId !== previousCurrentUnitId;
  }

  #viewModelFor(state: DocumentState): WritingAssistantViewModel {
    if (!state.explicitSelection && state.currentUnitId !== null) {
      const presentation = createUnitAssistancePresentationModel(
        state.unitAnalysis,
        state.currentUnitId,
        state.configuration,
      );
      if (presentation.active !== null) {
        return createIncrementalViewModel(
          presentation,
          state.status,
          state.statusDetail,
        );
      }
    }

    return createViewModel(
      state.segment,
      state.status,
      state.visibleTrackIds,
      state.statusDetail,
    );
  }
}

function createDocumentAnalysisTarget(
  selection: ContextSelection | null,
): DocumentAnalysisTarget | null {
  return selection === null
    ? null
    : Object.freeze({
        selection,
        analysisContext: createAnalysisContext(selection),
      });
}

function sameSourceRange(
  left: ContextSelection["sourceRange"] | undefined,
  right: ContextSelection["sourceRange"] | undefined,
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.start === right.start &&
      left.end === right.end)
  );
}

function resetPresentationState(state: DocumentState): void {
  state.status = "Idle";
  state.statusDetail = undefined;
  state.visibleTrackIds = Object.freeze([]);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "Analysis failed.";
}

function isConfigurationRequired(outcome: AnalysisOutcome): boolean {
  return (
    outcome.status === "failed" &&
    typeof outcome.error === "object" &&
    outcome.error !== null &&
    "code" in outcome.error &&
    outcome.error.code === "invalid-profile"
  );
}
