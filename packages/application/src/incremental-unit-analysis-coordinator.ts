import {
  NATIVE_INTENT_TRACK_TYPE_ID,
  NORMALIZED_TRACK_TYPE_ID,
  WritingSegment,
  asSegmentId,
  asTrackId,
  dependencyStampMatches,
  type DependencyStamp,
  type DerivedTrack,
  type NativeIntentTrack,
  type SegmentId,
  type TrackId,
} from "@non-native-writing/core";

import {
  copyAnalysisConfiguration,
  type AnalysisConfiguration,
} from "./analysis-configuration.js";
import type { AnalysisContext } from "./analysis-context.js";
import {
  AnalysisCoordinator,
  type AnalysisOutcome,
} from "./analysis-coordinator.js";
import { captureAnalysisSnapshot } from "./analysis-snapshot.js";
import type { ContextSelection } from "./context-selector.js";
import { UnitAnalysisManager } from "./unit-analysis-manager.js";
import {
  createUnitAnalysisResult,
  type UnitAnalysisResult,
} from "./unit-analysis-result.js";
import {
  createIdleUnitAnalysisState,
  isUnitAnalysisStateCurrent,
  markUnitAnalysisAnalyzing,
  markUnitAnalysisCompleted,
  markUnitAnalysisFailed,
  markUnitAnalysisStale,
  restoreUnitAnalysisCompleted,
  type UnitAnalysisState,
} from "./unit-analysis-state.js";
import {
  createUnitSourceFingerprint,
  type UnitSourceFingerprint,
} from "./unit-source-fingerprint.js";
import type { WritingUnit } from "./writing-unit.js";
import { createWritingUnitAnalysisContext } from "./writing-unit-context.js";

export interface UnitAnalysisRecord {
  readonly unit: WritingUnit;
  readonly segment: WritingSegment;
  readonly state: UnitAnalysisState;
}

interface RuntimeUnitRecord {
  readonly unit: WritingUnit;
  readonly segment: WritingSegment;
  readonly analysisContext: AnalysisContext;
  resultTrackIds: readonly TrackId[];
}

export const UNIT_ANALYSIS_REQUEST_KINDS = Object.freeze([
  "debounced",
  "completion",
  "manual",
] as const);

export type UnitAnalysisRequestKind =
  (typeof UNIT_ANALYSIS_REQUEST_KINDS)[number];

interface QueuedUnitAnalysis {
  readonly unitId: string;
  readonly sourceFingerprint: UnitSourceFingerprint;
  readonly dependencyStamp: DependencyStamp;
  readonly configuration: AnalysisConfiguration;
  kind: UnitAnalysisRequestKind;
  readonly promise: Promise<AnalysisOutcome>;
  readonly resolve: (outcome: AnalysisOutcome) => void;
}

interface ActiveUnitAnalysis extends QueuedUnitAnalysis {
  readonly segmentId: SegmentId;
  readonly analyzingState: UnitAnalysisState;
  supersededAs?: "stale" | "aborted";
}

let nextIncrementalCoordinatorNumber = 0;

const EMPTY_TRACK_IDS: readonly TrackId[] = Object.freeze([]);
const STALE_OUTCOME = Object.freeze({ status: "stale" as const });
const ABORTED_OUTCOME = Object.freeze({ status: "aborted" as const });

/**
 * Active-unit application orchestration above the single-segment
 * AnalysisCoordinator. It never calls a model/provider port directly.
 */
export class IncrementalUnitAnalysisCoordinator {
  readonly #analysisCoordinator: AnalysisCoordinator;
  readonly #manager: UnitAnalysisManager;
  readonly #coordinatorNumber = ++nextIncrementalCoordinatorNumber;
  #records = new Map<string, RuntimeUnitRecord>();
  #nextSegmentNumber = 0;
  #configuration: AnalysisConfiguration | undefined;
  #activeAnalysis: ActiveUnitAnalysis | undefined;
  #pendingManual: QueuedUnitAnalysis | undefined;
  #pendingCompletions = new Map<string, QueuedUnitAnalysis>();
  #pendingDebounced: QueuedUnitAnalysis | undefined;

  constructor(
    analysisCoordinator: AnalysisCoordinator,
    manager = new UnitAnalysisManager(),
  ) {
    this.#analysisCoordinator = analysisCoordinator;
    this.#manager = manager;
  }

