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
  | "unsupported-text-pattern"
  | "selection-unavailable"
  | "multiple-selection"
  | "element-disappeared"
  | "native-uia-unavailable";

interface NativeTextRange {
  readonly start: number;
  readonly end: number;
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
