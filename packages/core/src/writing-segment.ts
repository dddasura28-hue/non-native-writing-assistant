import type { SegmentId, TrackId, TrackTypeId } from "./ids.js";
import {
  createSourceTrack,
  editNativeIntentTrack,
  type AnyTrack,
  type DerivedTrack,
  type NativeIntentTrack,
  type SourceTrack,
} from "./track.js";
import {
  NATIVE_INTENT_TRACK_TYPE_ID,
  SOURCE_TRACK_TYPE_ID,
} from "./track-type-ids.js";

export interface CreateWritingSegmentInput {
  readonly id: SegmentId;
  readonly sourceTrackId: TrackId;
  readonly sourceText: string;
}

export class WritingSegment {
  readonly id: SegmentId;

  #sourceTrack: SourceTrack;
  readonly #derivedTracks = new Map<TrackId, DerivedTrack<unknown>>();

  private constructor(input: CreateWritingSegmentInput) {
    this.id = input.id;
    this.#sourceTrack = createSourceTrack({
      id: input.sourceTrackId,
      segmentId: input.id,
      text: input.sourceText,
    });
  }

  static create(input: CreateWritingSegmentInput): WritingSegment {
    return new WritingSegment(input);
  }

  get sourceTrack(): SourceTrack {
    return this.#sourceTrack;
  }

  get sourceText(): string {
    return this.#sourceTrack.payload.text;
  }

  listDerivedTracks(): readonly DerivedTrack<unknown>[] {
    return [...this.#derivedTracks.values()];
  }

  findTracksByType(typeId: TrackTypeId): readonly AnyTrack[] {
    const matches: AnyTrack[] = [];

    if (this.#sourceTrack.typeId === typeId) {
      matches.push(this.#sourceTrack);
    }

    for (const track of this.#derivedTracks.values()) {
      if (track.typeId === typeId) {
        matches.push(track);
      }
    }

    return matches;
  }

  addDerivedTrack<TPayload>(track: DerivedTrack<TPayload>): void {
    if (track.typeId === SOURCE_TRACK_TYPE_ID) {
      throw new TypeError("The source track cannot be added as derived data.");
    }

    if (track.segmentId !== this.id) {
      throw new TypeError("A derived track must belong to this writing segment.");
    }

    if (this.#derivedTracks.has(track.id)) {
      throw new TypeError("A track with this TrackId already exists.");
    }

    this.#derivedTracks.set(track.id, track);
  }

  confirmNativeIntent(
    trackId: TrackId,
    text: string,
    expectedSourceRevision: number,
    expectedTrackRevision: number,
  ): NativeIntentTrack | null {
    if (this.#sourceTrack.revision !== expectedSourceRevision) {
      return null;
    }

    const track = this.#derivedTracks.get(trackId);
    if (
      track === undefined ||
      track.typeId !== NATIVE_INTENT_TRACK_TYPE_ID ||
      track.revision !== expectedTrackRevision ||
      !isTextTrack(track)
    ) {
      return null;
    }

    const confirmed = editNativeIntentTrack(
      track,
      text,
      expectedSourceRevision,
    );
    this.#derivedTracks.set(track.id, confirmed);
    return confirmed;
  }

  updateSourceText(text: string): SourceTrack {
    if (text === this.#sourceTrack.payload.text) {
      return this.#sourceTrack;
    }

    this.#sourceTrack = createSourceTrack({
      id: this.#sourceTrack.id,
      segmentId: this.id,
      text,
      revision: this.#sourceTrack.revision + 1,
    });

    return this.#sourceTrack;
  }
}

function isTextTrack(
  track: DerivedTrack<unknown>,
): track is NativeIntentTrack {
  return (
    typeof track.payload === "object" &&
    track.payload !== null &&
    "text" in track.payload &&
    typeof track.payload.text === "string"
  );
}
