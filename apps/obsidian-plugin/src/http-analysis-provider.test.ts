import {
  AnalysisCoordinator,
  type AnalysisConfiguration,
  type AnalysisSnapshot,
} from "@non-native-writing/application";
import {
  NATIVE_INTENT_TRACK_TYPE_ID,
  NORMALIZED_TRACK_TYPE_ID,
  WritingSegment,
  asSegmentId,
  asTrackId,
  createDependencyStamp,
} from "@non-native-writing/core";
import { describe, expect, it, vi } from "vitest";

import { HttpAnalysisProvider } from "./http-analysis-provider.js";

const configuration: AnalysisConfiguration = {
  assistPolicyFingerprint: "assist:test",
  styleProfileFingerprint: "style:test",
  languageConfigurationFingerprint: "languages:zh-CN-en",
  processorConfigurationFingerprint: "processor:test",
  targetLanguageId: "en",
  nativeLanguageId: "zh-CN",
};

function createSnapshot(): AnalysisSnapshot {
  return Object.freeze({
    segmentId: asSegmentId("segment-http"),
    sourceTrackId: asTrackId("source-http"),
    sourceText: "I want 写得 clear.",
    beforeContext: "Earlier context.",
    afterContext: "Later context.",
    sourceRevision: 3,
    dependencyStamp: createDependencyStamp({
      sourceRevision: 3,
      assistPolicyFingerprint: configuration.assistPolicyFingerprint,
      styleProfileFingerprint: configuration.styleProfileFingerprint,
      languageConfigurationFingerprint:
        configuration.languageConfigurationFingerprint,
      processorConfigurationFingerprint:
        configuration.processorConfigurationFingerprint,
      contextFingerprint: "context:http-test",
    }),
    confirmedNativeIntent: Object.freeze({
      trackId: asTrackId("confirmed-intent"),
      text: "我想写得清楚。",
      revision: 2,
    }),
    targetLanguageId: "en",
    nativeLanguageId: "zh-CN",
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("HttpAnalysisProvider", () => {
  it("maps a successful response into native-intent and normalized proposals", async () => {
    const fetchImplementation = vi.fn(
      async (_input: string, _init: RequestInit): Promise<Response> =>
        jsonResponse({
          nativeIntent: { text: "我想写得清楚。" },
          normalized: [{ text: "I want to write clearly.", label: null }],
        }),
    );
    const provider = new HttpAnalysisProvider(
      "http://127.0.0.1:8787/v1/analyze",
      fetchImplementation,
    );
    const snapshot = createSnapshot();

    const proposal = await provider.analyze(
      snapshot,
      new AbortController().signal,
    );

    expect(proposal.outputs).toHaveLength(2);
    expect(proposal.outputs[0]).toMatchObject({
      typeId: NATIVE_INTENT_TRACK_TYPE_ID,
      text: "我想写得清楚。",
      provenance: "model",
    });
    expect(proposal.outputs[1]).toMatchObject({
      typeId: NORMALIZED_TRACK_TYPE_ID,
      text: "I want to write clearly.",
      provenance: "model",
      order: 1,
    });

    const [, init] = fetchImplementation.mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body))).toEqual({
      sourceText: snapshot.sourceText,
      beforeContext: snapshot.beforeContext,
      afterContext: snapshot.afterContext,
      nativeLanguageId: "zh-CN",
      targetLanguageId: "en",
      confirmedNativeIntent: { text: "我想写得清楚。" },
    });
  });

  it("maps multiple normalized items to separate proposals in one generation group", async () => {
    const provider = new HttpAnalysisProvider(
      "http://gateway.test/v1/analyze",
      async () =>
        jsonResponse({
          nativeIntent: null,
          normalized: [
            { text: "First expression.", label: "Direct" },
            { text: "Second expression.", label: "Natural" },
          ],
        }),
    );

    const proposal = await provider.analyze(
      createSnapshot(),
      new AbortController().signal,
    );
    const normalized = proposal.outputs.filter(
      (output) => output.typeId === NORMALIZED_TRACK_TYPE_ID,
    );

    expect(normalized).toHaveLength(2);
    expect(normalized[0]?.id).not.toBe(normalized[1]?.id);
    expect(normalized[0]?.generationGroupId).toBe(
      normalized[1]?.generationGroupId,
    );
    expect(normalized.map((output) => output.order)).toEqual([1, 2]);
  });

  it("preserves the request DependencyStamp on every proposal", async () => {
    const snapshot = createSnapshot();
    const provider = new HttpAnalysisProvider(
      "http://gateway.test/v1/analyze",
      async () =>
        jsonResponse({
          nativeIntent: { text: "意图" },
          normalized: [
            { text: "First.", label: null },
            { text: "Second.", label: null },
          ],
        }),
    );

    const proposal = await provider.analyze(
      snapshot,
      new AbortController().signal,
    );

    for (const output of proposal.outputs) {
      expect(output.dependencyStamp).toBe(snapshot.dependencyStamp);
    }
  });

  it("passes AbortSignal to fetch and produces the coordinator's aborted outcome", async () => {
    const observed: { signal?: AbortSignal } = {};
    const fetchImplementation = vi.fn(
      (_input: string, init: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          observed.signal = init.signal as AbortSignal;
          observed.signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const provider = new HttpAnalysisProvider(
      "http://gateway.test/v1/analyze",
      fetchImplementation,
    );
    const coordinator = new AnalysisCoordinator(provider);
    const segment = WritingSegment.create({
      id: asSegmentId("abort-segment"),
      sourceTrackId: asTrackId("abort-source"),
      sourceText: "Pending source",
    });

    const outcome = coordinator.analyze(segment, configuration);
    coordinator.cancelAnalysis(segment.id);

    expect(observed.signal?.aborted).toBe(true);
    await expect(outcome).resolves.toEqual({ status: "aborted" });
    expect(segment.listDerivedTracks()).toHaveLength(0);
  });

  it("turns a non-2xx response into a provider failure", async () => {
    const provider = new HttpAnalysisProvider(
      "http://gateway.test/v1/analyze",
      async () =>
        jsonResponse(
          { error: { code: "analysis_failed", message: "Safe message" } },
          502,
        ),
    );

    await expect(
      provider.analyze(createSnapshot(), new AbortController().signal),
    ).rejects.toThrow(/HTTP 502/);
  });

  it("rejects an invalid gateway response shape", async () => {
    const provider = new HttpAnalysisProvider(
      "http://gateway.test/v1/analyze",
      async () =>
        jsonResponse({
          nativeIntent: null,
          normalized: [],
        }),
    );

    await expect(
      provider.analyze(createSnapshot(), new AbortController().signal),
    ).rejects.toThrow(/invalid response/i);
  });
});
