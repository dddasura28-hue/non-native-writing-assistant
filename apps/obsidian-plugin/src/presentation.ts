import type {
  AnalysisOutcome,
  UnitAssistancePresentationModel,
  UnitAssistanceTrackPresentation,
} from "@non-native-writing/application";
import {
  NATIVE_INTENT_TRACK_TYPE_ID,
  NORMALIZED_TRACK_TYPE_ID,
} from "@non-native-writing/core";
import type {
  DerivedTrack,
  TrackId,
  WritingSegment,
} from "@non-native-writing/core";

export type AnalysisStatus =
  | "Idle"
  | "Analyzing"
  | "Applied"
  | "Stale"
  | "Aborted"
  | "Configuration required"
  | "Failed";

export type TrackPresentation = UnitAssistanceTrackPresentation;

export interface UnitAssistanceViewModel {
  readonly unitId: string | null;
  readonly status: AnalysisStatus;
  readonly statusDetail?: string;
  readonly sourceText: string;
  readonly nativeIntentTracks: readonly TrackPresentation[];
  readonly normalizedTracks: readonly TrackPresentation[];
  readonly isActive: boolean;
}

export interface WritingAssistantViewModel extends UnitAssistanceViewModel {
  readonly recentAssistance: readonly UnitAssistanceViewModel[];
}

export function createEmptyViewModel(): WritingAssistantViewModel {
  return Object.freeze({
    unitId: null,
    status: "Idle" as const,
    sourceText: "",
    nativeIntentTracks: Object.freeze([]),
    normalizedTracks: Object.freeze([]),
    isActive: true,
    recentAssistance: Object.freeze([]),
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

function compareTrackPresentation(
  left: TrackPresentation,
  right: TrackPresentation,
): number {
  return (left.order ?? Number.MAX_SAFE_INTEGER) -
    (right.order ?? Number.MAX_SAFE_INTEGER);
}

function presentTracks(
  segment: WritingSegment,
  typeId: typeof NATIVE_INTENT_TRACK_TYPE_ID | typeof NORMALIZED_TRACK_TYPE_ID,
  includedTrackIds: ReadonlySet<TrackId>,
): readonly TrackPresentation[] {
  return Object.freeze(
    segment
      .listDerivedTracks()
      .filter(
        (track) =>
          track.typeId === typeId &&
          includedTrackIds.has(track.id),
      )
      .filter(isTextTrack)
      .map((track) =>
        Object.freeze({
          id: track.id,
          text: track.payload.text,
          label: track.label,
          order: track.order,
        }),
      )
      .sort(compareTrackPresentation),
  );
}

export function createViewModel(
  segment: WritingSegment,
  status: AnalysisStatus,
  includedTrackIds: readonly TrackId[] = [],
  statusDetail?: string,
): WritingAssistantViewModel {
  const includedIds = new Set(includedTrackIds);

  return Object.freeze({
    unitId: null,
    status,
    statusDetail,
    sourceText: segment.sourceText,
    nativeIntentTracks: presentTracks(
      segment,
      NATIVE_INTENT_TRACK_TYPE_ID,
      includedIds,
    ),
    normalizedTracks: presentTracks(
      segment,
      NORMALIZED_TRACK_TYPE_ID,
      includedIds,
    ),
    isActive: true,
    recentAssistance: Object.freeze([]),
  });
}

export function createIncrementalViewModel(
  presentation: UnitAssistancePresentationModel,
  status: AnalysisStatus,
  statusDetail?: string,
): WritingAssistantViewModel {
  if (presentation.active === null) {
    return Object.freeze({
      ...createEmptyViewModel(),
      status,
      statusDetail,
    });
  }

  const active = presentation.active;
  return Object.freeze({
    unitId: active.unitId,
    status,
    statusDetail,
    sourceText: active.sourceText,
    nativeIntentTracks: active.nativeIntentTracks,
    normalizedTracks: active.normalizedTracks,
    isActive: true,
    recentAssistance: Object.freeze(
      presentation.recent.map((item) =>
        Object.freeze({
          unitId: item.unitId,
          status: "Applied" as const,
          sourceText: item.sourceText,
          nativeIntentTracks: item.nativeIntentTracks,
          normalizedTracks: item.normalizedTracks,
          isActive: false,
        }),
      ),
    ),
  });
}

export function statusForOutcome(outcome: AnalysisOutcome): AnalysisStatus {
  switch (outcome.status) {
    case "applied":
      return "Applied";
    case "stale":
      return "Stale";
    case "aborted":
      return "Aborted";
    case "failed":
      return "Failed";
  }
}
