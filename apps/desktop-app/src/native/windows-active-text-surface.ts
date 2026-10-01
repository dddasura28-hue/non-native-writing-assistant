import {
  createActiveTextSurfaceCapture,
  type ActiveTextSurfaceCapture,
  type ActiveTextSurfacePort,
} from "../host/active-text-surface.js";

export type WindowsCaptureUnavailableReason =
  | "no-focused-element"
  | "own-process"
  | "protected-field"
  | "disabled-element"
  | "not-focusable"
  | "not-editable"
  | "unsupported-text-pattern"
  | "selection-unavailable"
  | "multiple-selection"
  | "element-disappeared"
  | "native-uia-unavailable";

interface NativeTextRange {
  readonly start: number;
  readonly end: number;
}

export interface NativeExternalTextAnchor {
  readonly physicalX: number;
  readonly physicalY: number;
  readonly physicalWidth: number;
  readonly physicalHeight: number;
  readonly confidence: "exact" | "approximate";
}

interface NativeWindowsTextSurfaceCapture {
  readonly text: string;
  readonly cursorOffset: number;
  readonly selection: NativeTextRange | null;
  readonly capabilities: {
    readonly canReplaceText: boolean;
    readonly canObserveComposition: boolean;
    readonly canObserveSelection: boolean;
    readonly canProvideSurroundingText: boolean;
  };
  readonly captureToken: string;
  readonly anchor?: NativeExternalTextAnchor;
}

export type NativeWindowsCaptureResponse =
  | {
      readonly status: "captured";
      readonly capture: NativeWindowsTextSurfaceCapture;
    }
  | {
      readonly status: "unavailable";
      readonly reason: WindowsCaptureUnavailableReason;
    };

export function parseNativeWindowsCaptureResponse(
  value: unknown,
): NativeWindowsCaptureResponse | null {
  if (!isRecord(value) || !("status" in value)) {
    return null;
  }
  if (value.status === "unavailable") {
    if (
      !hasExactKeys(value, ["status", "reason"]) ||
      !("reason" in value) ||
      typeof value.reason !== "string" ||
      !WINDOWS_UNAVAILABLE_REASONS.has(value.reason)
    ) {
      return null;
    }
    return {
      status: "unavailable",
      reason: value.reason as WindowsCaptureUnavailableReason,
    };
  }
  if (
    value.status !== "captured" ||
    !hasExactKeys(value, ["status", "capture"]) ||
    !("capture" in value) ||
    !isRecord(value.capture)
  ) {
    return null;
  }
  const capture = value.capture;
  const allowedCaptureKeys = [
    "text",
    "cursorOffset",
    "selection",
    "capabilities",
    "captureToken",
    ...(Object.hasOwn(capture, "anchor") ? ["anchor"] : []),
  ];
  if (
    !hasExactKeys(capture, allowedCaptureKeys) ||
    !("text" in capture) ||
    typeof capture.text !== "string" ||
    !("cursorOffset" in capture) ||
    !isNonnegativeSafeInteger(capture.cursorOffset) ||
    !("selection" in capture) ||
    !isNativeTextRangeOrNull(capture.selection) ||
    !("captureToken" in capture) ||
    typeof capture.captureToken !== "string" ||
    capture.captureToken.length === 0 ||
    !("capabilities" in capture) ||
    !isNativeCapabilities(capture.capabilities) ||
    capture.cursorOffset > capture.text.length ||
    !isUtf16Boundary(capture.text, capture.cursorOffset) ||
    (capture.selection !== null &&
      (capture.selection.end > capture.text.length ||
        !isUtf16Boundary(capture.text, capture.selection.start) ||
        !isUtf16Boundary(capture.text, capture.selection.end))) ||
    (!capture.capabilities.canObserveSelection && capture.selection !== null) ||
    ("anchor" in capture && !isNativeExternalTextAnchor(capture.anchor))
  ) {
    return null;
  }
  const anchor: NativeExternalTextAnchor | undefined = "anchor" in capture
    ? capture.anchor as NativeExternalTextAnchor
    : undefined;
  return {
    status: "captured",
    capture: {
      text: capture.text,
      cursorOffset: capture.cursorOffset,
      selection: capture.selection === null
        ? null
        : { start: capture.selection.start, end: capture.selection.end },
      capabilities: {
        canReplaceText: false,
        canObserveComposition: false,
        canObserveSelection: capture.capabilities.canObserveSelection,
        canProvideSurroundingText:
          capture.capabilities.canProvideSurroundingText,
      },
      captureToken: capture.captureToken,
      ...(anchor === undefined ? {} : { anchor }),
    },
  };
}

