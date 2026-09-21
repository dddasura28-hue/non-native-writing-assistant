import {
  AnalysisCoordinator,
  IncrementalUnitAnalysisCoordinator,
  LocalBlockContextSelector,
  SentenceUnitAnalysisTriggerPolicy,
  SimpleWritingUnitSegmenter,
  createAnalysisContext,
  createUnitAssistancePresentationModel,
  createUnitSourceFingerprint,
  findCurrentConfirmedNativeIntent,
  selectCurrentWritingUnit,
  type AnalysisConfiguration,
  type AnalysisOutcome,
  type AnalysisProvider,
  type ContextSelection,
  type TextContext,
  type UnitAnalysisRequestKind,
  type UnitAssistancePresentation,
  type UnitSourceFingerprint,
  type WritingUnit,
} from "@non-native-writing/application";
import {
  NATIVE_INTENT_TRACK_TYPE_ID,
  NORMALIZED_TRACK_TYPE_ID,
  WritingSegment,
  asSegmentId,
  asTrackId,
  type SegmentId,
  type TrackId,
} from "@non-native-writing/core";
import { WritingModelError } from "@non-native-writing/model-integration";

import {
  StaticDesktopAnalysisConfigurationSource,
  type DesktopAnalysisConfigurationSource,
} from "../provider/desktop-analysis-configuration-source.js";

export const DESKTOP_ANALYSIS_DEBOUNCE_MS = 700;

export const DESKTOP_ANALYSIS_CONFIGURATION: AnalysisConfiguration =
  Object.freeze({
    assistPolicyFingerprint: "desktop-assist-v1",
    styleProfileFingerprint: "desktop-style-v1",
    languageConfigurationFingerprint: "desktop-languages-zh-CN-en-v1",
    processorConfigurationFingerprint: "desktop-writing-analysis-v1",
    targetLanguageId: "en",
    nativeLanguageId: "zh-CN",
  });

export const DESKTOP_DEVELOPMENT_CONFIGURATION =
  DESKTOP_ANALYSIS_CONFIGURATION;

export type DesktopAnalysisStatus =
  | "idle"
  | "analyzing"
  | "completed"
  | "failed";

export interface DesktopAssistanceTrack {
  readonly id: TrackId;
  readonly text: string;
  readonly label?: string;
  readonly order?: number;
}

export interface DesktopNativeIntentTarget {
  readonly kind: "unit" | "selection";
  readonly segmentId: SegmentId;
  readonly unitId?: string;
  readonly sourceRevision: number;
  readonly trackId: TrackId;
  readonly trackRevision: number;
}

export interface DesktopNativeIntentPresentation {
  readonly text: string;
  readonly state: "inferred" | "confirmed";
  readonly target: DesktopNativeIntentTarget;
}

export type DesktopNativeIntentConfirmationResult = "confirmed" | "obsolete";

export interface DesktopAssistanceItem {
  readonly sourceText: string;
  readonly status: DesktopAnalysisStatus;
  readonly statusMessage: string;
  readonly nativeIntent: DesktopNativeIntentPresentation | null;
  readonly nativeIntentTracks: readonly DesktopAssistanceTrack[];
  readonly normalizedTracks: readonly DesktopAssistanceTrack[];
}

export interface DesktopAssistancePresentation {
  readonly active: DesktopAssistanceItem | null;
  readonly recent: readonly DesktopAssistanceItem[];
}

export interface DesktopEngineControllerOptions {
  readonly debounceMs?: number;
  readonly configuration?: AnalysisConfiguration;
  readonly configurationSource?: DesktopAnalysisConfigurationSource;
}

export type PresentDesktopAssistance = (
  presentation: DesktopAssistancePresentation,
) => void;

const EMPTY_TRACK_IDS: readonly TrackId[] = Object.freeze([]);
export const EMPTY_DESKTOP_ASSISTANCE: DesktopAssistancePresentation =
  Object.freeze({ active: null, recent: Object.freeze([]) });

