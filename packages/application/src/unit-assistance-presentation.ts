import {
  NATIVE_INTENT_TRACK_TYPE_ID,
  NORMALIZED_TRACK_TYPE_ID,
  type DerivedTrack,
  type TrackId,
} from "@non-native-writing/core";

import type { AnalysisConfiguration } from "./analysis-configuration.js";
import type { IncrementalUnitAnalysisCoordinator } from "./incremental-unit-analysis-coordinator.js";
import type { UnitAnalysisStatus } from "./unit-analysis-state.js";

export const RECENT_ASSISTANCE_LIMIT = 3;

export interface UnitAssistanceTrackPresentation {
  readonly id: TrackId;
  readonly text: string;
  readonly label?: string;
  readonly order?: number;
}

/** Provider- and host-neutral view data for one transient WritingUnit. */
export interface UnitAssistancePresentation {
  readonly unitId: string;
  readonly sourceText: string;
  readonly status: UnitAnalysisStatus;
  readonly nativeIntentTracks: readonly UnitAssistanceTrackPresentation[];
  readonly normalizedTracks: readonly UnitAssistanceTrackPresentation[];
  readonly isActive: boolean;
}

export interface UnitAssistancePresentationModel {
  readonly active: UnitAssistancePresentation | null;
  readonly recent: readonly UnitAssistancePresentation[];
}

/**
 * Creates a bounded presentation snapshot from the coordinator's current
 * ContextSelection. Cached stale/failed data is intentionally omitted.
 */
export function createUnitAssistancePresentationModel(
  coordinator: IncrementalUnitAnalysisCoordinator,
  activeUnitId: string | null,
  configuration: AnalysisConfiguration,
): UnitAssistancePresentationModel {
  if (activeUnitId === null) {
    return emptyPresentationModel();
  }

  const records = coordinator.listRecords();
  const activeRecord = records.find(
    (record) => record.unit.id === activeUnitId,
  );
  if (activeRecord === undefined) {
    return emptyPresentationModel();
  }

  const active = presentUnit(
    coordinator,
    activeRecord,
    configuration,
    true,
  );
  const recent = records
    .filter((record) => record.unit.id !== activeUnitId)
    .map((record) => ({
      record,
      presentation: presentCurrentCompletedUnit(
        coordinator,
        record,
        configuration,
      ),
    }))
    .filter(
      (
        candidate,
      ): candidate is typeof candidate & {
        readonly presentation: UnitAssistancePresentation;
      } => candidate.presentation !== null,
    )
    .sort((left, right) =>
      compareRecentUnitOrder(
        activeRecord.unit.order,
        left.record.unit.order,
        right.record.unit.order,
        left.record.unit.id,
        right.record.unit.id,
      ),
    )
    .slice(0, RECENT_ASSISTANCE_LIMIT)
    .map((candidate) => candidate.presentation);

  return Object.freeze({
    active,
    recent: Object.freeze(recent),
  });
}

type UnitRecord = ReturnType<
  IncrementalUnitAnalysisCoordinator["listRecords"]
>[number];

function presentCurrentCompletedUnit(
  coordinator: IncrementalUnitAnalysisCoordinator,
  record: UnitRecord,
  configuration: AnalysisConfiguration,
): UnitAssistancePresentation | null {
  if (
    record.state.status !== "completed" ||
    coordinator.getCurrentResult(record.unit.id, configuration) === null
  ) {
    return null;
  }

  return presentUnit(coordinator, record, configuration, false);
}

function presentUnit(
  coordinator: IncrementalUnitAnalysisCoordinator,
  record: UnitRecord,
  configuration: AnalysisConfiguration,
  isActive: boolean,
): UnitAssistancePresentation {
  const isCurrent =
    coordinator.getCurrentResult(record.unit.id, configuration) !== null;
  const includedTrackIds = new Set(
    isCurrent
      ? coordinator.getCurrentTrackIds(record.unit.id, configuration)
      : [],
  );
  const tracks = record.segment
    .listDerivedTracks()
    .filter((track) => includedTrackIds.has(track.id))
    .filter(isTextTrack);
  const status =
    record.state.status === "completed" && !isCurrent
      ? "stale"
      : record.state.status;

  return Object.freeze({
    unitId: record.unit.id,
    sourceText: record.unit.text,
    status,
    nativeIntentTracks: presentTracks(
      tracks,
      NATIVE_INTENT_TRACK_TYPE_ID,
    ),
    normalizedTracks: presentTracks(tracks, NORMALIZED_TRACK_TYPE_ID),
    isActive,
  });
}

function presentTracks(
  tracks: readonly DerivedTrack<{ readonly text: string }>[],
  typeId:
    | typeof NATIVE_INTENT_TRACK_TYPE_ID
    | typeof NORMALIZED_TRACK_TYPE_ID,
): readonly UnitAssistanceTrackPresentation[] {
  return Object.freeze(
    tracks
      .filter((track) => track.typeId === typeId)
      .map((track) =>
        Object.freeze({
          id: track.id,
          text: track.payload.text,
          label: track.label,
          order: track.order,
        }),
      )
      .sort(compareTrackOrder),
  );
}

function compareTrackOrder(
  left: UnitAssistanceTrackPresentation,
  right: UnitAssistanceTrackPresentation,
): number {
  return (
    (left.order ?? Number.MAX_SAFE_INTEGER) -
      (right.order ?? Number.MAX_SAFE_INTEGER) ||
    compareStrings(left.id, right.id)
  );
}

function compareRecentUnitOrder(
  activeOrder: number,
  leftOrder: number,
  rightOrder: number,
  leftId: string,
  rightId: string,
): number {
  const leftIsPrevious = leftOrder < activeOrder;
  const rightIsPrevious = rightOrder < activeOrder;
  if (leftIsPrevious !== rightIsPrevious) {
    return leftIsPrevious ? -1 : 1;
  }

  const orderDifference = leftIsPrevious
    ? rightOrder - leftOrder
    : leftOrder - rightOrder;
  return orderDifference || compareStrings(leftId, rightId);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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

function emptyPresentationModel(): UnitAssistancePresentationModel {
  return Object.freeze({
    active: null,
    recent: Object.freeze([]),
  });
}
