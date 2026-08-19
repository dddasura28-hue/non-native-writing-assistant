import { createDependencyStamp } from "./dependency-stamp.js";
import type { DependencyStamp } from "./dependency-stamp.js";
import type {
  GenerationGroupId,
  SegmentId,
  TrackId,
  TrackTypeId,
} from "./ids.js";
import {
  NATIVE_INTENT_TRACK_TYPE_ID,
  NORMALIZED_TRACK_TYPE_ID,
  SOURCE_TRACK_TYPE_ID,
} from "./track-type-ids.js";

export type TrackProvenance = "user" | "model" | "user-edited-model";

export interface SourceTextPayload {
  readonly text: string;
}

export interface NativeIntentTextPayload {
  readonly text: string;
}

export interface NormalizedTextPayload {
  readonly text: string;
}

export interface Track<TPayload> {
  readonly id: TrackId;
  readonly segmentId: SegmentId;
  readonly typeId: TrackTypeId;
  readonly payload: TPayload;
  readonly provenance: TrackProvenance;
  readonly revision: number;
}

export interface SourceTrack extends Track<SourceTextPayload> {
  readonly provenance: "user";
}

export interface DerivedTrack<TPayload = unknown> extends Track<TPayload> {
  readonly dependencyStamp: DependencyStamp;
  readonly generationGroupId?: GenerationGroupId;
  readonly label?: string;
  readonly order?: number;
}

export type NativeIntentTrack = DerivedTrack<NativeIntentTextPayload>;
export type NormalizedTrack = DerivedTrack<NormalizedTextPayload>;
export type AnyTrack = SourceTrack | DerivedTrack<unknown>;

interface CreateSourceTrackInput {
  readonly id: TrackId;
  readonly segmentId: SegmentId;
  readonly text: string;
  readonly revision?: number;
}

export interface CreateDerivedTextTrackInput {
  readonly id: TrackId;
  readonly segmentId: SegmentId;
  readonly text: string;
  readonly provenance: TrackProvenance;
  readonly revision?: number;
  readonly dependencyStamp: DependencyStamp;
  readonly generationGroupId?: GenerationGroupId;
  readonly label?: string;
  readonly order?: number;
}

function assertRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new RangeError("Track revision must be a non-negative integer.");
  }
}

export function createSourceTrack(input: CreateSourceTrackInput): SourceTrack {
  const revision = input.revision ?? 1;
  assertRevision(revision);

  return Object.freeze({
    id: input.id,
    segmentId: input.segmentId,
    typeId: SOURCE_TRACK_TYPE_ID,
    payload: Object.freeze({ text: input.text }),
    provenance: "user" as const,
    revision,
  });
}

function createDerivedTextTrack<TPayload extends { readonly text: string }>(
  typeId: TrackTypeId,
  input: CreateDerivedTextTrackInput,
): DerivedTrack<TPayload> {
  const revision = input.revision ?? 1;
  assertRevision(revision);

  return Object.freeze({
    id: input.id,
    segmentId: input.segmentId,
    typeId,
    payload: Object.freeze({ text: input.text }) as TPayload,
    provenance: input.provenance,
    revision,
    dependencyStamp: createDependencyStamp(input.dependencyStamp),
    generationGroupId: input.generationGroupId,
    label: input.label,
    order: input.order,
  });
}

export function createNativeIntentTrack(
  input: CreateDerivedTextTrackInput,
): NativeIntentTrack {
  return createDerivedTextTrack<NativeIntentTextPayload>(
    NATIVE_INTENT_TRACK_TYPE_ID,
    input,
  );
}

export function createNormalizedTrack(
  input: CreateDerivedTextTrackInput,
): NormalizedTrack {
  return createDerivedTextTrack<NormalizedTextPayload>(
    NORMALIZED_TRACK_TYPE_ID,
    input,
  );
}

export function editNativeIntentTrack(
  track: NativeIntentTrack,
  text: string,
  confirmedAgainstSourceRevision: number,
): NativeIntentTrack {
  if (track.typeId !== NATIVE_INTENT_TRACK_TYPE_ID) {
    throw new TypeError("Only a native-intent track can be confirmed.");
  }

  assertRevision(confirmedAgainstSourceRevision);

  return Object.freeze({
    ...track,
    payload: Object.freeze({ text }),
    provenance: "user-edited-model" as const,
    revision: track.revision + 1,
    dependencyStamp: createDependencyStamp({
      ...track.dependencyStamp,
      sourceRevision: confirmedAgainstSourceRevision,
    }),
  });
}

export function isConfirmedNativeIntentValid(
  track: NativeIntentTrack,
  currentSourceRevision: number,
): boolean {
  return (
    track.typeId === NATIVE_INTENT_TRACK_TYPE_ID &&
    track.provenance === "user-edited-model" &&
    track.dependencyStamp.sourceRevision === currentSourceRevision
  );
}
