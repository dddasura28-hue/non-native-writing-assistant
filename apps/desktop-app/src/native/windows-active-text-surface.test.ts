import type {
  AnalysisProposal,
  AnalysisProvider,
  AnalysisSnapshot,
} from "@non-native-writing/application";
import {
  NATIVE_INTENT_TRACK_TYPE_ID,
  NORMALIZED_TRACK_TYPE_ID,
  asGenerationGroupId,
  asTrackId,
} from "@non-native-writing/core";
import { describe, expect, it } from "vitest";

import {
  GlobalDesktopAssistantController,
  type GlobalDesktopAssistantPresentation,
} from "../controller/global-desktop-assistant-controller.js";
import {
  WindowsActiveTextSurfacePort,
  type NativeWindowsCaptureResponse,
} from "./windows-active-text-surface.js";

function captured(
  text = "A😀B",
  overrides: Partial<Extract<
    NativeWindowsCaptureResponse,
    { readonly status: "captured" }
  >["capture"]> = {},
): NativeWindowsCaptureResponse {
  return {
    status: "captured",
    capture: {
      text,
      cursorOffset: text.length,
      selection: null,
      capabilities: {
        canReplaceText: false,
        canObserveComposition: false,
        canObserveSelection: true,
        canProvideSurroundingText: true,
      },
      captureToken: "opaque-capture-1",
      ...overrides,
    },
  };
}

function portWith(response: NativeWindowsCaptureResponse) {
  const port = new WindowsActiveTextSurfacePort();
  port.stage(response);
  return port;
}

class ImmediateProvider implements AnalysisProvider {
  readonly snapshots: AnalysisSnapshot[] = [];

  async analyze(snapshot: AnalysisSnapshot): Promise<AnalysisProposal> {
    this.snapshots.push(snapshot);
    const group = asGenerationGroupId(`windows-group-${this.snapshots.length}`);
    return {
      outputs: [
        {
          id: asTrackId(`windows-native-${this.snapshots.length}`),
          typeId: NATIVE_INTENT_TRACK_TYPE_ID,
          text: "Captured meaning",
          provenance: "model",
          dependencyStamp: snapshot.dependencyStamp,
          generationGroupId: group,
        },
        {
          id: asTrackId(`windows-normalized-${this.snapshots.length}`),
          typeId: NORMALIZED_TRACK_TYPE_ID,
          text: "Normalized wording",
          provenance: "model",
          dependencyStamp: snapshot.dependencyStamp,
          generationGroupId: group,
        },
      ],
    };
  }
}

class DeferredProvider implements AnalysisProvider {
  readonly requests: Array<{
    readonly snapshot: AnalysisSnapshot;
    readonly resolve: (proposal: AnalysisProposal) => void;
  }> = [];

  analyze(snapshot: AnalysisSnapshot): Promise<AnalysisProposal> {
    return new Promise((resolve) => this.requests.push({ snapshot, resolve }));
  }

