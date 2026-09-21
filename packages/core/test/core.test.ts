import { describe, expect, it } from "vitest";

import {
  NATIVE_INTENT_TRACK_TYPE_ID,
  NORMALIZED_TRACK_TYPE_ID,
  SOURCE_TRACK_TYPE_ID,
  WritingSegment,
  asGenerationGroupId,
  asSegmentId,
  asTrackId,
  createDependencyStamp,
  createNativeIntentTrack,
  createNormalizedTrack,
  createSegmentRange,
  dependencyStampMatches,
  editNativeIntentTrack,
  isConfirmedNativeIntentValid,
} from "../src/index.js";
import type { DependencyStamp, DerivedTrack } from "../src/index.js";

const segmentId = asSegmentId("segment-1");

function createSegment(): WritingSegment {
  return WritingSegment.create({
    id: segmentId,
    sourceTrackId: asTrackId("source-1"),
    sourceText: "Draft text",
  });
}

function createStamp(sourceRevision = 1): DependencyStamp {
  return createDependencyStamp({
    sourceRevision,
    assistPolicyFingerprint: "assist:balanced",
    styleProfileFingerprint: "style:neutral",
    languageConfigurationFingerprint: "languages:zh-en",
    processorConfigurationFingerprint: "processor:normalized:v1",
    contextFingerprint: "context:whole",
  });
}

function createNormalized(
  id: string,
  generationGroupId?: ReturnType<typeof asGenerationGroupId>,
) {
  return createNormalizedTrack({
    id: asTrackId(id),
    segmentId,
    text: id,
    provenance: "model",
    dependencyStamp: createStamp(),
    generationGroupId,
  });
}

describe("WritingSegment", () => {
  it("always has exactly one source track", () => {
    const segment = createSegment();

    expect(segment.sourceTrack.typeId).toBe(SOURCE_TRACK_TYPE_ID);
    expect(segment.findTracksByType(SOURCE_TRACK_TYPE_ID)).toHaveLength(1);

    const invalidSecondSource: DerivedTrack<{ readonly text: string }> = {
      id: asTrackId("source-2"),
      segmentId,
      typeId: SOURCE_TRACK_TYPE_ID,
      payload: { text: "Not allowed" },
      provenance: "model",
      revision: 1,
      dependencyStamp: createStamp(),
    };

    expect(() => segment.addDerivedTrack(invalidSecondSource)).toThrow(
      /source track/i,
    );
    expect(segment.findTracksByType(SOURCE_TRACK_TYPE_ID)).toHaveLength(1);
  });

  it("allows multiple normalized tracks to coexist", () => {
    const segment = createSegment();
    segment.addDerivedTrack(createNormalized("normalized-a"));
    segment.addDerivedTrack(createNormalized("normalized-b"));
    segment.addDerivedTrack(createNormalized("normalized-c"));

    expect(segment.findTracksByType(NORMALIZED_TRACK_TYPE_ID)).toHaveLength(3);
  });

  it("allows normalized tracks to share a generation group but not a TrackId", () => {
    const segment = createSegment();
    const groupId = asGenerationGroupId("generation-1");
    const first = createNormalized("normalized-a", groupId);
    const second = createNormalized("normalized-b", groupId);

    segment.addDerivedTrack(first);
    segment.addDerivedTrack(second);

    expect(first.id).not.toBe(second.id);
    expect(first.generationGroupId).toBe(groupId);
    expect(second.generationGroupId).toBe(groupId);
  });

  it("rejects a duplicate derived TrackId without replacing the original", () => {
    const segment = createSegment();
    const original = createNormalized("normalized-a");
    const duplicate = createNormalized("normalized-a");

    segment.addDerivedTrack(original);

    expect(() => segment.addDerivedTrack(duplicate)).toThrow(/TrackId/i);
    expect(segment.listDerivedTracks()).toEqual([original]);
  });

  it("preserves source identity and increments revision when text changes", () => {
    const segment = createSegment();
    const sourceId = segment.sourceTrack.id;
    const previousRevision = segment.sourceTrack.revision;

    segment.updateSourceText("Revised draft text");

    expect(segment.sourceTrack.id).toBe(sourceId);
    expect(segment.sourceTrack.revision).toBe(previousRevision + 1);
    expect(segment.sourceText).toBe("Revised draft text");
  });

  it("does not increment source revision when text is unchanged", () => {
    const segment = createSegment();
    const sourceTrack = segment.sourceTrack;

    const result = segment.updateSourceText(segment.sourceText);

    expect(result).toBe(sourceTrack);
    expect(segment.sourceTrack.revision).toBe(sourceTrack.revision);
  });

  it("does not expose its internal derived-track collection", () => {
    const segment = createSegment();
    const normalized = createNormalized("normalized-a");
    segment.addDerivedTrack(normalized);

    const listed = segment.listDerivedTracks() as DerivedTrack<unknown>[];
    const found = segment.findTracksByType(
      NORMALIZED_TRACK_TYPE_ID,
    ) as DerivedTrack<unknown>[];
    listed.length = 0;
    found.length = 0;

    expect(segment.listDerivedTracks()).toEqual([normalized]);
    expect(segment.findTracksByType(NORMALIZED_TRACK_TYPE_ID)).toEqual([
      normalized,
    ]);
  });
});

