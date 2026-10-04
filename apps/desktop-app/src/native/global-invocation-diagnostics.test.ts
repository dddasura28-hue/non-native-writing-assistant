import { createHostCapabilities, createTextContext, type AnalysisProvider } from "@non-native-writing/application";
import { NORMALIZED_TRACK_TYPE_ID, asTrackId } from "@non-native-writing/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GlobalDesktopAssistantController } from "../controller/global-desktop-assistant-controller.js";
import { FakeActiveTextSurface } from "../host/fake-active-text-surface.js";
import {
  diagnosticInvocationId,
  formatGlobalDiagnostic,
  traceGlobalInvocation,
} from "./global-invocation-diagnostics.js";
import { TauriWindowsGlobalShortcutBridge } from "./windows-global-shortcut-bridge.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function developmentConsole() {
  vi.stubEnv("DEV", true);
  vi.stubEnv("MODE", "development");
  return vi.spyOn(console, "debug").mockImplementation(() => undefined);
}

describe("source-free global invocation diagnostics", () => {
  it("formats only allowlisted tokens and integer metadata", () => {
    expect(formatGlobalDiagnostic(7, "analysis", "started", {
      utf16Length: 24,
    })).toBe("[global-debug] invocation=7 stage=analysis result=started utf16_length=24");
    expect(formatGlobalDiagnostic("PRIVATE source", "PRIVATE stage" as never, "PRIVATE error" as never, {
      revision: "PRIVATE credential" as never,
      utf16Length: Number.NaN,
      reason: "PRIVATE password" as never,
      sourceText: "PRIVATE source",
      generatedText: "PRIVATE result",
      handle: "PRIVATE handle",
    } as never)).toBe("[global-debug] invocation=- stage=invalid-stage result=invalid-result");
    expect(diagnosticInvocationId({ invocationId: "PRIVATE source" })).toBeNull();
  });

  it("emits nothing in production or ordinary test mode", () => {
    const debug = developmentConsole();
    vi.stubEnv("DEV", false);
    traceGlobalInvocation(7, "analysis", "started");
    vi.stubEnv("DEV", true);
    vi.stubEnv("MODE", "test");
    traceGlobalInvocation(7, "analysis", "started");
    expect(debug).not.toHaveBeenCalled();
  });

  it("traces capture rejection and emit failure without serializing payloads or errors", async () => {
    const debug = developmentConsole();
    let handler: ((event: { payload: unknown }) => void) | null = null;
    const bridge = new TauriWindowsGlobalShortcutBridge(
      vi.fn(async (_name, next) => {
        handler = next;
        return () => undefined;
      }),
      vi.fn(async () => { throw new Error("PRIVATE source or credential"); }),
    );
    const listener = vi.fn();
    await bridge.listenForCaptures(listener);
    const emit = handler as unknown as (event: { payload: unknown }) => void;
    emit({ payload: {
      invocationId: 7,
      response: { status: "unavailable", reason: "protected-field", capture: "PRIVATE password" },
    } });
    emit({ payload: {
      invocationId: 8,
      response: { status: "unavailable", reason: "protected-field" },
    } });
    await expect(bridge.publishPresentation({
      invocationId: 8,
      presentationRevision: 2,
      status: "failed",
      statusMessage: "PRIVATE error",
      sourceText: "PRIVATE source",
      nativeIntentText: "PRIVATE intent",
      normalizedText: "PRIVATE normalized",
      readOnly: true,
    })).rejects.toThrow("PRIVATE");

    const lines = debug.mock.calls.map(([line]) => line);
    expect(lines).toContain("[global-debug] invocation=7 stage=frontend-capture-event result=rejected");
    expect(lines).toContain("[global-debug] invocation=8 stage=frontend-capture-event result=accepted");
    expect(lines).toContain("[global-debug] invocation=8 stage=presentation-event-emit result=failed");
    expect(lines.join("\n")).not.toContain("PRIVATE");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("traces actual controller analysis/presentation without source or generated text", async () => {
    const debug = developmentConsole();
    const source = "PRIVATE 中文 😀 source.";
    const surface = new FakeActiveTextSurface(createTextContext({
      text: source,
      cursorOffset: source.length,
      selection: { start: 0, end: source.length },
      composition: null,
    }), createHostCapabilities({
      canReplaceText: false,
      canObserveComposition: false,
      canObserveSelection: true,
      canProvideSurroundingText: true,
    }));
    const provider: AnalysisProvider = {
      analyze: vi.fn(async (snapshot) => ({ outputs: [{
        id: asTrackId("diagnostic-result"),
        typeId: NORMALIZED_TRACK_TYPE_ID,
        text: "PRIVATE generated result",
        provenance: "model" as const,
        dependencyStamp: snapshot.dependencyStamp,
      }] })),
    };
    const controller = new GlobalDesktopAssistantController(surface, provider, () => undefined);
    await expect(controller.analyzeActiveTextSurface(7)).resolves.toBe("applied");
    await expect(controller.analyzeActiveTextSurface(8, { configurationRequired: true }))
      .resolves.toBe("configuration-required");
    await expect(controller.analyzeActiveTextSurface(7)).resolves.toBe("obsolete");
    controller.dispose();

    const lines = debug.mock.calls.map(([line]) => line);
    expect(lines).toContain("[global-debug] invocation=7 stage=controller-invocation result=started");
    expect(lines).toContain(`[global-debug] invocation=7 stage=analysis result=started utf16_length=${source.length}`);
    expect(lines).toContain("[global-debug] invocation=7 stage=presentation-emitted result=completed");
    expect(lines).toContain("[global-debug] invocation=8 stage=analysis result=skipped reason=configuration-required");
    expect(lines).toContain("[global-debug] invocation=7 stage=invocation-discarded result=stale");
    expect(lines.join("\n")).not.toContain("PRIVATE");
    expect(provider.analyze).toHaveBeenCalledTimes(1);
  });
});
