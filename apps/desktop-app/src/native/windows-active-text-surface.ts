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
  if (typeof value !== "object" || value === null || !("status" in value)) {
    return null;
  }
  if (value.status === "unavailable") {
    if (
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
    !("capture" in value) ||
    typeof value.capture !== "object" ||
    value.capture === null
  ) {
    return null;
  }
  const capture = value.capture;
  if (
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
    !isNativeCapabilities(capture.capabilities)
  ) {
    return null;
  }
  const anchor = "anchor" in capture && isNativeExternalTextAnchor(capture.anchor)
    ? capture.anchor
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
  return typeof value === "object" && value !== null &&
    "physicalX" in value && isFiniteNumber(value.physicalX) &&
    "physicalY" in value && isFiniteNumber(value.physicalY) &&
    "physicalWidth" in value && isPositiveFiniteNumber(value.physicalWidth) &&
    "physicalHeight" in value && isPositiveFiniteNumber(value.physicalHeight) &&
    "confidence" in value &&
    (value.confidence === "exact" || value.confidence === "approximate");
}

function isNativeTextRangeOrNull(value: unknown): value is NativeTextRange | null {
  return value === null || (
    typeof value === "object" && value !== null &&
    "start" in value && isNonnegativeSafeInteger(value.start) &&
    "end" in value && isNonnegativeSafeInteger(value.end) &&
    value.start <= value.end
  );
}

function isNativeCapabilities(value: unknown): value is NativeWindowsTextSurfaceCapture["capabilities"] {
  return typeof value === "object" && value !== null &&
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