function isNativeExternalTextAnchor(
  value: unknown,
): value is NativeExternalTextAnchor {
  return isRecord(value) &&
    hasExactKeys(value, [
      "physicalX",
      "physicalY",
      "physicalWidth",
      "physicalHeight",
      "confidence",
    ]) &&
    "physicalX" in value && isFiniteNumber(value.physicalX) &&
    "physicalY" in value && isFiniteNumber(value.physicalY) &&
    "physicalWidth" in value && isPositiveFiniteNumber(value.physicalWidth) &&
    "physicalHeight" in value && isPositiveFiniteNumber(value.physicalHeight) &&
    "confidence" in value &&
    (value.confidence === "exact" || value.confidence === "approximate");
}

function isNativeTextRangeOrNull(value: unknown): value is NativeTextRange | null {
  return value === null || (
    isRecord(value) &&
    hasExactKeys(value, ["start", "end"]) &&
    "start" in value && isNonnegativeSafeInteger(value.start) &&
    "end" in value && isNonnegativeSafeInteger(value.end) &&
    value.start <= value.end
  );
}

function isNativeCapabilities(value: unknown): value is NativeWindowsTextSurfaceCapture["capabilities"] {
  return isRecord(value) &&
    hasExactKeys(value, [
      "canReplaceText",
      "canObserveComposition",
      "canObserveSelection",
      "canProvideSurroundingText",
    ]) &&
    "canReplaceText" in value && value.canReplaceText === false &&
    "canObserveComposition" in value && value.canObserveComposition === false &&
    "canObserveSelection" in value &&
    typeof value.canObserveSelection === "boolean" &&
    "canProvideSurroundingText" in value &&
    typeof value.canProvideSurroundingText === "boolean";
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function isUtf16Boundary(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) {
    return true;
  }
  const previous = text.charCodeAt(offset - 1);
  const next = text.charCodeAt(offset);
  return !(
    previous >= 0xd800 && previous <= 0xdbff &&
    next >= 0xdc00 && next <= 0xdfff
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key));
}

const WINDOWS_UNAVAILABLE_REASONS: ReadonlySet<string> = new Set([
  "no-focused-element",
  "own-process",
  "protected-field",
  "disabled-element",
  "not-focusable",
  "not-editable",
  "unsupported-text-pattern",
  "selection-unavailable",
  "multiple-selection",
  "element-disappeared",
  "native-uia-unavailable",
]);

/** Consumes snapshots captured by the native shortcut before any app window is shown. */
export class WindowsActiveTextSurfacePort implements ActiveTextSurfacePort {
  #pending: NativeWindowsCaptureResponse | null = null;
  #lastUnavailableReason: WindowsCaptureUnavailableReason | null = null;

  get lastUnavailableReason(): WindowsCaptureUnavailableReason | null {
    return this.#lastUnavailableReason;
  }

  stage(response: NativeWindowsCaptureResponse): void {
    this.#pending = response;
  }

  async capture(): Promise<ActiveTextSurfaceCapture | null> {
    const response = this.#pending;
    this.#pending = null;
    if (response === null) {
      this.#lastUnavailableReason = "native-uia-unavailable";
      return null;
    }

    if (response.status === "unavailable") {
      this.#lastUnavailableReason = response.reason;
      return null;
    }

    const payload = response.capture;
    if (
      typeof payload.captureToken !== "string" ||
      payload.captureToken.length === 0 ||
      payload.capabilities.canReplaceText ||
      payload.capabilities.canObserveComposition
    ) {
      this.#lastUnavailableReason = "native-uia-unavailable";
      return null;
    }

    try {
      const capture = createActiveTextSurfaceCapture({
        context: {
          text: payload.text,
          cursorOffset: payload.cursorOffset,
          selection: payload.selection,
          composition: null,
        },
        capabilities: {
          canReplaceText: false,
          canObserveComposition: false,
          canObserveSelection:
            payload.capabilities.canObserveSelection,
          canProvideSurroundingText:
            payload.capabilities.canProvideSurroundingText,
        },
        editPort: null,
      });
      this.#lastUnavailableReason = null;
      return capture;
    } catch {
      this.#lastUnavailableReason = "element-disappeared";
      return null;
    }
  }
}