describe("confirmed native intent", () => {
  function createConfirmedIntent() {
    const inferred = createNativeIntentTrack({
      id: asTrackId("intent-1"),
      segmentId,
      text: "Inferred intent",
      provenance: "model",
      dependencyStamp: createStamp(1),
    });

    return editNativeIntentTrack(inferred, "Confirmed intent", 1);
  }

  it("is valid against the source revision from which it was confirmed", () => {
    const confirmed = createConfirmedIntent();

    expect(confirmed.typeId).toBe(NATIVE_INTENT_TRACK_TYPE_ID);
    expect(confirmed.provenance).toBe("user-edited-model");
    expect(isConfirmedNativeIntentValid(confirmed, 1)).toBe(true);
  });

  it("does not treat model-generated native intent as user-confirmed", () => {
    const inferred = createNativeIntentTrack({
      id: asTrackId("intent-model"),
      segmentId,
      text: "Inferred intent",
      provenance: "model",
      dependencyStamp: createStamp(1),
    });

    expect(isConfirmedNativeIntentValid(inferred, 1)).toBe(false);
  });

  it("becomes stale after the source revision changes", () => {
    const segment = createSegment();
    const confirmed = createConfirmedIntent();

    segment.updateSourceText("A later source revision");

    expect(
      isConfirmedNativeIntentValid(confirmed, segment.sourceTrack.revision),
    ).toBe(false);
  });

  it("confirms an inferred track in place and preserves exact multiline text", () => {
    const segment = createSegment();
    const inferred = createNativeIntentTrack({
      id: asTrackId("intent-exact"),
      segmentId,
      text: "Inferred",
      provenance: "model",
      dependencyStamp: createStamp(),
    });
    segment.addDerivedTrack(inferred);
    const sourceBefore = segment.sourceTrack;
    const exact = "第一段 😀\n\n1. 保留 punctuation!\n2. final line  ";

    const confirmed = segment.confirmNativeIntent(
      inferred.id,
      exact,
      sourceBefore.revision,
      inferred.revision,
    );

    expect(confirmed?.payload.text).toBe(exact);
    expect(confirmed?.provenance).toBe("user-edited-model");
    expect(confirmed?.revision).toBe(inferred.revision + 1);
    expect(confirmed?.dependencyStamp.sourceRevision).toBe(sourceBefore.revision);
    expect(segment.sourceTrack).toBe(sourceBefore);
    expect(segment.sourceText).toBe("Draft text");
  });

  it("rejects a confirmation captured against an obsolete source revision", () => {
    const segment = createSegment();
    const inferred = createNativeIntentTrack({
      id: asTrackId("intent-stale-source"),
      segmentId,
      text: "Inferred",
      provenance: "model",
      dependencyStamp: createStamp(),
    });
    segment.addDerivedTrack(inferred);
    segment.updateSourceText("Changed source");

    expect(
      segment.confirmNativeIntent(inferred.id, "Too late", 1, inferred.revision),
    ).toBeNull();
    expect(segment.listDerivedTracks()).toEqual([inferred]);
  });

  it("rejects a confirmation captured against an obsolete intent revision", () => {
    const segment = createSegment();
    const inferred = createNativeIntentTrack({
      id: asTrackId("intent-stale-track"),
      segmentId,
      text: "Inferred",
      provenance: "model",
      dependencyStamp: createStamp(),
    });
    segment.addDerivedTrack(inferred);

    expect(
      segment.confirmNativeIntent(inferred.id, "Too late", 1, 99),
    ).toBeNull();
    expect(segment.listDerivedTracks()).toEqual([inferred]);
  });
});