/** Desktop host composition for the shared context and analysis pipeline. */
export class DesktopEngineController {
  readonly #analysisCoordinator: AnalysisCoordinator;
  readonly #unitAnalysis: IncrementalUnitAnalysisCoordinator;
  readonly #selector = new LocalBlockContextSelector();
  readonly #segmenter = new SimpleWritingUnitSegmenter();
  readonly #triggerPolicy = new SentenceUnitAnalysisTriggerPolicy();
  readonly #present: PresentDesktopAssistance;
  readonly #configurationSource: DesktopAnalysisConfigurationSource;
  readonly #unsubscribeConfiguration: () => void;
  readonly #debounceMs: number;
  readonly #triggeredCompletionFingerprints = new Set<UnitSourceFingerprint>();

  #activeUnitId: string | null = null;
  #selection: ContextSelection | null = null;
  #explicitSelection = false;
  #directSegment: WritingSegment | null = null;
  #directSourceRangeKey: string | null = null;
  #directContextFingerprint: string | null = null;
  #directVisibleTrackIds: readonly TrackId[] = EMPTY_TRACK_IDS;
  #directStatus: DesktopAnalysisStatus = "idle";
  #directStatusMessage: string | undefined;
  readonly #unitFailureMessages = new Map<string, string>();
  #timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  #nextSegmentNumber = 0;
  #directRunNumber = 0;
  #compositionBlocked = false;
  #configurationChanged = false;
  #lastContext: TextContext | null = null;
  #configuration: AnalysisConfiguration;
  #disposed = false;

