import {
  captureAnalysisSnapshot,
  createWholeAvailableAnalysisContext,
  type AnalysisSnapshot,
} from "@non-native-writing/application";
import {
  WritingSegment,
  asSegmentId,
  asTrackId,
} from "@non-native-writing/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DESKTOP_DEVELOPMENT_CONFIGURATION } from "./desktop-engine-controller.js";
import { DevelopmentAnalysisProvider } from "./development-analysis-provider.js";

function snapshot(sourceText = "Exact 文本"): AnalysisSnapshot {
  const segment = WritingSegment.create({
    id: asSegmentId("development-provider-test"),
    sourceTrackId: asTrackId("development-provider-source"),
    sourceText,
  });
  return captureAnalysisSnapshot(
    segment,
    DESKTOP_DEVELOPMENT_CONFIGURATION,
    createWholeAvailableAnalysisContext(sourceText),
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("DevelopmentAnalysisProvider", () => {
  it("waits for a test-controlled completion and returns deterministic tracks", async () => {
    let release!: () => void;
    const provider = new DevelopmentAnalysisProvider({
      complete: () => new Promise<void>((resolve) => (release = resolve)),
    });
    const resultPromise = provider.analyze(snapshot(), new AbortController().signal);
    let settled = false;
    void resultPromise.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    release();
    const result = await resultPromise;
    expect(result.outputs.map((output) => output.text)).toEqual([
      "The writer means: Exact 文本",
      "Suggested expression: Exact 文本",
    ]);
  });

  it("allows tests to force a provider failure", async () => {
    const provider = new DevelopmentAnalysisProvider({
      complete: async () => {
        throw new Error("test failure");
      },
    });
    await expect(
      provider.analyze(snapshot(), new AbortController().signal),
    ).rejects.toThrow("test failure");
  });

  it("uses no network API for its default deterministic result", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DevelopmentAnalysisProvider({ delayMs: 1 });
    const result = provider.analyze(snapshot(), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toMatchObject({ outputs: [{}, {}] });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
