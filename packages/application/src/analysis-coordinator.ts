import {
  NATIVE_INTENT_TRACK_TYPE_ID,
  NORMALIZED_TRACK_TYPE_ID,
  createNativeIntentTrack,
  createNormalizedTrack,
  dependencyStampMatches,
} from "@non-native-writing/core";
import type {
  DerivedTrack,
  SegmentId,
  TrackId,
  WritingSegment,
} from "@non-native-writing/core";

import {
  copyAnalysisConfiguration,
  type AnalysisConfiguration,
} from "./analysis-configuration.js";
import type {
  AnalysisProposal,
  AnalysisProvider,
  ProposedDerivedTextTrack,
} from "./analysis-provider.js";
import {
  captureAnalysisSnapshot,
  type AnalysisSnapshot,
} from "./analysis-snapshot.js";

export type AnalysisOutcome =
  | {
      readonly status: "applied";
      readonly appliedTrackIds: readonly TrackId[];
    }
  | { readonly status: "stale" }
  | { readonly status: "aborted" }
  | { readonly status: "failed"; readonly error: unknown };

interface ActiveRequest {
  readonly token: symbol;
  readonly controller: AbortController;
}

const STALE_OUTCOME = Object.freeze({ status: "stale" as const });
const ABORTED_OUTCOME = Object.freeze({ status: "aborted" as const });

export class AnalysisCoordinator {
  readonly #provider: AnalysisProvider;
  readonly #activeRequests = new Map<SegmentId, ActiveRequest>();
  readonly #configurations = new Map<SegmentId, AnalysisConfiguration>();

  constructor(provider: AnalysisProvider) {
    this.#provider = provider;
  }

  updateConfiguration(
    segmentId: SegmentId,
    configuration: AnalysisConfiguration,
  ): void {
    this.#configurations.set(
      segmentId,
      copyAnalysisConfiguration(configuration),
    );
  }

  cancelAnalysis(segmentId: SegmentId): void {
    this.#activeRequests.get(segmentId)?.controller.abort();
  }

  async analyze(
    segment: WritingSegment,
    configuration: AnalysisConfiguration,
  ): Promise<AnalysisOutcome> {
    this.updateConfiguration(segment.id, configuration);
    this.#activeRequests.get(segment.id)?.controller.abort();

    const snapshot = captureAnalysisSnapshot(
      segment,
      this.#configurations.get(segment.id)!,
    );
    const activeRequest: ActiveRequest = {
      token: Symbol("analysis-request"),
      controller: new AbortController(),
    };
    this.#activeRequests.set(segment.id, activeRequest);

    try {
      const proposal = await this.#provider.analyze(
        snapshot,
        activeRequest.controller.signal,
      );

      if (this.#isStale(segment, snapshot)) {
        return STALE_OUTCOME;
      }

      if (!this.#isLatest(segment.id, activeRequest)) {
        return ABORTED_OUTCOME;
      }

      const tracks = this.#materializeProposal(segment, snapshot, proposal);
      for (const track of tracks) {
        segment.addDerivedTrack(track);
      }

      return Object.freeze({
        status: "applied" as const,
        appliedTrackIds: Object.freeze(tracks.map((track) => track.id)),
      });
    } catch (error) {
      if (this.#isStale(segment, snapshot)) {
        return STALE_OUTCOME;
      }

      if (!this.#isLatest(segment.id, activeRequest)) {
        return ABORTED_OUTCOME;
      }

      return Object.freeze({ status: "failed" as const, error });
    } finally {
      if (this.#activeRequests.get(segment.id) === activeRequest) {
        this.#activeRequests.delete(segment.id);
      }
    }
  }

  #isLatest(segmentId: SegmentId, request: ActiveRequest): boolean {
    return (
      this.#activeRequests.get(segmentId) === request &&
      !request.controller.signal.aborted
    );
  }

  #isStale(segment: WritingSegment, snapshot: AnalysisSnapshot): boolean {
    const currentConfiguration = this.#configurations.get(segment.id);
    if (currentConfiguration === undefined) {
      return true;
    }

    const currentSnapshot = captureAnalysisSnapshot(
      segment,
      currentConfiguration,
    );
    return !dependencyStampMatches(
      snapshot.dependencyStamp,
      currentSnapshot.dependencyStamp,
    );
  }

  #materializeProposal(
    segment: WritingSegment,
    snapshot: AnalysisSnapshot,
    proposal: AnalysisProposal,
  ): readonly DerivedTrack<unknown>[] {
    const knownTrackIds = new Set<TrackId>([
      segment.sourceTrack.id,
      ...segment.listDerivedTracks().map((track) => track.id),
    ]);
    const tracks: DerivedTrack<unknown>[] = [];

    for (const output of proposal.outputs) {
      this.#validateOutput(output, snapshot, knownTrackIds);
      knownTrackIds.add(output.id);

      const input = {
        id: output.id,
        segmentId: snapshot.segmentId,
        text: output.text,
        provenance: output.provenance,
        dependencyStamp: output.dependencyStamp,
        generationGroupId: output.generationGroupId,
        label: output.label,
        order: output.order,
      };

      tracks.push(
        output.typeId === NATIVE_INTENT_TRACK_TYPE_ID
          ? createNativeIntentTrack(input)
          : createNormalizedTrack(input),
      );
    }

    return tracks;
  }

  #validateOutput(
    output: ProposedDerivedTextTrack,
    snapshot: AnalysisSnapshot,
    knownTrackIds: ReadonlySet<TrackId>,
  ): void {
    if (
      output.typeId !== NATIVE_INTENT_TRACK_TYPE_ID &&
      output.typeId !== NORMALIZED_TRACK_TYPE_ID
    ) {
      throw new TypeError("Only native-intent and normalized outputs are supported.");
    }

    if (output.provenance !== "model") {
      throw new TypeError("Analysis proposals must have model provenance.");
    }

    if (
      !dependencyStampMatches(
        output.dependencyStamp,
        snapshot.dependencyStamp,
      )
    ) {
      throw new TypeError(
        "A proposed output must use the request dependency stamp.",
      );
    }

    if (knownTrackIds.has(output.id)) {
      throw new TypeError("A proposed TrackId already exists in this segment.");
    }
  }
}