  constructor(
    provider: AnalysisProvider,
    present: PresentDesktopAssistance,
    options: DesktopEngineControllerOptions = {},
  ) {
    this.#analysisCoordinator = new AnalysisCoordinator(provider);
    this.#unitAnalysis = new IncrementalUnitAnalysisCoordinator(
      this.#analysisCoordinator,
    );
    this.#present = present;
    this.#configurationSource =
      options.configurationSource ??
      new StaticDesktopAnalysisConfigurationSource(
        options.configuration ?? DESKTOP_ANALYSIS_CONFIGURATION,
      );
    this.#configuration = this.#configurationSource.getConfiguration();
    this.#unsubscribeConfiguration = this.#configurationSource.onDidChange(
      () => this.#handleConfigurationChange(),
    );
    this.#debounceMs = options.debounceMs ?? DESKTOP_ANALYSIS_DEBOUNCE_MS;
  }

  observe(context: TextContext): void {
    if (this.#disposed) {
      return;
    }
    this.#lastContext = context;

    if (context.composition !== null) {
      this.#compositionBlocked = true;
      this.#cancelTimer();
      this.#unitAnalysis.cancel();
      this.#cancelDirectAnalysis();
      this.#present(EMPTY_DESKTOP_ASSISTANCE);
      return;
    }

    this.#compositionBlocked = false;

    const selection = this.#selector.select(context);
    const explicitSelection =
      selection !== null && context.selection !== null;
    const previousSelection = this.#selection;
    const previousExplicitSelection = this.#explicitSelection;
    const previousActiveUnitId = this.#activeUnitId;
    this.#selection = selection;
    this.#explicitSelection = explicitSelection;

    if (selection === null || !/\S/u.test(selection.activeText)) {
      this.#configurationChanged = false;
      this.#clearAnalysis();
      this.#present(EMPTY_DESKTOP_ASSISTANCE);
      return;
    }

    if (explicitSelection) {
      const configurationChanged = this.#configurationChanged;
      this.#configurationChanged = false;
      const dependencyChanged = this.#activateExplicitSelection(selection);
      this.#presentDirect();
      if (
        (configurationChanged || dependencyChanged) &&
        this.#directSegment !== null &&
        findCurrentConfirmedNativeIntent(this.#directSegment) !== undefined
      ) {
        this.#directStatus = "analyzing";
        this.#presentDirect();
        this.#startDirectAnalysis();
      }
      return;
    }

    this.#cancelTimer();
    this.#cancelDirectAnalysis();
    this.#directStatus = "idle";
    this.#directVisibleTrackIds = EMPTY_TRACK_IDS;
    const units = this.#segmenter.segment(selection.activeText);
    this.#unitAnalysis.synchronize(selection, units);
    this.#unitAnalysis.updateConfiguration(this.#configuration);
    this.#retainCurrentCompletionFingerprints(units);

    const relativeCursorOffset = Math.min(
      Math.max(context.cursorOffset - selection.sourceRange.start, 0),
      selection.activeText.length,
    );
    const activeUnit = selectCurrentWritingUnit(units, relativeCursorOffset);
    this.#activeUnitId = activeUnit?.id ?? null;

    const sourceChanged =
      previousSelection === null ||
      previousSelection.activeText !== selection.activeText;
    const contextChanged =
      previousSelection !== null &&
      (previousSelection.beforeContext !== selection.beforeContext ||
        previousSelection.afterContext !== selection.afterContext ||
        previousSelection.sourceRange.start !== selection.sourceRange.start ||
        previousSelection.sourceRange.end !== selection.sourceRange.end);
    const currentResult =
      this.#activeUnitId === null
        ? null
        : this.#unitAnalysis.getCurrentResult(
            this.#activeUnitId,
            this.#configuration,
          );
    const activeUnitChanged = previousActiveUnitId !== this.#activeUnitId;
    const automaticAnalysisNeeded =
      activeUnit !== null &&
      currentResult === null &&
      (sourceChanged ||
        contextChanged ||
        this.#configurationChanged ||
        previousExplicitSelection ||
        activeUnitChanged);
    const trigger = this.#triggerPolicy.decide({
      unit: activeUnit,
      automaticAnalysisNeeded,
      sourceChanged,
      explicitSelection: false,
      compositionBlocked: false,
      triggeredCompletionFingerprints: this.#triggeredCompletionFingerprints,
    });
    this.#configurationChanged = false;

    this.#presentIncremental();
    if (activeUnit === null || trigger === "none") {
      return;
    }

    if (trigger === "immediate") {
      this.#triggeredCompletionFingerprints.add(
        createUnitSourceFingerprint(activeUnit),
      );
      this.#startUnitAnalysis(activeUnit.id, "completion");
      return;
    }

    this.#timer = globalThis.setTimeout(() => {
      this.#timer = undefined;
      this.#startUnitAnalysis(activeUnit.id, "debounced");
    }, this.#debounceMs);
  }

  async analyze(context: TextContext): Promise<AnalysisOutcome | undefined> {
    if (this.#disposed || context.composition !== null) {
      return undefined;
    }

    this.observe(context);
    this.#cancelTimer();
    if (this.#selection === null) {
      return undefined;
    }

    if (!this.#explicitSelection) {
      if (this.#activeUnitId === null) {
        return undefined;
      }
      return this.#analyzeUnit(this.#activeUnitId, "manual");
    }

    const selection = this.#selection;
    this.#activateExplicitSelection(selection);
    const segment = this.#directSegment!;
    const runNumber = ++this.#directRunNumber;
    this.#directStatus = "analyzing";
    this.#directStatusMessage = undefined;
    this.#directVisibleTrackIds = EMPTY_TRACK_IDS;
    this.#presentDirect();
    const outcome = await this.#analysisCoordinator.analyze(
      segment,
      this.#configuration,
      createAnalysisContext(selection),
    );
    if (this.#disposed || runNumber !== this.#directRunNumber) {
      return outcome;
    }
    this.#directStatus =
      outcome.status === "applied"
        ? "completed"
        : outcome.status === "failed"
          ? "failed"
          : "idle";
    this.#directStatusMessage =
      outcome.status === "failed" ? safeFailureMessage(outcome.error) : undefined;
    this.#directVisibleTrackIds =
      outcome.status === "applied" ? outcome.appliedTrackIds : EMPTY_TRACK_IDS;
    this.#presentDirect();
    return outcome;
  }

  confirmNativeIntent(
    target: DesktopNativeIntentTarget,
    text: string,
  ): DesktopNativeIntentConfirmationResult {
    if (this.#disposed) {
      return "obsolete";
    }

    this.#cancelTimer();
    if (target.kind === "unit") {
      if (
        this.#explicitSelection ||
        target.unitId === undefined ||
        this.#activeUnitId !== target.unitId
      ) {
        return "obsolete";
      }
      const confirmed = this.#unitAnalysis.confirmNativeIntent(
        target.unitId,
        target.segmentId,
        target.trackId,
        text,
        target.sourceRevision,
        target.trackRevision,
      );
      if (confirmed === null) {
        return "obsolete";
      }

      this.#presentIncremental();
      this.#startUnitAnalysis(target.unitId, "manual");
      return "confirmed";
    }

    if (
      !this.#explicitSelection ||
      this.#directSegment === null ||
      this.#directSegment.id !== target.segmentId
    ) {
      return "obsolete";
    }
    const confirmed = this.#directSegment.confirmNativeIntent(
      target.trackId,
      text,
      target.sourceRevision,
      target.trackRevision,
    );
    if (confirmed === null) {
      return "obsolete";
    }

    this.#cancelDirectAnalysis();
    this.#directVisibleTrackIds = EMPTY_TRACK_IDS;
    this.#directStatus = "analyzing";
    this.#directStatusMessage = undefined;
    this.#presentDirect();
    this.#startDirectAnalysis();
    return "confirmed";
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#unsubscribeConfiguration();
    this.#cancelTimer();
    this.#unitAnalysis.clear();
    this.#cancelDirectAnalysis();
  }

  #activateExplicitSelection(selection: ContextSelection): boolean {
    this.#cancelTimer();
    this.#unitAnalysis.clear();
    this.#activeUnitId = null;
    this.#triggeredCompletionFingerprints.clear();

    const analysisContext = createAnalysisContext(selection);
    const sourceRangeKey = `${selection.sourceRange.start}:${selection.sourceRange.end}`;
    const targetChanged =
      this.#directSourceRangeKey !== null &&
      this.#directSourceRangeKey !== sourceRangeKey;
    const contextChanged =
      this.#directContextFingerprint !== null &&
      this.#directContextFingerprint !== analysisContext.contextFingerprint;
    if (this.#directSegment === null || targetChanged) {
      this.#cancelDirectAnalysis();
      this.#directSegment = this.#createSegment(selection.activeText);
    } else if (this.#directSegment.sourceText !== selection.activeText) {
      this.#cancelDirectAnalysis();
      this.#directSegment.updateSourceText(selection.activeText);
      this.#directVisibleTrackIds = EMPTY_TRACK_IDS;
      this.#directStatus = "idle";
      this.#directStatusMessage = undefined;
    }
    this.#directSourceRangeKey = sourceRangeKey;
    if (contextChanged) {
      this.#directVisibleTrackIds = EMPTY_TRACK_IDS;
      this.#directStatus = "idle";
      this.#directStatusMessage = undefined;
    }
    this.#directContextFingerprint = analysisContext.contextFingerprint;
    this.#analysisCoordinator.updateAnalysisContext(
      this.#directSegment.id,
      analysisContext,
    );
    this.#analysisCoordinator.updateConfiguration(
      this.#directSegment.id,
      this.#configuration,
    );
    return contextChanged;
  }

  #startUnitAnalysis(unitId: string, kind: UnitAnalysisRequestKind): void {
    void this.#analyzeUnit(unitId, kind);
  }

  #startDirectAnalysis(): void {
    const segment = this.#directSegment;
    const selection = this.#selection;
    if (segment === null || selection === null || !this.#explicitSelection) {
      return;
    }
    const runNumber = ++this.#directRunNumber;
    void this.#analysisCoordinator.analyze(
      segment,
      this.#configuration,
      createAnalysisContext(selection),
    ).then((outcome) => {
      if (this.#disposed || runNumber !== this.#directRunNumber) {
        return;
      }
      this.#directStatus =
        outcome.status === "applied"
          ? "completed"
          : outcome.status === "failed"
            ? "failed"
            : "idle";
      this.#directStatusMessage =
        outcome.status === "failed"
          ? safeFailureMessage(outcome.error)
          : undefined;
      this.#directVisibleTrackIds =
        outcome.status === "applied" ? outcome.appliedTrackIds : EMPTY_TRACK_IDS;
      this.#presentDirect();
    });
  }

  async #analyzeUnit(
    unitId: string,
    kind: UnitAnalysisRequestKind,
  ): Promise<AnalysisOutcome> {
    this.#unitFailureMessages.delete(unitId);
    const promise = this.#unitAnalysis.analyze(
      unitId,
      this.#configuration,
      kind,
    );
    this.#presentIncremental();
    const outcome = await promise;
    if (outcome.status === "failed") {
      this.#unitFailureMessages.set(unitId, safeFailureMessage(outcome.error));
    } else {
      this.#unitFailureMessages.delete(unitId);
    }
    if (!this.#disposed) {
      this.#presentIncremental();
    }
    return outcome;
  }

  #presentIncremental(): void {
    if (this.#disposed || this.#compositionBlocked) {
      return;
    }
    const model = createUnitAssistancePresentationModel(
      this.#unitAnalysis,
      this.#activeUnitId,
      this.#configuration,
    );
    this.#present(
      Object.freeze({
        active:
          model.active === null
            ? null
            : presentIncrementalItem(
                model.active,
                this.#unitFailureMessages.get(model.active.unitId),
              ),
        recent: Object.freeze(
          model.recent.map((item) => presentIncrementalItem(item)),
        ),
      }),
    );
  }

  #presentDirect(): void {
    if (this.#disposed || this.#directSegment === null) {
      return;
    }
    const visible = new Set(this.#directVisibleTrackIds);
    const tracks = this.#directSegment
      .listDerivedTracks()
      .filter((track) => visible.has(track.id))
      .filter(
        (track): track is typeof track & { payload: { readonly text: string } } =>
          typeof track.payload === "object" &&
          track.payload !== null &&
          "text" in track.payload &&
          typeof track.payload.text === "string",
      );
    const confirmedIntent = findCurrentConfirmedNativeIntent(this.#directSegment);
    const inferredIntent =
      tracks.find((track) => track.typeId === NATIVE_INTENT_TRACK_TYPE_ID) ??
      this.#directSegment
        .listDerivedTracks()
        .filter(
          (track): track is typeof track & { payload: { readonly text: string } } =>
            track.typeId === NATIVE_INTENT_TRACK_TYPE_ID &&
            track.provenance === "model" &&
            typeof track.payload === "object" &&
            track.payload !== null &&
            "text" in track.payload &&
            typeof track.payload.text === "string",
        )
        .at(-1);
    const semanticIntent = confirmedIntent ?? inferredIntent;
    const nativeIntent =
      semanticIntent === undefined
        ? null
        : Object.freeze({
            text: semanticIntent.payload.text,
            state: confirmedIntent === undefined
              ? "inferred" as const
              : "confirmed" as const,
            target: Object.freeze({
              kind: "selection" as const,
              segmentId: this.#directSegment.id,
              sourceRevision: this.#directSegment.sourceTrack.revision,
              trackId: semanticIntent.id,
              trackRevision: semanticIntent.revision,
            }),
          });
    this.#present(
      Object.freeze({
        active: Object.freeze({
          sourceText: this.#directSegment.sourceText,
          status: this.#directStatus,
          statusMessage:
            this.#directStatusMessage ?? statusMessage(this.#directStatus),
          nativeIntent,
          nativeIntentTracks:
            nativeIntent === null
              ? Object.freeze([])
              : Object.freeze([Object.freeze({
                  id: nativeIntent.target.trackId,
                  text: nativeIntent.text,
                })]),
          normalizedTracks: Object.freeze(
            tracks
              .filter((track) => track.typeId === NORMALIZED_TRACK_TYPE_ID)
              .map(presentDerivedTrack),
          ),
        }),
        recent: Object.freeze([]),
      }),
    );
  }

  #clearAnalysis(): void {
    this.#cancelTimer();
    this.#unitAnalysis.clear();
    this.#activeUnitId = null;
    this.#triggeredCompletionFingerprints.clear();
    this.#cancelDirectAnalysis();
    this.#directStatus = "idle";
    this.#directStatusMessage = undefined;
    this.#directVisibleTrackIds = EMPTY_TRACK_IDS;
  }

  #cancelDirectAnalysis(): void {
    this.#directRunNumber += 1;
    if (this.#directSegment !== null) {
      this.#analysisCoordinator.cancelAnalysis(this.#directSegment.id);
    }
  }

  #cancelTimer(): void {
    if (this.#timer !== undefined) {
      globalThis.clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  #createSegment(sourceText: string): WritingSegment {
    const number = ++this.#nextSegmentNumber;
    return WritingSegment.create({
      id: asSegmentId(`desktop-explicit-segment-${number}`),
      sourceTrackId: asTrackId(`desktop-explicit-source-${number}`),
      sourceText,
    });
  }

  #handleConfigurationChange(): void {
    if (this.#disposed) {
      return;
    }
    this.#configuration = this.#configurationSource.getConfiguration();
    this.#configurationChanged = true;
    this.#cancelTimer();
    this.#triggeredCompletionFingerprints.clear();
    this.#unitFailureMessages.clear();
    this.#unitAnalysis.updateConfiguration(this.#configuration);
    this.#directVisibleTrackIds = EMPTY_TRACK_IDS;
    this.#directStatus = "idle";
    this.#directStatusMessage = undefined;
    this.#cancelDirectAnalysis();
    if (this.#lastContext !== null) {
      this.observe(this.#lastContext);
    }
  }

  #retainCurrentCompletionFingerprints(units: readonly WritingUnit[]): void {
    const current = new Set(
      units.map((unit) => createUnitSourceFingerprint(unit)),
    );
    for (const fingerprint of this.#triggeredCompletionFingerprints) {
      if (!current.has(fingerprint)) {
        this.#triggeredCompletionFingerprints.delete(fingerprint);
      }
    }
  }
}