  synchronize(
    selection: ContextSelection,
    units: readonly WritingUnit[],
  ): void {
    assertUnitsMapToSelection(selection, units);

    const previousRecords = this.#records;
    this.#manager.synchronize(units);

    const synchronized = new Map<string, RuntimeUnitRecord>();
    for (const unit of units) {
      const previous = previousRecords.get(unit.id);
      const sourceUnchanged =
        previous !== undefined &&
        createUnitSourceFingerprint(previous.unit) ===
          createUnitSourceFingerprint(unit);
      const record: RuntimeUnitRecord = sourceUnchanged
        ? {
            unit,
            segment: previous.segment,
            analysisContext: createWritingUnitAnalysisContext(selection, unit),
            resultTrackIds: previous.resultTrackIds,
          }
        : {
            unit,
            segment: this.#createSegment(unit.text),
            analysisContext: createWritingUnitAnalysisContext(selection, unit),
            resultTrackIds: EMPTY_TRACK_IDS,
          };

      if (previous !== undefined && !sourceUnchanged) {
        this.#analysisCoordinator.cancelAnalysis(previous.segment.id);
      }
      this.#analysisCoordinator.updateAnalysisContext(
        record.segment.id,
        record.analysisContext,
      );
      if (this.#configuration !== undefined) {
        this.#analysisCoordinator.updateConfiguration(
          record.segment.id,
          this.#configuration,
        );
      }
      synchronized.set(unit.id, record);
    }

    for (const [unitId, previous] of previousRecords) {
      if (!synchronized.has(unitId)) {
        this.#analysisCoordinator.cancelAnalysis(previous.segment.id);
      }
    }

    this.#records = synchronized;
    this.#discardObsoletePending();
    this.#cancelActiveIfObsolete();
    this.#reconcileDependencyStates();
  }

  clear(): void {
    this.#supersedeActiveAnalysis("stale");
    this.#cancelPending("stale");
    for (const record of this.#records.values()) {
      this.#analysisCoordinator.cancelAnalysis(record.segment.id);
    }
    this.#manager.synchronize([]);
    this.#records = new Map();
  }

  cancel(): void {
    this.#supersedeActiveAnalysis("aborted");
    this.#cancelPending("aborted");
  }

  updateConfiguration(configuration: AnalysisConfiguration): void {
    const copied = copyAnalysisConfiguration(configuration);
    const changed =
      this.#configuration !== undefined &&
      configurationIdentity(this.#configuration) !==
        configurationIdentity(copied);

    this.#configuration = copied;
    for (const record of this.#records.values()) {
      this.#analysisCoordinator.updateConfiguration(record.segment.id, copied);
    }
    if (changed) {
      this.#supersedeActiveAnalysis("stale");
      this.#cancelPending("stale");
    }
    this.#reconcileDependencyStates();
  }

  getRecord(unitId: string): UnitAnalysisRecord | null {
    const record = this.#records.get(unitId);
    const state = this.#manager.getState(unitId);
    return record === undefined || state === null
      ? null
      : Object.freeze({ unit: record.unit, segment: record.segment, state });
  }

  listRecords(): readonly UnitAnalysisRecord[] {
    return Object.freeze(
      [...this.#records.values()]
        .sort((left, right) => left.unit.order - right.unit.order)
        .map((record) => this.getRecord(record.unit.id)!),
    );
  }

  getCurrentResult(
    unitId: string,
    configuration: AnalysisConfiguration,
  ): UnitAnalysisResult | null {
    const record = this.#records.get(unitId);
    const state = this.#manager.getState(unitId);
    if (record === undefined || state === null || state.result === null) {
      return null;
    }

    const currentStamp = captureAnalysisSnapshot(
      record.segment,
      configuration,
      record.analysisContext,
    ).dependencyStamp;
    return isUnitAnalysisStateCurrent(state, record.unit, currentStamp)
      ? state.result
      : null;
  }

  getCurrentTrackIds(
    unitId: string,
    configuration: AnalysisConfiguration,
  ): readonly TrackId[] {
    return this.getCurrentResult(unitId, configuration) === null
      ? EMPTY_TRACK_IDS
      : this.#records.get(unitId)?.resultTrackIds ?? EMPTY_TRACK_IDS;
  }

  confirmNativeIntent(
    unitId: string,
    segmentId: SegmentId,
    trackId: TrackId,
    text: string,
    expectedSourceRevision: number,
    expectedTrackRevision: number,
  ): NativeIntentTrack | null {
    const record = this.#records.get(unitId);
    if (record === undefined || record.segment.id !== segmentId) {
      return null;
    }

    const confirmed = record.segment.confirmNativeIntent(
      trackId,
      text,
      expectedSourceRevision,
      expectedTrackRevision,
    );
    if (confirmed === null) {
      return null;
    }

    this.#discardObsoletePending();
    this.#cancelActiveIfObsolete();
    this.#reconcileDependencyStates();
    return confirmed;
  }

  async analyze(
    activeUnitId: string,
    configuration: AnalysisConfiguration,
    kind: UnitAnalysisRequestKind = "manual",
  ): Promise<AnalysisOutcome> {
    this.updateConfiguration(configuration);

    const record = this.#records.get(activeUnitId);
    const state = this.#manager.getState(activeUnitId);
    if (record === undefined || state === null) {
      throw new TypeError("Cannot analyze an unknown active WritingUnit ID.");
    }

    const snapshot = captureAnalysisSnapshot(
      record.segment,
      configuration,
      record.analysisContext,
    );
    if (
      isUnitAnalysisStateCurrent(
        state,
        record.unit,
        snapshot.dependencyStamp,
      )
    ) {
      return Object.freeze({
        status: "applied" as const,
        appliedTrackIds: EMPTY_TRACK_IDS,
      });
    }

    const equivalent = this.#findEquivalentAnalysis(
      activeUnitId,
      createUnitSourceFingerprint(record.unit),
      snapshot.dependencyStamp,
    );
    if (equivalent !== undefined) {
      this.#promotePending(equivalent, kind);
      return equivalent.promise;
    }

    if (
      kind !== "debounced" &&
      this.#activeAnalysis?.kind === "debounced" &&
      this.#activeAnalysis.supersededAs === undefined
    ) {
      this.#supersedeActiveAnalysis("aborted");
    }

    const queued = createQueuedUnitAnalysis(
      record.unit,
      snapshot.dependencyStamp,
      configuration,
      kind,
    );
    this.#enqueue(queued);
    this.#drainQueue();
    return queued.promise;
  }

  #enqueue(analysis: QueuedUnitAnalysis): void {
    if (analysis.kind === "manual") {
      this.#replacePending(this.#pendingManual, analysis, "aborted");
      this.#pendingManual = analysis;
      return;
    }

    if (analysis.kind === "completion") {
      const existing = this.#pendingCompletions.get(analysis.unitId);
      this.#replacePending(existing, analysis, "stale");
      this.#pendingCompletions.set(analysis.unitId, analysis);
      return;
    }

    this.#replacePending(this.#pendingDebounced, analysis, "aborted");
    this.#pendingDebounced = analysis;
  }

  #replacePending(
    existing: QueuedUnitAnalysis | undefined,
    replacement: QueuedUnitAnalysis,
    reason: "stale" | "aborted",
  ): void {
    if (existing !== undefined && existing !== replacement) {
      this.#removePending(existing);
      existing.resolve(outcomeForReason(reason));
    }
  }

  #promotePending(
    analysis: QueuedUnitAnalysis,
    requestedKind: UnitAnalysisRequestKind,
  ): void {
    if (
      analysis === this.#activeAnalysis ||
      requestPriority(analysis.kind) >= requestPriority(requestedKind)
    ) {
      return;
    }

    this.#removePending(analysis);
    analysis.kind = requestedKind;
    this.#enqueue(analysis);
  }

  #findEquivalentAnalysis(
    unitId: string,
    sourceFingerprint: UnitSourceFingerprint,
    dependencyStamp: DependencyStamp,
  ): QueuedUnitAnalysis | undefined {
    const active = this.#activeAnalysis;
    return this.#allAnalyses().find(
      (analysis) =>
        analysis.unitId === unitId &&
        analysis.sourceFingerprint === sourceFingerprint &&
        dependencyStampMatches(
          analysis.dependencyStamp,
          dependencyStamp,
        ) &&
        (analysis !== active || active.supersededAs === undefined),
    );
  }

  #allAnalyses(): QueuedUnitAnalysis[] {
    const analyses: QueuedUnitAnalysis[] = [];
    if (this.#activeAnalysis !== undefined) {
      analyses.push(this.#activeAnalysis);
    }
    if (this.#pendingManual !== undefined) {
      analyses.push(this.#pendingManual);
    }
    analyses.push(...this.#pendingCompletions.values());
    if (this.#pendingDebounced !== undefined) {
      analyses.push(this.#pendingDebounced);
    }
    return analyses;
  }

  #drainQueue(): void {
    if (this.#activeAnalysis !== undefined) {
      return;
    }

    while (true) {
      const queued = this.#takeNextPending();
      if (queued === undefined) {
        return;
      }
      if (!this.#analysisStillCurrent(queued)) {
        queued.resolve(STALE_OUTCOME);
        continue;
      }

      const record = this.#records.get(queued.unitId)!;
      const state = this.#manager.getState(queued.unitId)!;
      const snapshot = captureAnalysisSnapshot(
        record.segment,
        queued.configuration,
        record.analysisContext,
      );
      if (
        isUnitAnalysisStateCurrent(
          state,
          record.unit,
          snapshot.dependencyStamp,
        )
      ) {
        queued.resolve(
          Object.freeze({
            status: "applied" as const,
            appliedTrackIds: EMPTY_TRACK_IDS,
          }),
        );
        continue;
      }

      const analyzing = markUnitAnalysisAnalyzing(
        record.unit,
        record.segment.sourceTrack.revision,
        state.result,
      );
      this.#manager.setState(record.unit.id, analyzing);
      const active: ActiveUnitAnalysis = {
        ...queued,
        segmentId: record.segment.id,
        analyzingState: analyzing,
      };
      this.#activeAnalysis = active;
      void this.#executeActive(active, record, snapshot);
      return;
    }
  }

  async #executeActive(
    active: ActiveUnitAnalysis,
    record: RuntimeUnitRecord,
    snapshot: ReturnType<typeof captureAnalysisSnapshot>,
  ): Promise<void> {
    let finalOutcome: AnalysisOutcome;
    try {
      const outcome = await this.#analysisCoordinator.analyze(
        record.segment,
        active.configuration,
        record.analysisContext,
      );

      if (active.supersededAs !== undefined) {
        finalOutcome = outcomeForReason(active.supersededAs);
      } else if (outcome.status === "failed") {
        this.#manager.setState(
          record.unit.id,
          markUnitAnalysisFailed(active.analyzingState, record.unit),
        );
        finalOutcome = outcome;
      } else if (outcome.status === "stale" || outcome.status === "aborted") {
        this.#stopAnalyzing(record, active.analyzingState);
        finalOutcome = outcome;
      } else {
        finalOutcome = this.#commitAppliedOutcome(
          active,
          record,
          snapshot,
          outcome,
        );
      }
    } catch (error) {
      if (active.supersededAs !== undefined) {
        finalOutcome = outcomeForReason(active.supersededAs);
      } else {
        const currentRecord = this.#records.get(active.unitId);
        const currentState = this.#manager.getState(active.unitId);
        if (
          currentRecord !== undefined &&
          currentState?.status === "analyzing" &&
          currentRecord.segment.id === active.segmentId
        ) {
          this.#manager.setState(
            active.unitId,
            markUnitAnalysisFailed(currentState, currentRecord.unit),
          );
        }
        finalOutcome = Object.freeze({ status: "failed" as const, error });
      }
    }

    if (this.#activeAnalysis === active) {
      this.#activeAnalysis = undefined;
    }
    active.resolve(finalOutcome);
    this.#drainQueue();
  }

  #commitAppliedOutcome(
    active: ActiveUnitAnalysis,
    record: RuntimeUnitRecord,
    snapshot: ReturnType<typeof captureAnalysisSnapshot>,
    outcome: Extract<AnalysisOutcome, { readonly status: "applied" }>,
  ): AnalysisOutcome {
    const currentRecord = this.#records.get(record.unit.id);
    if (
      currentRecord === undefined ||
      currentRecord.segment !== record.segment ||
      createUnitSourceFingerprint(currentRecord.unit) !==
        active.sourceFingerprint
    ) {
      return STALE_OUTCOME;
    }

    const currentConfiguration = this.#configuration ?? active.configuration;
    const currentStamp = captureAnalysisSnapshot(
      currentRecord.segment,
      currentConfiguration,
      currentRecord.analysisContext,
    ).dependencyStamp;
    if (!dependencyStampMatches(snapshot.dependencyStamp, currentStamp)) {
      this.#stopAnalyzing(currentRecord, active.analyzingState);
      return STALE_OUTCOME;
    }

    const result = resultFromAppliedTracks(
      record.segment,
      outcome.appliedTrackIds,
      snapshot.dependencyStamp,
    );
    currentRecord.resultTrackIds = Object.freeze([...outcome.appliedTrackIds]);
    this.#manager.setState(
      record.unit.id,
      markUnitAnalysisCompleted(
        active.analyzingState,
        currentRecord.unit,
        result,
      ),
    );
    return Object.freeze({
      status: "applied" as const,
      appliedTrackIds: Object.freeze([...outcome.appliedTrackIds]),
    });
  }

  #createSegment(sourceText: string): WritingSegment {
    const segmentNumber = ++this.#nextSegmentNumber;
    const prefix = `unit-${this.#coordinatorNumber}-${segmentNumber}`;
    return WritingSegment.create({
      id: asSegmentId(`${prefix}-segment`),
      sourceTrackId: asTrackId(`${prefix}-source`),
      sourceText,
    });
  }

  #takeNextPending(): QueuedUnitAnalysis | undefined {
    if (this.#pendingManual !== undefined) {
      const next = this.#pendingManual;
      this.#pendingManual = undefined;
      return next;
    }

    const nextCompletion = [...this.#pendingCompletions.values()].sort(
      (left, right) =>
        (this.#records.get(left.unitId)?.unit.order ?? Number.MAX_SAFE_INTEGER) -
        (this.#records.get(right.unitId)?.unit.order ?? Number.MAX_SAFE_INTEGER),
    )[0];
    if (nextCompletion !== undefined) {
      this.#pendingCompletions.delete(nextCompletion.unitId);
      return nextCompletion;
    }

    const next = this.#pendingDebounced;
    this.#pendingDebounced = undefined;
    return next;
  }

  #removePending(analysis: QueuedUnitAnalysis): void {
    if (this.#pendingManual === analysis) {
      this.#pendingManual = undefined;
    }
    if (this.#pendingCompletions.get(analysis.unitId) === analysis) {
      this.#pendingCompletions.delete(analysis.unitId);
    }
    if (this.#pendingDebounced === analysis) {
      this.#pendingDebounced = undefined;
    }
  }

  #analysisStillCurrent(analysis: QueuedUnitAnalysis): boolean {
    const record = this.#records.get(analysis.unitId);
    if (
      record === undefined ||
      this.#configuration === undefined ||
      createUnitSourceFingerprint(record.unit) !== analysis.sourceFingerprint
    ) {
      return false;
    }

    const currentStamp = captureAnalysisSnapshot(
      record.segment,
      this.#configuration,
      record.analysisContext,
    ).dependencyStamp;
    return dependencyStampMatches(analysis.dependencyStamp, currentStamp);
  }

  #discardObsoletePending(): void {
    for (const analysis of this.#allPending()) {
      if (!this.#analysisStillCurrent(analysis)) {
        this.#removePending(analysis);
        analysis.resolve(STALE_OUTCOME);
      }
    }
  }

  #cancelActiveIfObsolete(): void {
    const active = this.#activeAnalysis;
    if (
      active !== undefined &&
      active.supersededAs === undefined &&
      !this.#analysisStillCurrent(active)
    ) {
      this.#supersedeActiveAnalysis("stale");
    }
  }

  #allPending(): QueuedUnitAnalysis[] {
    const pending: QueuedUnitAnalysis[] = [];
    if (this.#pendingManual !== undefined) {
      pending.push(this.#pendingManual);
    }
    pending.push(...this.#pendingCompletions.values());
    if (this.#pendingDebounced !== undefined) {
      pending.push(this.#pendingDebounced);
    }
    return pending;
  }

  #cancelPending(reason: "stale" | "aborted"): void {
    const outcome = outcomeForReason(reason);
    for (const analysis of this.#allPending()) {
      this.#removePending(analysis);
      analysis.resolve(outcome);
    }
  }

  #reconcileDependencyStates(): void {
    if (this.#configuration === undefined) {
      return;
    }

    for (const record of this.#records.values()) {
      const state = this.#manager.getState(record.unit.id);
      if (
        state === null ||
        state.status === "idle" ||
        state.status === "analyzing" ||
        state.result === null
      ) {
        continue;
      }

      const currentStamp = captureAnalysisSnapshot(
        record.segment,
        this.#configuration,
        record.analysisContext,
      ).dependencyStamp;
      const dependenciesMatch = dependencyStampMatches(
        state.result.dependencyStamp,
        currentStamp,
      );

      if (dependenciesMatch && state.status !== "completed") {
        this.#manager.setState(
          record.unit.id,
          restoreUnitAnalysisCompleted(state, record.unit),
        );
      } else if (!dependenciesMatch && state.status !== "stale") {
        this.#manager.setState(
          record.unit.id,
          markUnitAnalysisStale(state, record.unit),
        );
      }
    }
  }

  #stopAnalyzing(
    record: RuntimeUnitRecord,
    analyzing: UnitAnalysisState,
  ): void {
    const currentRecord = this.#records.get(record.unit.id);
    const currentState = this.#manager.getState(record.unit.id);
    if (
      currentRecord === undefined ||
      currentState === null ||
      currentState.status !== "analyzing" ||
      currentRecord.segment !== record.segment
    ) {
      return;
    }

    this.#manager.setState(
      record.unit.id,
      analyzing.result === null
        ? createIdleUnitAnalysisState(record.unit.id)
        : markUnitAnalysisStale(analyzing, currentRecord.unit),
    );
  }

  #supersedeActiveAnalysis(reason: "stale" | "aborted"): void {
    const active = this.#activeAnalysis;
    if (active === undefined) {
      return;
    }

    active.supersededAs =
      active.supersededAs === "stale" ? "stale" : reason;
    this.#analysisCoordinator.cancelAnalysis(active.segmentId);
    const record = this.#records.get(active.unitId);
    const state = this.#manager.getState(active.unitId);
    if (record !== undefined && state?.status === "analyzing") {
      this.#stopAnalyzing(record, state);
    }
  }
}

