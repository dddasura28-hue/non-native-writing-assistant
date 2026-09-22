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
import { describe, expect, it, vi } from "vitest";

import {
  GlobalDesktopAssistantController,
  type GlobalDesktopAssistantPresentation,
} from "../controller/global-desktop-assistant-controller.js";
import type { NativeInvoke } from "./native-command-client.js";
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

function nativeInvoke(
  implementation: () => Promise<NativeWindowsCaptureResponse>,
): { readonly invoke: NativeInvoke; readonly mock: ReturnType<typeof vi.fn> } {
  const mock = vi.fn(implementation);
  return {
    invoke: <T>() => mock() as Promise<T>,
    mock,
  };
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
    const { invoke, mock } = nativeInvoke(async () => captured());
    const port = new WindowsActiveTextSurfacePort(invoke);

    const capture = await port.capture();

    expect(mock).toHaveBeenCalledOnce();
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
    const port = new WindowsActiveTextSurfacePort(
      nativeInvoke(async () => response).invoke,
    );

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
    const port = new WindowsActiveTextSurfacePort(
      nativeInvoke(async () => response).invoke,
    );

    await expect(port.capture()).resolves.toBeNull();
    expect(port.lastUnavailableReason).toBe("native-uia-unavailable");
  });

  it("maps protected and unsupported fields to unavailable captures", async () => {
    for (const reason of ["protected-field", "unsupported-text-pattern"] as const) {
      const port = new WindowsActiveTextSurfacePort(
        nativeInvoke(async () => ({ status: "unavailable", reason })).invoke,
      );
      await expect(port.capture()).resolves.toBeNull();
      expect(port.lastUnavailableReason).toBe(reason);
    }
  });

  it("runs manual global analysis through the existing controller as read-only", async () => {
    const port = new WindowsActiveTextSurfacePort(
      nativeInvoke(async () => captured("This method have problem.")).invoke,
    );
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
      new WindowsActiveTextSurfacePort(
        nativeInvoke(async () => ({
          status: "unavailable",
          reason: "protected-field",
        })).invoke,
      ),
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
      new WindowsActiveTextSurfacePort(
        nativeInvoke(async () => response).invoke,
      ),
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
    let captureNumber = 0;
    const { invoke, mock } = nativeInvoke(async () => {
      captureNumber += 1;
      return captured(`host ${captureNumber}`, {
        captureToken: `opaque-${captureNumber}`,
      });
    });
    const provider = new ImmediateProvider();
    const presentations: GlobalDesktopAssistantPresentation[] = [];
    const controller = new GlobalDesktopAssistantController(
      new WindowsActiveTextSurfacePort(invoke),
      provider,
      (presentation) => presentations.push(presentation),
    );

    await controller.analyzeActiveTextSurface();
    await controller.analyzeActiveTextSurface();

    expect(mock).toHaveBeenCalledTimes(2);
    expect(provider.snapshots.map((snapshot) => snapshot.sourceText)).toEqual([
      "host 1",
      "host 2",
    ]);
    expect(presentations.at(-1)?.sourceText).toBe("host 2");
  });

  it("same text from a new capture supersedes the old Windows invocation", async () => {
    let captureNumber = 0;
    const port = new WindowsActiveTextSurfacePort(
      nativeInvoke(async () => {
        captureNumber += 1;
        return captured("identical text", {
          captureToken: `session-${captureNumber}`,
        });
      }).invoke,
    );
    const provider = new DeferredProvider();
    const presentations: GlobalDesktopAssistantPresentation[] = [];
    const controller = new GlobalDesktopAssistantController(
      port,
      provider,
      (presentation) => presentations.push(presentation),
    );

    const first = controller.analyzeActiveTextSurface();
    await flush();
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
      new WindowsActiveTextSurfacePort(
        nativeInvoke(async () => captured("late source")).invoke,
      ),
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
      new WindowsActiveTextSurfacePort(
        nativeInvoke(async () => captured("same text")).invoke,
      ),
      provider,
      (presentation) => presentations.push(presentation),
    );
    await controller.analyzeActiveTextSurface();

    expect(presentations.at(-1)?.guardedAcceptAllowed).toBe(false);
    expect(presentations.at(-1)?.assistance.active?.normalizedTracks[0]?.acceptTarget)
      .toBeNull();
  });
});