function presentIncrementalItem(
  item: UnitAssistancePresentation,
  failureMessage?: string,
): DesktopAssistanceItem {
  const status: DesktopAnalysisStatus =
    item.status === "completed"
      ? "completed"
      : item.status === "analyzing"
        ? "analyzing"
        : item.status === "failed"
          ? "failed"
          : "idle";
  return Object.freeze({
    sourceText: item.sourceText,
    status,
    statusMessage: failureMessage ?? statusMessage(status),
    nativeIntent:
      item.nativeIntent === null
        ? null
        : Object.freeze({
            text: item.nativeIntent.text,
            state: item.nativeIntent.state,
            target: Object.freeze({
              kind: "unit" as const,
              unitId: item.unitId,
              segmentId: item.segmentId,
              sourceRevision: item.sourceRevision,
              trackId: item.nativeIntent.id,
              trackRevision: item.nativeIntent.revision,
            }),
          }),
    nativeIntentTracks: Object.freeze(
      item.nativeIntentTracks.map(presentTrack),
    ),
    normalizedTracks: Object.freeze(item.normalizedTracks.map(presentTrack)),
  });
}

function safeFailureMessage(error: unknown): string {
  if (error instanceof WritingModelError) {
    switch (error.code) {
      case "invalid-profile":
      case "unknown-provider":
        return "Configuration required";
      case "missing-secret":
        return "Credential required";
      case "authentication":
        return "Authentication failed";
      case "rate-limit":
        return "Provider rate limit reached";
      case "invalid-structured-output":
        return "The provider returned invalid structured output";
      case "network":
        return "Network request failed";
      case "provider-failure":
        return "Provider request failed";
      case "aborted":
        return "Waiting for current analysis";
    }
  }
  return "Analysis failed. Continue editing or try again.";
}

function presentTrack(track: DesktopAssistanceTrack): DesktopAssistanceTrack {
  return Object.freeze({ ...track });
}

function presentDerivedTrack(track: {
  readonly id: TrackId;
  readonly payload: { readonly text: string };
  readonly label?: string;
  readonly order?: number;
}): DesktopAssistanceTrack {
  return Object.freeze({
    id: track.id,
    text: track.payload.text,
    label: track.label,
    order: track.order,
  });
}

function statusMessage(status: DesktopAnalysisStatus): string {
  switch (status) {
    case "analyzing":
      return "Analyzing…";
    case "completed":
      return "Analysis ready";
    case "failed":
      return "Analysis failed. Continue editing or try again.";
    default:
      return "Waiting for a complete thought";
  }
}
