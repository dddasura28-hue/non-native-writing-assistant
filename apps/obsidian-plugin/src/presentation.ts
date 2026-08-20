import type { AnalysisOutcome } from "@non-native-writing/application";
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

export interface TrackPresentation {
  readonly id: TrackId;
  readonly text: string;
  readonly label?: string;
  readonly order?: number;
}

export interface WritingAssistantViewModel {
  readonly status: AnalysisStatus;
  readonly statusDetail?: string;
  readonly sourceText: string;
  readonly nativeIntentTracks: readonly TrackPresentation[];
  readonly normalizedTracks: readonly TrackPresentation[];
}

export function createEmptyViewModel(): WritingAssistantViewModel {
  return Object.freeze({
    status: "Idle" as const,
    sourceText: "",
    nativeIntentTracks: Object.freeze([]),
    normalizedTracks: Object.freeze([]),
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