  complete(index: number, text: string): void {
    const request = this.requests[index]!;
    request.resolve({
      outputs: [{
        id: asTrackId(`windows-deferred-${index}`),
        typeId: NORMALIZED_TRACK_TYPE_ID,
        text,
        provenance: "model",
        dependencyStamp: request.snapshot.dependencyStamp,
      }],
    });
  }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

describe("WindowsActiveTextSurfacePort", () => {
  it("maps the minimal native payload into an ActiveTextSurfaceCapture", async () => {
    const port = portWith(captured());

    const capture = await port.capture();

    expect(capture).toEqual({
      context: {
        text: "A😀B",
        cursorOffset: 4,
        selection: null,
        composition: null,
      },
      capabilities: {
        canReplaceText: false,
        canObserveComposition: false,
        canObserveSelection: true,
        canProvideSurroundingText: true,
      },
      editPort: null,
    });
    expect(capture).not.toHaveProperty("captureToken");
  });

  it("preserves an exact selected-only capture window", async () => {
    const response = captured("This have issue. It cost too much.", {
      cursorOffset: 34,
      selection: { start: 0, end: 34 },
      capabilities: {
        canReplaceText: false,
        canObserveComposition: false,
        canObserveSelection: true,
        canProvideSurroundingText: false,
      },
    });
    const port = portWith(response);

    const capture = await port.capture();

    expect(capture?.context.selection).toEqual({ start: 0, end: 34 });
    expect(capture?.capabilities.canProvideSurroundingText).toBe(false);
  });

  it("keeps composition observation false and rejects inflated native claims", async () => {
    const response = captured("text", {
      capabilities: {
        canReplaceText: false,
        canObserveComposition: true,
        canObserveSelection: true,
        canProvideSurroundingText: true,
      },
    });
    const port = portWith(response);

    await expect(port.capture()).resolves.toBeNull();
    expect(port.lastUnavailableReason).toBe("native-uia-unavailable");
  });

  it("maps protected and unsupported fields to unavailable captures", async () => {
    for (const reason of ["protected-field", "unsupported-text-pattern"] as const) {
      const port = portWith({ status: "unavailable", reason });
      await expect(port.capture()).resolves.toBeNull();
      expect(port.lastUnavailableReason).toBe(reason);
    }
  });

  it("consumes a staged native snapshot exactly once", async () => {
    const port = portWith(captured("one-shot"));

    await expect(port.capture()).resolves.toMatchObject({
      context: { text: "one-shot" },
    });
    await expect(port.capture()).resolves.toBeNull();
  });

  it("runs manual global analysis through the existing controller as read-only", async () => {
    const port = portWith(captured("This method have problem."));
    const provider = new ImmediateProvider();
    const presentations: GlobalDesktopAssistantPresentation[] = [];
    const controller = new GlobalDesktopAssistantController(
      port,
      provider,
      (presentation) => presentations.push(presentation),
    );

    await expect(controller.analyzeActiveTextSurface()).resolves.toBe("applied");

    expect(provider.snapshots[0]?.sourceText).toBe("This method have problem.");
    const latest = presentations.at(-1)!;
    expect(latest.readOnly).toBe(true);
    expect(latest.automaticRealtimeAllowed).toBe(false);
    expect(latest.assistance.active?.normalizedTracks[0]).toMatchObject({
      text: "Normalized wording",
      canAccept: false,
      acceptTarget: null,
    });
  });

  it("never sends protected text to the analysis provider", async () => {
    const provider = new ImmediateProvider();
    const controller = new GlobalDesktopAssistantController(
      portWith({
        status: "unavailable",
        reason: "protected-field",
      }),
      provider,
      () => undefined,
    );

    await expect(controller.analyzeActiveTextSurface()).resolves.toBe("unavailable");
    expect(provider.snapshots).toEqual([]);
  });

  it("strips native metadata before constructing the model request", async () => {
    const response = captured("External source") as NativeWindowsCaptureResponse & {
      capture: { processId: number; windowTitle: string; runtimeId: number[] };
    };
    Object.assign(response.capture, {
      processId: 42,
      windowTitle: "Private document",
      runtimeId: [1, 2, 3],
    });
    const provider = new ImmediateProvider();
    const controller = new GlobalDesktopAssistantController(
      portWith(response),
      provider,
      () => undefined,
    );

    await controller.analyzeActiveTextSurface();

    const request = JSON.stringify(provider.snapshots[0]);
    expect(request).not.toContain("processId");
    expect(request).not.toContain("windowTitle");
    expect(request).not.toContain("runtimeId");
    expect(request).not.toContain("opaque-capture-1");
  });

  it("fresh manual actions always invoke a fresh Windows capture", async () => {
    const port = new WindowsActiveTextSurfacePort();
    const provider = new ImmediateProvider();
    const presentations: GlobalDesktopAssistantPresentation[] = [];
    const controller = new GlobalDesktopAssistantController(
      port,
      provider,
      (presentation) => presentations.push(presentation),
    );

    port.stage(captured("host 1", { captureToken: "opaque-1" }));
    await controller.analyzeActiveTextSurface();
    port.stage(captured("host 2", { captureToken: "opaque-2" }));
    await controller.analyzeActiveTextSurface();

    expect(provider.snapshots.map((snapshot) => snapshot.sourceText)).toEqual([
      "host 1",
      "host 2",
    ]);
    expect(presentations.at(-1)?.sourceText).toBe("host 2");
  });

  it("same text from a new capture supersedes the old Windows invocation", async () => {
    const port = new WindowsActiveTextSurfacePort();
    const provider = new DeferredProvider();
    const presentations: GlobalDesktopAssistantPresentation[] = [];
    const controller = new GlobalDesktopAssistantController(
      port,
      provider,
      (presentation) => presentations.push(presentation),
    );

    port.stage(captured("identical text", { captureToken: "session-1" }));
    const first = controller.analyzeActiveTextSurface();
    await flush();
    port.stage(captured("identical text", { captureToken: "session-2" }));
    const second = controller.analyzeActiveTextSurface();
    await flush();
    provider.complete(1, "new session result");
    await expect(second).resolves.toBe("applied");
    provider.complete(0, "obsolete session result");
    await expect(first).resolves.toBe("obsolete");
    await flush();

    expect(presentations.at(-1)?.assistance.active?.normalizedTracks[0]?.text)
      .toBe("new session result");
    expect(JSON.stringify(presentations.at(-1))).not.toContain(
      "obsolete session result",
    );
  });

  it("cleanup blocks late Windows provider callbacks", async () => {
    const provider = new DeferredProvider();
    const presentations: GlobalDesktopAssistantPresentation[] = [];
    const controller = new GlobalDesktopAssistantController(
      portWith(captured("late source")),
      provider,
      (presentation) => presentations.push(presentation),
    );

    const pending = controller.analyzeActiveTextSurface();
    await flush();
    controller.dispose();
    const presentationCount = presentations.length;
    provider.complete(0, "late result");
    await expect(pending).resolves.toBe("obsolete");
    await flush();

    expect(presentations).toHaveLength(presentationCount);
  });

  it("cannot expose write success because UIA v1 supplies no edit port", async () => {
    const provider = new ImmediateProvider();
    const presentations: GlobalDesktopAssistantPresentation[] = [];
    const controller = new GlobalDesktopAssistantController(
      portWith(captured("same text")),
      provider,
      (presentation) => presentations.push(presentation),
    );
    await controller.analyzeActiveTextSurface();

    expect(presentations.at(-1)?.guardedAcceptAllowed).toBe(false);
    expect(presentations.at(-1)?.assistance.active?.normalizedTracks[0]?.acceptTarget)
      .toBeNull();
  });
});
