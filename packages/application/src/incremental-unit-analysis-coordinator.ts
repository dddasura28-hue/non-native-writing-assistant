import {
  NATIVE_INTENT_TRACK_TYPE_ID,
  NORMALIZED_TRACK_TYPE_ID,
  WritingSegment,
  asSegmentId,
  asTrackId,
  dependencyStampMatches,
  type DependencyStamp,
  type DerivedTrack,
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
import { createUnitSourceFingerprint } from "./unit-source-fingerprint.js";
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

interface ActiveBatch {
  readonly token: symbol;
  readonly unitId: string;
  readonly segmentId: SegmentId;
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
  #synchronizationKey: string | undefined;
  #configuration: AnalysisConfiguration | undefined;
  #activeBatch: ActiveBatch | undefined;

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

    const synchronizationKey = createSynchronizationKey(selection, units);
    const synchronizationChanged =
      this.#synchronizationKey !== undefined &&
      this.#synchronizationKey !== synchronizationKey;

    if (synchronizationChanged) {
      this.#supersedeActiveBatch("stale");
    }

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
    this.#synchronizationKey = synchronizationKey;
    this.#reconcileDependencyStates();
  }

  clear(): void {
    this.#supersedeActiveBatch("stale");
    for (const record of this.#records.values()) {
      this.#analysisCoordinator.cancelAnalysis(record.segment.id);
    }
    this.#manager.synchronize([]);
    this.#records = new Map();
    this.#synchronizationKey = undefined;
  }

  cancel(): void {
    this.#supersedeActiveBatch("aborted");
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
      this.#supersedeActiveBatch("stale");
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

  async analyze(
    activeUnitId: string,
    configuration: AnalysisConfiguration,
  ): Promise<AnalysisOutcome> {
    this.updateConfiguration(configuration);
    this.#supersedeActiveBatch("aborted");

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

    const analyzing = markUnitAnalysisAnalyzing(
      record.unit,
      record.segment.sourceTrack.revision,
      state.result,
    );
    this.#manager.setState(record.unit.id, analyzing);

    const batch: ActiveBatch = {
      token: Symbol("unit-analysis-batch"),
      unitId: record.unit.id,
      segmentId: record.segment.id,
    };
    this.#activeBatch = batch;

    try {
      const outcome = await this.#analysisCoordinator.analyze(
        record.segment,
        configuration,
        record.analysisContext,
      );

      if (this.#activeBatch !== batch) {
        return outcome.status === "stale" || batch.supersededAs === "stale"
          ? STALE_OUTCOME
          : ABORTED_OUTCOME;
      }

      if (outcome.status === "failed") {
        this.#manager.setState(
          record.unit.id,
          markUnitAnalysisFailed(analyzing, record.unit),
        );
        return outcome;
      }
      if (outcome.status === "stale" || outcome.status === "aborted") {
        this.#stopAnalyzing(record, analyzing);
        return outcome;
      }

      const currentRecord = this.#records.get(record.unit.id);
      if (
        currentRecord === undefined ||
        currentRecord.segment !== record.segment ||
        createUnitSourceFingerprint(currentRecord.unit) !==
          createUnitSourceFingerprint(record.unit)
      ) {
        return STALE_OUTCOME;
      }
      const currentConfiguration = this.#configuration ?? configuration;
      const currentStamp = captureAnalysisSnapshot(
        currentRecord.segment,
        currentConfiguration,
        currentRecord.analysisContext,
      ).dependencyStamp;
      if (
        !dependencyStampMatches(snapshot.dependencyStamp, currentStamp) ||
        createUnitSourceFingerprint(currentRecord.unit) !==
          analyzing.sourceFingerprint
      ) {
        this.#stopAnalyzing(currentRecord, analyzing);
        return STALE_OUTCOME;
      }

      const result = resultFromAppliedTracks(
        record.segment,
        outcome.appliedTrackIds,
        snapshot.dependencyStamp,
      );
      currentRecord.resultTrackIds = Object.freeze([
        ...outcome.appliedTrackIds,
      ]);
      this.#manager.setState(
        record.unit.id,
        markUnitAnalysisCompleted(analyzing, currentRecord.unit, result),
      );

      return Object.freeze({
        status: "applied" as const,
        appliedTrackIds: Object.freeze([...outcome.appliedTrackIds]),
      });
    } finally {
      if (this.#activeBatch === batch) {
        this.#activeBatch = undefined;
      }
    }
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

  #supersedeActiveBatch(reason: "stale" | "aborted"): void {
    const active = this.#activeBatch;
    if (active === undefined) {
      return;
    }

    active.supersededAs = reason;
    this.#analysisCoordinator.cancelAnalysis(active.segmentId);
    const record = this.#records.get(active.unitId);
    const state = this.#manager.getState(active.unitId);
    if (record !== undefined && state?.status === "analyzing") {
      this.#stopAnalyzing(record, state);
    }
    this.#activeBatch = undefined;
  }
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

function createSynchronizationKey(
  selection: ContextSelection,
  units: readonly WritingUnit[],
): string {
  return JSON.stringify([
    selection.activeText,
    selection.sourceRange.start,
    selection.sourceRange.end,
    selection.beforeContext,
    selection.afterContext,
    units.map((unit) => [
      unit.id,
      unit.text,
      unit.range.start,
      unit.range.end,
      unit.order,
    ]),
  ]);
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
