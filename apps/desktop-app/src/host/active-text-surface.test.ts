import {
  createHostCapabilities,
  createTextContext,
  type HostCapabilities,
  type TextEditPort,
} from "@non-native-writing/application";
import { describe, expect, it } from "vitest";

import {
  createActiveTextSurfaceCapture,
  deriveDesktopHostAssistanceMode,
} from "./active-text-surface.js";
import { createCapturedTextareaTextSurface } from "./textarea-active-text-surface.js";
import type {
  TextareaEditTarget,
  TextareaSessionState,
} from "./textarea-text-edit-port.js";

const FULL_CAPABILITIES = createHostCapabilities({
  canReplaceText: true,
  canObserveComposition: true,
  canObserveSelection: true,
  canProvideSurroundingText: true,
});

const EDIT_PORT: TextEditPort = { replace: () => undefined };

function context(
  text = "Ready.",
  options: {
    readonly selection?: { readonly start: number; readonly end: number } | null;
    readonly composition?: {
      readonly start: number;
      readonly end: number;
      readonly text: string;
    } | null;
  } = {},
) {
  return createTextContext({
    text,
    cursorOffset: text.length,
    selection: options.selection ?? null,
    composition: options.composition ?? null,
  });
}

function capture(
  capabilities: HostCapabilities,
  options: Parameters<typeof context>[1] = {},
) {
  return createActiveTextSurfaceCapture({
    context: context("Ready.", options),
    capabilities,
    editPort: capabilities.canReplaceText ? EDIT_PORT : null,
  });
}

describe("active desktop text-surface boundary", () => {
  it("enables realtime, manual analysis and guarded Accept with full capabilities", () => {
    expect(deriveDesktopHostAssistanceMode(capture(FULL_CAPABILITIES))).toEqual({
      automaticRealtimeAllowed: true,
      manualAnalysisAllowed: true,
      guardedAcceptAllowed: true,
    });
  });

  it("disables realtime but keeps intentional manual analysis without composition observation", () => {
    const capabilities = createHostCapabilities({
      ...FULL_CAPABILITIES,
      canObserveComposition: false,
    });

    expect(deriveDesktopHostAssistanceMode(capture(capabilities))).toEqual({
      automaticRealtimeAllowed: false,
      manualAnalysisAllowed: true,
      guardedAcceptAllowed: true,
    });
  });

  it("represents unavailable selection observation without fabricating a range", () => {
    const capabilities = createHostCapabilities({
      ...FULL_CAPABILITIES,
      canObserveSelection: false,
    });
    const captured = capture(capabilities);

    expect(captured.context.selection).toBeNull();
    expect(captured.capabilities.canObserveSelection).toBe(false);
    expect(() => capture(capabilities, {
      selection: { start: 0, end: 5 },
    })).toThrow(/cannot report a precise selection/);
  });

  it("preserves an exact selected-text window when surrounding text is unavailable", () => {
    const capabilities = createHostCapabilities({
      ...FULL_CAPABILITIES,
      canProvideSurroundingText: false,
    });
    const captured = createActiveTextSurfaceCapture({
      context: context("只有选中文本", {
        selection: { start: 0, end: "只有选中文本".length },
      }),
      capabilities,
      editPort: EDIT_PORT,
    });

    expect(captured.context.text).toBe("只有选中文本");
    expect(captured.context.selection).toEqual({
      start: 0,
      end: "只有选中文本".length,
    });
    expect(captured.capabilities.canProvideSurroundingText).toBe(false);
  });

  it("allows read-only analysis while disabling guarded Accept", () => {
    const capabilities = createHostCapabilities({
      ...FULL_CAPABILITIES,
      canReplaceText: false,
    });
    const mode = deriveDesktopHostAssistanceMode(capture(capabilities));

    expect(mode.manualAnalysisAllowed).toBe(true);
    expect(mode.automaticRealtimeAllowed).toBe(true);
    expect(mode.guardedAcceptAllowed).toBe(false);
  });

  it("blocks analysis and Accept while observed composition is active", () => {
    const captured = capture(FULL_CAPABILITIES, {
      composition: { start: 1, end: 2, text: "文" },
    });

    expect(deriveDesktopHostAssistanceMode(captured)).toEqual({
      automaticRealtimeAllowed: false,
      manualAnalysisAllowed: false,
      guardedAcceptAllowed: false,
    });
  });

  it("requires replace capability and the guarded edit port to agree", () => {
    expect(() => createActiveTextSurfaceCapture({
      context: context(),
      capabilities: FULL_CAPABILITIES,
      editPort: null,
    })).toThrow(/must agree/);
    expect(() => createActiveTextSurfaceCapture({
      context: context(),
      capabilities: createHostCapabilities({
        ...FULL_CAPABILITIES,
        canReplaceText: false,
      }),
      editPort: EDIT_PORT,
    })).toThrow(/must agree/);
  });

  it("strips host-local metadata instead of admitting it to analysis context", () => {
    const contextWithMetadata = {
      ...context("Private draft"),
      windowTitle: "Sensitive document title",
      processName: "external-app.exe",
    };
    const capabilitiesWithMetadata = {
      ...FULL_CAPABILITIES,
      nativeHandle: "opaque-native-handle",
    };

    const captured = createActiveTextSurfaceCapture({
      context: contextWithMetadata,
      capabilities: capabilitiesWithMetadata,
      editPort: EDIT_PORT,
    });

    expect(captured.context).toEqual({
      text: "Private draft",
      cursorOffset: "Private draft".length,
      selection: null,
      composition: null,
    });
    expect(captured.context).not.toHaveProperty("windowTitle");
    expect(captured.context).not.toHaveProperty("processName");
    expect(captured.capabilities).not.toHaveProperty("nativeHandle");
  });

  it("adapts the owned textarea as a full-capability captured surface", () => {
    const target: TextareaEditTarget = {
      value: "Owned text",
      selectionStart: 10,
      selectionEnd: 10,
      selectionDirection: "none",
      setRangeText: () => undefined,
    };
    const session: TextareaSessionState = {
      token: Symbol("owned-textarea"),
      generation: 1,
      compositionActive: false,
    };
    const captured = createCapturedTextareaTextSurface({
      target,
      context: context("Owned text"),
      session,
      getCurrentSession: () => session,
      onDidReplace: () => undefined,
    });

    expect(captured.capabilities).toEqual(FULL_CAPABILITIES);
    expect(captured.context.text).toBe("Owned text");
    expect(captured.editPort).not.toBeNull();
  });
});
