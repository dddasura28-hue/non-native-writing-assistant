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
  editNativeIntentTrack,
} from "@non-native-writing/core";
import { describe, expect, it } from "vitest";

import {
  AnalysisCoordinator,
  type AnalysisConfiguration,
  type AnalysisProposal,
  type ProposedDerivedTextTrack,
} from "../src/index.js";
import {
  MockAnalysisProvider,
  type PendingAnalysisRequest,
} from "./mock-analysis-provider.js";

const segmentId = asSegmentId("segment-1");

function createSegment(): WritingSegment {
  return WritingSegment.create({
    id: segmentId,
    sourceTrackId: asTrackId("source-1"),
    sourceText: "Draft text",
  });
}

function createConfiguration(
  overrides: Partial<AnalysisConfiguration> = {},
): AnalysisConfiguration {
  return {
    assistPolicyFingerprint: "assist:balanced",
    styleProfileFingerprint: "style:neutral",
    languageConfigurationFingerprint: "languages:zh-en",
    processorConfigurationFingerprint: "processor:normalize:v1",
    targetLanguageId: "en",
    nativeLanguageId: "zh",
    ...overrides,
  };
}

type ProposedOutputInput = Omit<
  ProposedDerivedTextTrack,
  "dependencyStamp" | "provenance"
>;

function proposalFor(
  request: PendingAnalysisRequest,
  outputs: readonly ProposedOutputInput[],
): AnalysisProposal {
  return {
    outputs: outputs.map((output) => ({
      ...output,
      provenance: "model" as const,
      dependencyStamp: request.snapshot.dependencyStamp,
    })),
  };
}

