/** @vitest-environment jsdom */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GlobalAssistantWindow } from "./GlobalAssistantWindow.js";
import type {
  FloatingAssistantPresentation,
  WindowsGlobalCaptureEvent,
  WindowsGlobalShortcutBridge,
} from "./native/windows-global-shortcut-bridge.js";

class FakeBridge implements WindowsGlobalShortcutBridge {
  captureListener: ((event: WindowsGlobalCaptureEvent) => void) | null = null;
  presentationListener:
    | ((presentation: FloatingAssistantPresentation) => void)
    | null = null;
  captureStopped = false;
  presentationStopped = false;

  async listenForCaptures(listener: (event: WindowsGlobalCaptureEvent) => void) {
    this.captureListener = listener;
    return () => {
      this.captureStopped = true;
      this.captureListener = null;
    };
  }

  async listenForPresentations(
    listener: (presentation: FloatingAssistantPresentation) => void,
  ) {
    this.presentationListener = listener;
    return () => {
      this.presentationStopped = true;
      this.presentationListener = null;
    };
  }

  async publishPresentation(): Promise<void> {}

  async getRegistrationStatus() {
    return { state: "registered" as const, shortcut: "Ctrl+Alt+Space" };
  }
}

function capturedEvent(invocationId: number): WindowsGlobalCaptureEvent {
  return {
    invocationId,
    response: {
      status: "captured",
      capture: {
        text: "Long external\nSource 文本 😀",
        cursorOffset: 26,
        selection: null,
        capabilities: {
          canReplaceText: false,
          canObserveComposition: false,
          canObserveSelection: true,
          canProvideSurroundingText: true,
        },
        captureToken: "opaque",
      },
    },
  };
}

describe("GlobalAssistantWindow", () => {
  let container: HTMLDivElement;
  let root: Root;
  let bridge: FakeBridge;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    bridge = new FakeBridge();
    await act(async () => {
      root.render(<GlobalAssistantWindow createBridge={() => bridge} />);
      await Promise.resolve();
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders analyzing Source and remains visibly read-only", () => {
    act(() => bridge.captureListener?.(capturedEvent(1)));

    expect(container.textContent).toContain("Analyzing captured text");
    expect(container.textContent).toContain("Long external\nSource 文本 😀");
    expect(container.textContent).toContain("Read-only");
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).not.toContain("Accept");
  });

  it("renders Native Intent and one primary Normalized result", () => {
    act(() => bridge.captureListener?.(capturedEvent(2)));
    act(() => bridge.presentationListener?.({
      invocationId: 2,
      status: "completed",
      statusMessage: "Analysis ready",
      sourceText: "Source",
      nativeIntentText: "Meaning",
      normalizedText: "Improved wording",
      readOnly: true,
    }));

    expect(container.textContent).toContain("Native Intent");
    expect(container.textContent).toContain("Meaning");
    expect(container.textContent).toContain("Normalized");
    expect(container.textContent).toContain("Improved wording");
  });

  it("ignores a late presentation from an older host", () => {
    act(() => bridge.captureListener?.(capturedEvent(5)));
    act(() => bridge.presentationListener?.({
      invocationId: 4,
      status: "completed",
      statusMessage: "Analysis ready",
      sourceText: "Old host",
      nativeIntentText: "Old intent",
      normalizedText: "Old result",
      readOnly: true,
    }));

    expect(container.textContent).toContain("Long external");
    expect(container.textContent).not.toContain("Old host");
    expect(container.textContent).not.toContain("Old result");
  });

  it("does not regress a completed invocation to a late analyzing event", () => {
    act(() => bridge.presentationListener?.({
      invocationId: 10,
      status: "completed",
      statusMessage: "Analysis ready",
      sourceText: "Current host",
      nativeIntentText: "Current intent",
      normalizedText: "Current result",
      readOnly: true,
    }));
    act(() => bridge.captureListener?.(capturedEvent(10)));

    expect(container.textContent).toContain("Current result");
    expect(container.textContent).not.toContain("Analyzing captured text");
  });

  it("clears an old Source for an unsupported latest capture", () => {
    act(() => bridge.captureListener?.(capturedEvent(6)));
    act(() => bridge.captureListener?.({
      invocationId: 7,
      response: { status: "unavailable", reason: "protected-field" },
    }));

    expect(container.textContent).toContain("No supported Windows text field");
    expect(container.textContent).not.toContain("Long external");
    expect(container.textContent).not.toContain("protected-field");
  });

  it("uses constrained scrolling styles and detaches listeners on cleanup", () => {
    const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
    expect(css).toMatch(/\.global-assistant-shell[\s\S]*height: 100vh;/u);
    expect(css).toMatch(/\.global-assistant-shell[\s\S]*overflow: auto;/u);

    act(() => root.unmount());
    expect(bridge.captureStopped).toBe(true);
    expect(bridge.presentationStopped).toBe(true);
    root = createRoot(container);
  });
});
