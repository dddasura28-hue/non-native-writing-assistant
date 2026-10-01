import { describe, expect, it, vi } from "vitest";

import {
  EMPTY_GLOBAL_DESKTOP_ASSISTANCE,
  type GlobalDesktopAssistantPresentation,
} from "../controller/global-desktop-assistant-controller.js";
import {
  TauriWindowsGlobalShortcutBridge,
  createFloatingAssistantPresentation,
  presentationForCapturedShortcut,
  type WindowsGlobalCaptureEvent,
} from "./windows-global-shortcut-bridge.js";
import type {
  NativeExternalTextAnchor,
  NativeWindowsCaptureResponse,
} from "./windows-active-text-surface.js";

function capture(
  text: string,
  anchor?: NativeExternalTextAnchor,
): Extract<NativeWindowsCaptureResponse, { readonly status: "captured" }> {
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
      captureToken: "opaque",
      ...(anchor === undefined ? {} : { anchor }),
    },
  };
}

describe("Windows global shortcut bridge", () => {
  it("turns a capture-ready event into a read-only analyzing state", () => {
    const presentation = presentationForCapturedShortcut({
      invocationId: 3,
      response: capture("External 文本 😀"),
    });

    expect(presentation).toEqual({
      invocationId: 3,
      status: "analyzing",
      statusMessage: "Analyzing captured text…",
      sourceText: "External 文本 😀",
      nativeIntentText: null,
      normalizedText: null,
      readOnly: true,
    });
  });

  it("clears Source for protected and unsupported captures", () => {
    for (const reason of [
      "protected-field",
      "not-editable",
      "own-process",
    ] as const) {
      const presentation = presentationForCapturedShortcut({
        invocationId: 4,
        response: { status: "unavailable", reason },
      });
      expect(presentation).toMatchObject({
        status: "unsupported",
        sourceText: null,
        normalizedText: null,
      });
      expect(JSON.stringify(presentation)).not.toContain(reason);
      expect(presentation.statusMessage).toBe(
        "No editable writing field focused.",
      );
    }
  });

  it("publishes only the primary presentation-order variants", () => {
    const global: GlobalDesktopAssistantPresentation = {
      ...EMPTY_GLOBAL_DESKTOP_ASSISTANCE,
      hostAvailable: true,
      sourceText: "Source",
      status: "completed",
      statusMessage: "untrusted native error 0x80004005",
      assistance: {
        active: {
          targetKind: "cursor-unit",
          sourceText: "Source",
          status: "completed",
          statusMessage: "Analysis ready",
          inlineStatusMessage: undefined,
          nativeIntent: null,
          nativeIntentTracks: [
            { id: "native-1" as never, text: "Primary intent" },
            { id: "native-2" as never, text: "Other intent" },
          ],
          normalizedTracks: [
            {
              id: "normalized-1" as never,
              text: "Primary normalized",
              canAccept: false,
              acceptTarget: null,
            },
            {
              id: "normalized-2" as never,
              text: "Other normalized",
              canAccept: false,
              acceptTarget: null,
            },
          ],
        },
        recent: [],
      },
    };

    const floating = createFloatingAssistantPresentation(8, global);

    expect(floating).toMatchObject({
      status: "completed",
      statusMessage: "Analysis ready",
      nativeIntentText: "Primary intent",
      normalizedText: "Primary normalized",
      readOnly: true,
    });
    expect(JSON.stringify(floating)).not.toContain("Other normalized");
    expect(JSON.stringify(floating)).not.toContain("0x80004005");
  });

  it("uses a compact configuration-required state", () => {
    const floating = createFloatingAssistantPresentation(
      9,
      {
        ...EMPTY_GLOBAL_DESKTOP_ASSISTANCE,
        hostAvailable: true,
        sourceText: "Captured source",
        status: "configuration-required",
      },
    );
    expect(floating).toMatchObject({
      status: "configuration-required",
      sourceText: "Captured source",
      normalizedText: null,
    });
  });

  it("validates native capture events and safely reports registration failure", async () => {
    let handler: ((event: { payload: unknown }) => void) | null = null;
    const listen = vi.fn(async (_name, next) => {
      handler = next;
      return () => undefined;
    });
    const invoke = vi.fn(async () => {
      throw new Error("native unavailable");
    });
    const bridge = new TauriWindowsGlobalShortcutBridge(
      listen,
      vi.fn(async () => undefined),
      invoke,
    );
    const captures: WindowsGlobalCaptureEvent[] = [];
    await bridge.listenForCaptures((event) => captures.push(event));

    const emit = handler as unknown as (event: { payload: unknown }) => void;
    emit({ payload: { invocationId: 0, response: capture("bad") } });
    emit({ payload: { invocationId: 1, response: capture("current") } });

    expect(captures).toHaveLength(1);
    expect(captures[0]?.response).toEqual(capture("current"));
    await expect(bridge.getRegistrationStatus()).resolves.toEqual({
      state: "unavailable",
      shortcut: "Ctrl+Alt+Space",
    });
  });

  it("maps optional geometry with its invocation and strips malformed geometry", async () => {
    let handler: ((event: { payload: unknown }) => void) | null = null;
    const listen = vi.fn(async (_name, next) => {
      handler = next;
      return () => undefined;
    });
    const bridge = new TauriWindowsGlobalShortcutBridge(
      listen,
      vi.fn(async () => undefined),
      vi.fn(async () => {
        throw new Error("unused native command");
      }),
    );
    const captures: WindowsGlobalCaptureEvent[] = [];
    await bridge.listenForCaptures((event) => captures.push(event));
    const validAnchor: NativeExternalTextAnchor = {
      physicalX: 1440,
      physicalY: 700,
      physicalWidth: 1,
      physicalHeight: 24,
      confidence: "approximate",
    };
    const emit = handler as unknown as (event: { payload: unknown }) => void;

    emit({ payload: { invocationId: 11, response: capture("current", validAnchor) } });
    emit({
      payload: {
        invocationId: 12,
        response: capture("still analyzable", {
          ...validAnchor,
          physicalWidth: Number.NaN,
        }),
      },
    });

    expect(captures[0]).toMatchObject({
      invocationId: 11,
      response: { status: "captured", capture: { anchor: validAnchor } },
    });
    const presentation = presentationForCapturedShortcut(captures[0]!);
    expect(presentation.invocationId).toBe(11);
    expect(JSON.stringify(presentation)).not.toContain("physicalX");
    expect(captures[1]).toMatchObject({
      invocationId: 12,
      response: { status: "captured", capture: { text: "still analyzable" } },
    });
    if (captures[1]?.response.status === "captured") {
      expect(captures[1].response.capture.anchor).toBeUndefined();
    }
  });
});
