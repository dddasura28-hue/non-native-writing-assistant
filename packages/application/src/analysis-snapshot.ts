import {
  NATIVE_INTENT_TRACK_TYPE_ID,
  createDependencyStamp,
  isConfirmedNativeIntentValid,
} from "@non-native-writing/core";
import type {
  AnyTrack,
  DependencyStamp,
  NativeIntentTrack,
  SegmentId,
  TrackId,
  WritingSegment,
} from "@non-native-writing/core";

import type { AnalysisConfiguration } from "./analysis-configuration.js";
import type { AnalysisContext } from "./analysis-context.js";

export interface ConfirmedNativeIntentSnapshot {
  readonly trackId: TrackId;
  readonly text: string;
  readonly revision: number;
}

export interface AnalysisSnapshot {
  readonly segmentId: SegmentId;
  readonly sourceTrackId: TrackId;
  readonly sourceText: string;
  readonly beforeContext: string;
  readonly afterContext: string;
  readonly sourceRevision: number;
  readonly dependencyStamp: DependencyStamp;
  readonly confirmedNativeIntent?: ConfirmedNativeIntentSnapshot;
  readonly targetLanguageId: string;
  readonly nativeLanguageId: string;
}

function isNativeIntentTrack(track: AnyTrack): track is NativeIntentTrack {
  if (
    track.typeId !== NATIVE_INTENT_TRACK_TYPE_ID ||
    !("dependencyStamp" in track)
  ) {
    return false;
  }

  const payload = track.payload;
  return (
    typeof payload === "object" &&
    payload !== null &&
    "text" in payload &&
    typeof payload.text === "string"
  );
}

function findCurrentConfirmedNativeIntent(
  segment: WritingSegment,
): NativeIntentTrack | undefined {
  let selected: NativeIntentTrack | undefined;

  for (const track of segment.findTracksByType(NATIVE_INTENT_TRACK_TYPE_ID)) {
    if (
      isNativeIntentTrack(track) &&
      isConfirmedNativeIntentValid(track, segment.sourceTrack.revision) &&
      (selected === undefined || track.revision > selected.revision)
    ) {
      selected = track;
    }
  }

  return selected;
}

export function captureAnalysisSnapshot(
  segment: WritingSegment,
  configuration: AnalysisConfiguration,
  context: AnalysisContext,
): AnalysisSnapshot {
  const confirmedIntent = findCurrentConfirmedNativeIntent(segment);
  const dependencyStamp = createDependencyStamp({
    sourceRevision: segment.sourceTrack.revision,
    confirmedNativeIntentRevision: confirmedIntent?.revision,
    assistPolicyFingerprint: configuration.assistPolicyFingerprint,
    styleProfileFingerprint: configuration.styleProfileFingerprint,
    languageConfigurationFingerprint:
      configuration.languageConfigurationFingerprint,
    processorConfigurationFingerprint:
      configuration.processorConfigurationFingerprint,
    contextFingerprint: context.contextFingerprint,
  });
  const confirmedNativeIntent = confirmedIntent
    ? Object.freeze({
        trackId: confirmedIntent.id,
        text: confirmedIntent.payload.text,
        revision: confirmedIntent.revision,
      })
    : undefined;

  return Object.freeze({
    segmentId: segment.id,
    sourceTrackId: segment.sourceTrack.id,
    sourceText: segment.sourceText,
    beforeContext: context.beforeContext,
    afterContext: context.afterContext,
    sourceRevision: segment.sourceTrack.revision,
    dependencyStamp,
    confirmedNativeIntent,
    targetLanguageId: configuration.targetLanguageId,
    nativeLanguageId: configuration.nativeLanguageId,
  });
}