describe("DependencyStamp", () => {
  it("treats identical stamps as equal and current", () => {
    const resultStamp = createStamp(1);
    const currentStamp = createStamp(1);

    expect(dependencyStampMatches(resultStamp, currentStamp)).toBe(true);
  });

  it("rejects stamps that differ only by source revision", () => {
    const resultStamp = createStamp(1);
    const currentStamp = createStamp(2);

    expect(dependencyStampMatches(resultStamp, currentStamp)).toBe(false);
  });

  it("compares every dependency field, including confirmed-intent presence", () => {
    const baseline = createStamp(1);
    const mismatches: DependencyStamp[] = [
      createDependencyStamp({ ...baseline, confirmedNativeIntentRevision: 1 }),
      createDependencyStamp({
        ...baseline,
        assistPolicyFingerprint: "assist:different",
      }),
      createDependencyStamp({
        ...baseline,
        styleProfileFingerprint: "style:different",
      }),
      createDependencyStamp({
        ...baseline,
        languageConfigurationFingerprint: "languages:different",
      }),
      createDependencyStamp({
        ...baseline,
        processorConfigurationFingerprint: "processor:different",
      }),
      createDependencyStamp({
        ...baseline,
        contextFingerprint: "context:different",
      }),
    ];

    for (const mismatch of mismatches) {
      expect(dependencyStampMatches(baseline, mismatch)).toBe(false);
      expect(dependencyStampMatches(mismatch, baseline)).toBe(false);
    }
  });
});

describe("SegmentRange", () => {
  it("accepts valid UTF-16 half-open ranges", () => {
    expect(createSegmentRange(0, 4)).toEqual({ start: 0, end: 4 });
    expect(createSegmentRange(3, 3)).toEqual({ start: 3, end: 3 });
  });

  it("rejects a negative start", () => {
    expect(() => createSegmentRange(-1, 2)).toThrow(RangeError);
  });

  it("rejects an end before start", () => {
    expect(() => createSegmentRange(3, 2)).toThrow(RangeError);
  });

  it("rejects fractional offsets", () => {
    expect(() => createSegmentRange(0.5, 2)).toThrow(RangeError);
    expect(() => createSegmentRange(0, 1.5)).toThrow(RangeError);
  });

  it("rejects NaN and infinite offsets", () => {
    for (const invalid of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(() => createSegmentRange(invalid, 2)).toThrow(RangeError);
      expect(() => createSegmentRange(0, invalid)).toThrow(RangeError);
    }
  });
});

describe("core state boundaries", () => {
  it("does not place UI visibility, loading, error, or selection state on tracks or segments", () => {
    const segment = createSegment();
    const source = segment.sourceTrack;
    const derived = createNormalized("normalized-a");

    for (const value of [segment, source, derived]) {
      expect(value).not.toHaveProperty("visible");
      expect(value).not.toHaveProperty("loading");
      expect(value).not.toHaveProperty("error");
      expect(value).not.toHaveProperty("selected");
    }
  });
});