function createQueuedUnitAnalysis(
  unit: WritingUnit,
  dependencyStamp: DependencyStamp,
  configuration: AnalysisConfiguration,
  kind: UnitAnalysisRequestKind,
): QueuedUnitAnalysis {
  let resolve!: (outcome: AnalysisOutcome) => void;
  const promise = new Promise<AnalysisOutcome>((resolver) => {
    resolve = resolver;
  });

  return {
    unitId: unit.id,
    sourceFingerprint: createUnitSourceFingerprint(unit),
    dependencyStamp,
    configuration: copyAnalysisConfiguration(configuration),
    kind,
    promise,
    resolve,
  };
}

function requestPriority(kind: UnitAnalysisRequestKind): number {
  return kind === "manual" ? 3 : kind === "completion" ? 2 : 1;
}

function outcomeForReason(reason: "stale" | "aborted"): AnalysisOutcome {
  return reason === "stale" ? STALE_OUTCOME : ABORTED_OUTCOME;
}

function resultFromAppliedTracks(
  segment: WritingSegment,
  appliedTrackIds: readonly TrackId[],
  dependencyStamp: DependencyStamp,
): UnitAnalysisResult {
  const includedIds = new Set(appliedTrackIds);
  const tracks = segment
    .listDerivedTracks()
    .filter((track) => includedIds.has(track.id))
    .filter(isTextTrack);
  const nativeIntent = tracks.find(
    (track) => track.typeId === NATIVE_INTENT_TRACK_TYPE_ID,
  );
  const normalized = tracks
    .filter((track) => track.typeId === NORMALIZED_TRACK_TYPE_ID)
    .sort(
      (left, right) =>
        (left.order ?? Number.MAX_SAFE_INTEGER) -
        (right.order ?? Number.MAX_SAFE_INTEGER),
    )
    .map((track) => ({ text: track.payload.text, label: track.label ?? null }));

  return createUnitAnalysisResult({
    nativeIntent: nativeIntent?.payload.text ?? null,
    normalized,
    dependencyStamp,
  });
}

function isTextTrack(
  track: DerivedTrack<unknown>,
): track is DerivedTrack<{ readonly text: string }> {
  return (
    typeof track.payload === "object" &&
    track.payload !== null &&
    "text" in track.payload &&
    typeof track.payload.text === "string"
  );
}

function assertUnitsMapToSelection(
  selection: ContextSelection,
  units: readonly WritingUnit[],
): void {
  const ids = new Set<string>();
  for (const unit of units) {
    if (ids.has(unit.id)) {
      throw new TypeError("WritingUnit IDs must be unique when synchronized.");
    }
    ids.add(unit.id);
    if (
      unit.range.end > selection.activeText.length ||
      selection.activeText.slice(unit.range.start, unit.range.end) !== unit.text
    ) {
      throw new TypeError("WritingUnit must map exactly to selection.activeText.");
    }
  }
}

function configurationIdentity(configuration: AnalysisConfiguration): string {
  return JSON.stringify([
    configuration.assistPolicyFingerprint,
    configuration.styleProfileFingerprint,
    configuration.languageConfigurationFingerprint,
    configuration.processorConfigurationFingerprint,
    configuration.targetLanguageId,
    configuration.nativeLanguageId,
  ]);
}