describe("AnalysisCoordinator", () => {
  it("captures an immutable snapshot and applies a normalized proposal", async () => {
    const segment = createSegment();
    const provider = new MockAnalysisProvider();
    const coordinator = new AnalysisCoordinator(provider);
    const outcomePromise = coordinator.analyze(segment, createConfiguration());
    const request = provider.request(0);
    const normalizedId = asTrackId("normalized-1");

    expect(Object.isFrozen(request.snapshot)).toBe(true);
    expect(Object.isFrozen(request.snapshot.dependencyStamp)).toBe(true);
    expect(request.snapshot.sourceTrackId).toBe(segment.sourceTrack.id);
    expect(request.snapshot.sourceText).toBe(segment.sourceText);

    request.resolve(
      proposalFor(request, [
        {
          id: normalizedId,
          typeId: NORMALIZED_TRACK_TYPE_ID,
          text: "Normalized text",
        },
      ]),
    );

    await expect(outcomePromise).resolves.toEqual({
      status: "applied",
      appliedTrackIds: [normalizedId],
    });
    expect(segment.findTracksByType(NORMALIZED_TRACK_TYPE_ID)).toHaveLength(1);
  });

  it("applies native intent and multiple normalized outputs from one request", async () => {
    const segment = createSegment();
    const provider = new MockAnalysisProvider();
    const coordinator = new AnalysisCoordinator(provider);
    const outcomePromise = coordinator.analyze(segment, createConfiguration());
    const request = provider.request(0);
    const generationGroupId = asGenerationGroupId("generation-1");

    request.resolve(
      proposalFor(request, [
        {
          id: asTrackId("intent-1"),
          typeId: NATIVE_INTENT_TRACK_TYPE_ID,
          text: "Native intent",
        },
        {
          id: asTrackId("normalized-a"),
          typeId: NORMALIZED_TRACK_TYPE_ID,
          text: "Normalized A",
          generationGroupId,
          label: "A",
          order: 1,
        },
        {
          id: asTrackId("normalized-b"),
          typeId: NORMALIZED_TRACK_TYPE_ID,
          text: "Normalized B",
          generationGroupId,
          label: "B",
          order: 2,
        },
      ]),
    );

    await expect(outcomePromise).resolves.toMatchObject({ status: "applied" });
    expect(segment.findTracksByType(NATIVE_INTENT_TRACK_TYPE_ID)).toHaveLength(
      1,
    );
    expect(segment.findTracksByType(NORMALIZED_TRACK_TYPE_ID)).toHaveLength(2);
  });

  it("rejects a result as stale when source changes while it is pending", async () => {
    const segment = createSegment();
    const provider = new MockAnalysisProvider();
    const coordinator = new AnalysisCoordinator(provider);
    const outcomePromise = coordinator.analyze(segment, createConfiguration());
    const request = provider.request(0);

    segment.updateSourceText("Source revision 2");
    request.resolve(
      proposalFor(request, [
        {
          id: asTrackId("stale-normalized"),
          typeId: NORMALIZED_TRACK_TYPE_ID,
          text: "Stale output",
        },
      ]),
    );

    await expect(outcomePromise).resolves.toEqual({ status: "stale" });
    expect(segment.listDerivedTracks()).toHaveLength(0);
  });

  it("applies request B first and rejects late request A even when cancellation is ignored", async () => {
    const segment = createSegment();
    const provider = new MockAnalysisProvider();
    const coordinator = new AnalysisCoordinator(provider);
    const requestAPromise = coordinator.analyze(segment, createConfiguration());
    const requestA = provider.request(0);

    segment.updateSourceText("Source revision 2");
    const requestBPromise = coordinator.analyze(segment, createConfiguration());
    const requestB = provider.request(1);

    expect(requestA.signal.aborted).toBe(true);

    requestB.resolve(
      proposalFor(requestB, [
        {
          id: asTrackId("normalized-b"),
          typeId: NORMALIZED_TRACK_TYPE_ID,
          text: "Current B output",
        },
      ]),
    );
    await expect(requestBPromise).resolves.toMatchObject({ status: "applied" });

    requestA.resolve(
      proposalFor(requestA, [
        {
          id: asTrackId("normalized-a"),
          typeId: NORMALIZED_TRACK_TYPE_ID,
          text: "Late A output",
        },
      ]),
    );
    await expect(requestAPromise).resolves.toEqual({ status: "stale" });

    expect(segment.findTracksByType(NORMALIZED_TRACK_TYPE_ID)).toHaveLength(1);
    expect(
      segment
        .findTracksByType(NORMALIZED_TRACK_TYPE_ID)
        .map((track) => track.id),
    ).toEqual([asTrackId("normalized-b")]);
  });

  it("aborts a superseded same-dependency request without relying on provider rejection", async () => {
    const segment = createSegment();
    const provider = new MockAnalysisProvider();
    const coordinator = new AnalysisCoordinator(provider);
    const requestAPromise = coordinator.analyze(segment, createConfiguration());
    const requestA = provider.request(0);
    const requestBPromise = coordinator.analyze(segment, createConfiguration());
    const requestB = provider.request(1);

    expect(requestA.signal.aborted).toBe(true);

    requestA.resolve(
      proposalFor(requestA, [
        {
          id: asTrackId("aborted-a"),
          typeId: NORMALIZED_TRACK_TYPE_ID,
          text: "Should not apply",
        },
      ]),
    );
    await expect(requestAPromise).resolves.toEqual({ status: "aborted" });
    expect(segment.listDerivedTracks()).toHaveLength(0);

    requestB.resolve(proposalFor(requestB, []));
    await expect(requestBPromise).resolves.toEqual({
      status: "applied",
      appliedTrackIds: [],
    });
  });

  it("includes only a current user-confirmed native intent in snapshots", async () => {
    const segment = createSegment();
    const configuration = createConfiguration();
    const inferred = createNativeIntentTrack({
      id: asTrackId("intent-1"),
      segmentId,
      text: "Inferred intent",
      provenance: "model",
      dependencyStamp: createDependencyStamp({
        sourceRevision: segment.sourceTrack.revision,
        assistPolicyFingerprint: configuration.assistPolicyFingerprint,
        styleProfileFingerprint: configuration.styleProfileFingerprint,
        languageConfigurationFingerprint:
          configuration.languageConfigurationFingerprint,
        processorConfigurationFingerprint:
          configuration.processorConfigurationFingerprint,
      }),
    });
    const confirmed = editNativeIntentTrack(
      inferred,
      "User-confirmed intent",
      segment.sourceTrack.revision,
    );
    segment.addDerivedTrack(confirmed);
    const provider = new MockAnalysisProvider();
    const coordinator = new AnalysisCoordinator(provider);

    const firstOutcome = coordinator.analyze(segment, configuration);
    const firstRequest = provider.request(0);
    expect(firstRequest.snapshot.confirmedNativeIntent).toEqual({
      trackId: confirmed.id,
      text: "User-confirmed intent",
      revision: confirmed.revision,
    });
    expect(
      firstRequest.snapshot.dependencyStamp.confirmedNativeIntentRevision,
    ).toBe(confirmed.revision);
    firstRequest.resolve(proposalFor(firstRequest, []));
    await firstOutcome;

    segment.updateSourceText("Source revision 2");
    const secondOutcome = coordinator.analyze(segment, configuration);
    const secondRequest = provider.request(1);
    expect(secondRequest.snapshot.confirmedNativeIntent).toBeUndefined();
    expect(
      secondRequest.snapshot.dependencyStamp.confirmedNativeIntentRevision,
    ).toBeUndefined();
    secondRequest.resolve(proposalFor(secondRequest, []));
    await secondOutcome;
  });

  it("rejects a result when a non-source configuration dependency changes", async () => {
    const segment = createSegment();
    const provider = new MockAnalysisProvider();
    const coordinator = new AnalysisCoordinator(provider);
    const outcomePromise = coordinator.analyze(segment, createConfiguration());
    const request = provider.request(0);

    coordinator.updateConfiguration(
      segment.id,
      createConfiguration({ styleProfileFingerprint: "style:formal" }),
    );
    request.resolve(
      proposalFor(request, [
        {
          id: asTrackId("stale-style-output"),
          typeId: NORMALIZED_TRACK_TYPE_ID,
          text: "Wrong style",
        },
      ]),
    );

    await expect(outcomePromise).resolves.toEqual({ status: "stale" });
    expect(segment.listDerivedTracks()).toHaveLength(0);
  });

  it("returns failed and leaves core state unchanged when the provider rejects", async () => {
    const segment = createSegment();
    const provider = new MockAnalysisProvider();
    const coordinator = new AnalysisCoordinator(provider);
    const outcomePromise = coordinator.analyze(segment, createConfiguration());
    const request = provider.request(0);
    const failure = new Error("Provider failed");

    request.reject(failure);

    await expect(outcomePromise).resolves.toEqual({
      status: "failed",
      error: failure,
    });
    expect(segment.listDerivedTracks()).toHaveLength(0);
    expect(segment).not.toHaveProperty("error");
  });

  it("rejects source-type proposals without changing source or derived tracks", async () => {
    const segment = createSegment();
    const originalSource = segment.sourceTrack;
    const provider = new MockAnalysisProvider();
    const coordinator = new AnalysisCoordinator(provider);
    const outcomePromise = coordinator.analyze(segment, createConfiguration());
    const request = provider.request(0);

    request.resolve(
      proposalFor(request, [
        {
          id: asTrackId("invalid-source"),
          typeId: SOURCE_TRACK_TYPE_ID,
          text: "Must not become source",
        },
      ]),
    );

    await expect(outcomePromise).resolves.toMatchObject({ status: "failed" });
    expect(segment.sourceTrack).toBe(originalSource);
    expect(segment.listDerivedTracks()).toHaveLength(0);
  });
});
