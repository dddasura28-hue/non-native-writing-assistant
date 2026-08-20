import {
  WritingSegment,
  asSegmentId,
  asTrackId,
  createDependencyStamp,
  createNativeIntentTrack,
  createNormalizedTrack,
} from "@non-native-writing/core";
import { describe, expect, it } from "vitest";

import { createViewModel, statusForOutcome } from "./presentation.js";

const segmentId = asSegmentId("presentation-segment");
const stamp = createDependencyStamp({
  sourceRevision: 1,
  assistPolicyFingerprint: "assist:test",
  styleProfileFingerprint: "style:test",
  languageConfigurationFingerprint: "language:test",
  processorConfigurationFingerprint: "processor:test",
  contextFingerprint: "context:presentation-test",
});

function createSegment(): WritingSegment {
  return WritingSegment.create({
    id: segmentId,
    sourceTrackId: asTrackId("presentation-source"),
    sourceText: "Mixed source 文本",
  });
}

describe("writing assistant presentation", () => {
  it("maps multiple normalized tracks to separate entries identified by TrackId", () => {
    const segment = createSegment();
    const first = createNormalizedTrack({
      id: asTrackId("normalized-first"),
      segmentId,
      text: "First normalized expression",
      provenance: "model",
      dependencyStamp: stamp,
      label: "First",
      order: 2,
    });
    const second = createNormalizedTrack({
      id: asTrackId("normalized-second"),
      segmentId,
      text: "Second normalized expression",
      provenance: "model",
      dependencyStamp: stamp,
      label: "Second",
      order: 1,
    });
    segment.addDerivedTrack(first);
    segment.addDerivedTrack(second);

    const viewModel = createViewModel(segment, "Applied", [
      first.id,
      second.id,
    ]);

    expect(viewModel.normalizedTracks).toEqual([
      expect.objectContaining({ id: second.id, text: second.payload.text }),
      expect.objectContaining({ id: first.id, text: first.payload.text }),
    ]);
  });

  it("handles a missing native-intent track without hiding other content", () => {
    const segment = createSegment();
    const normalized = createNormalizedTrack({
      id: asTrackId("normalized-only"),
      segmentId,
      text: "Normalized only",
      provenance: "model",
      dependencyStamp: stamp,
    });
    segment.addDerivedTrack(normalized);

    const viewModel = createViewModel(segment, "Applied", [normalized.id]);

    expect(viewModel.sourceText).toBe("Mixed source 文本");
    expect(viewModel.nativeIntentTracks).toEqual([]);
    expect(viewModel.normalizedTracks).toHaveLength(1);
  });

  it("maps every coordinator outcome to a deterministic status", () => {
    expect(statusForOutcome({ status: "applied", appliedTrackIds: [] })).toBe(
      "Applied",
    );
    expect(statusForOutcome({ status: "stale" })).toBe("Stale");
    expect(statusForOutcome({ status: "aborted" })).toBe("Aborted");
    expect(statusForOutcome({ status: "failed", error: new Error() })).toBe(
      "Failed",
    );
  });

  it("maps native-intent output without requiring it to exist", () => {
    const segment = createSegment();
    const intent = createNativeIntentTrack({
      id: asTrackId("intent-one"),
      segmentId,
      text: "Native intent",
      provenance: "model",
      dependencyStamp: stamp,
    });
    segment.addDerivedTrack(intent);

    const viewModel = createViewModel(segment, "Applied", [intent.id]);

    expect(viewModel.nativeIntentTracks).toEqual([
      expect.objectContaining({ id: intent.id, text: "Native intent" }),
    ]);
  });
});
