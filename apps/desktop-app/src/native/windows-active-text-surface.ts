import {
  createActiveTextSurfaceCapture,
  type ActiveTextSurfaceCapture,
  type ActiveTextSurfacePort,
} from "../host/active-text-surface.js";
import {
  invokeNative,
  type NativeInvoke,
} from "./native-command-client.js";

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

const CAPTURE_COMMAND = "capture_active_windows_text_surface";

/** Thin Tauri adapter. UIA objects and capture identity never leave Rust. */
export class WindowsActiveTextSurfacePort implements ActiveTextSurfacePort {
  readonly #invoke: NativeInvoke;
  #lastUnavailableReason: WindowsCaptureUnavailableReason | null = null;

  constructor(invoke: NativeInvoke = invokeNative) {
    this.#invoke = invoke;
  }

  get lastUnavailableReason(): WindowsCaptureUnavailableReason | null {
    return this.#lastUnavailableReason;
  }

  async capture(): Promise<ActiveTextSurfaceCapture | null> {
    let response: NativeWindowsCaptureResponse;
    try {
      response = await this.#invoke<NativeWindowsCaptureResponse>(
        CAPTURE_COMMAND,
      );
    } catch {
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
