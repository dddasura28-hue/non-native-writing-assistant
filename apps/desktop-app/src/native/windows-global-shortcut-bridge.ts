import {
  emitTo,
  listen,
  type Event,
  type UnlistenFn,
} from "@tauri-apps/api/event";

import type { GlobalDesktopAssistantPresentation } from "../controller/global-desktop-assistant-controller.js";
import {
  invokeNative,
  type NativeInvoke,
} from "./native-command-client.js";
import type { NativeWindowsCaptureResponse } from "./windows-active-text-surface.js";

export const WINDOWS_GLOBAL_CAPTURE_EVENT = "windows-global-capture";
export const GLOBAL_ASSISTANT_PRESENTATION_EVENT =
  "global-assistant-presentation";
const GLOBAL_ASSISTANT_WINDOW = "global-assistant";
const SHORTCUT_STATUS_COMMAND = "get_windows_global_shortcut_status";

export interface WindowsGlobalCaptureEvent {
  readonly invocationId: number;
  readonly response: NativeWindowsCaptureResponse;
}

export interface WindowsGlobalShortcutStatus {
  readonly state: "initializing" | "registered" | "unavailable";
  readonly shortcut: string;
}

export type FloatingAssistantStatus =
  | "analyzing"
  | "completed"
  | "configuration-required"
  | "unsupported"
  | "failed";

export interface FloatingAssistantPresentation {
  readonly invocationId: number;
  readonly status: FloatingAssistantStatus;
  readonly statusMessage: string;
  readonly sourceText: string | null;
  readonly nativeIntentText: string | null;
  readonly normalizedText: string | null;
  readonly readOnly: true;
}

type EventListener = <T>(
  eventName: string,
  handler: (event: Event<T>) => void,
) => Promise<UnlistenFn>;

type EventEmitter = <T>(
  target: string,
  eventName: string,
  payload: T,
) => Promise<void>;

export interface WindowsGlobalShortcutBridge {
  listenForCaptures(
    listener: (event: WindowsGlobalCaptureEvent) => void,
  ): Promise<UnlistenFn>;
  listenForPresentations(
    listener: (presentation: FloatingAssistantPresentation) => void,
  ): Promise<UnlistenFn>;
  publishPresentation(
    presentation: FloatingAssistantPresentation,
  ): Promise<void>;
  getRegistrationStatus(): Promise<WindowsGlobalShortcutStatus>;
}

export class TauriWindowsGlobalShortcutBridge
implements WindowsGlobalShortcutBridge {
  readonly #listen: EventListener;
  readonly #emitTo: EventEmitter;
  readonly #invoke: NativeInvoke;

  constructor(
    listenEvent: EventListener = listen,
    emitEventTo: EventEmitter = emitTo,
    invoke: NativeInvoke = invokeNative,
  ) {
    this.#listen = listenEvent;
    this.#emitTo = emitEventTo;
    this.#invoke = invoke;
  }

  listenForCaptures(
    listener: (event: WindowsGlobalCaptureEvent) => void,
  ): Promise<UnlistenFn> {
    return this.#listen<unknown>(WINDOWS_GLOBAL_CAPTURE_EVENT, (event) => {
      if (isWindowsGlobalCaptureEvent(event.payload)) {
        listener(event.payload);
      }
    });
  }

  listenForPresentations(
    listener: (presentation: FloatingAssistantPresentation) => void,
  ): Promise<UnlistenFn> {
    return this.#listen<unknown>(
      GLOBAL_ASSISTANT_PRESENTATION_EVENT,
      (event) => {
        if (isFloatingAssistantPresentation(event.payload)) {
          listener(event.payload);
        }
      },
    );
  }

  publishPresentation(
    presentation: FloatingAssistantPresentation,
  ): Promise<void> {
    return this.#emitTo(
      GLOBAL_ASSISTANT_WINDOW,
      GLOBAL_ASSISTANT_PRESENTATION_EVENT,
      presentation,
    );
  }

  async getRegistrationStatus(): Promise<WindowsGlobalShortcutStatus> {
    try {
      const status = await this.#invoke<WindowsGlobalShortcutStatus>(
        SHORTCUT_STATUS_COMMAND,
      );
      if (
        (status.state === "initializing" ||
          status.state === "registered" ||
          status.state === "unavailable") &&
        typeof status.shortcut === "string"
      ) {
        return status;
      }
    } catch {
      // The standalone editor remains available when native registration fails.
    }
    return { state: "unavailable", shortcut: "Ctrl+Alt+Space" };
  }
}

export function presentationForCapturedShortcut(
  event: WindowsGlobalCaptureEvent,
): FloatingAssistantPresentation {
  if (event.response.status === "unavailable") {
    return Object.freeze({
      invocationId: event.invocationId,
      status: "unsupported",
      statusMessage: "No supported Windows text field is active.",
      sourceText: null,
      nativeIntentText: null,
      normalizedText: null,
      readOnly: true,
    });
  }
  return Object.freeze({
    invocationId: event.invocationId,
    status: "analyzing",
    statusMessage: "Analyzing captured text…",
    sourceText: event.response.capture.text,
    nativeIntentText: null,
    normalizedText: null,
    readOnly: true,
  });
}

export function createFloatingAssistantPresentation(
  invocationId: number,
  presentation: GlobalDesktopAssistantPresentation,
): FloatingAssistantPresentation {
  const active = presentation.assistance.active;
  const status = presentation.status === "configuration-required"
    ? "configuration-required"
    : presentation.status === "completed"
      ? "completed"
      : presentation.status === "analyzing" ||
          presentation.status === "capturing" ||
          presentation.status === "idle"
        ? "analyzing"
        : presentation.status === "no-host" ||
            presentation.status === "empty" ||
            presentation.status === "composition-active"
          ? "unsupported"
          : "failed";
  const statusMessage = status === "configuration-required"
    ? "Configure a provider in the main app to analyze this text."
    : status === "completed"
      ? "Analysis ready"
      : status === "analyzing"
        ? "Analyzing captured text…"
        : status === "unsupported"
          ? "No supported Windows text field is active."
          : "Analysis is unavailable. Check the main app settings.";

  return Object.freeze({
    invocationId,
    status,
    statusMessage,
    sourceText: status === "unsupported" ? null : presentation.sourceText,
    nativeIntentText: status === "completed"
      ? active?.nativeIntentTracks[0]?.text ?? null
      : null,
    normalizedText: status === "completed"
      ? active?.normalizedTracks[0]?.text ?? null
      : null,
    readOnly: true,
  });
}

function isWindowsGlobalCaptureEvent(
  value: unknown,
): value is WindowsGlobalCaptureEvent {
  if (
    typeof value !== "object" ||
    value === null ||
    !("invocationId" in value) ||
    typeof value.invocationId !== "number" ||
    !Number.isSafeInteger(value.invocationId) ||
    value.invocationId < 1 ||
    !("response" in value) ||
    typeof value.response !== "object" ||
    value.response === null ||
    !("status" in value.response)
  ) {
    return false;
  }
  if (value.response.status === "unavailable") {
    return "reason" in value.response &&
      typeof value.response.reason === "string" &&
      WINDOWS_UNAVAILABLE_REASONS.has(value.response.reason);
  }
  if (
    value.response.status !== "captured" ||
    !("capture" in value.response) ||
    typeof value.response.capture !== "object" ||
    value.response.capture === null
  ) {
    return false;
  }
  const capture = value.response.capture;
  return "text" in capture && typeof capture.text === "string" &&
    "cursorOffset" in capture && typeof capture.cursorOffset === "number" &&
    Number.isSafeInteger(capture.cursorOffset) &&
    "captureToken" in capture && typeof capture.captureToken === "string" &&
    capture.captureToken.length > 0 &&
    "capabilities" in capture &&
    typeof capture.capabilities === "object" &&
    capture.capabilities !== null &&
    "canReplaceText" in capture.capabilities &&
    capture.capabilities.canReplaceText === false &&
    "canObserveComposition" in capture.capabilities &&
    capture.capabilities.canObserveComposition === false;
}

function isFloatingAssistantPresentation(
  value: unknown,
): value is FloatingAssistantPresentation {
  return typeof value === "object" && value !== null &&
    "invocationId" in value &&
    typeof value.invocationId === "number" &&
    Number.isSafeInteger(value.invocationId) &&
    value.invocationId > 0 &&
    "status" in value &&
    typeof value.status === "string" &&
    FLOATING_ASSISTANT_STATUSES.has(value.status) &&
    "statusMessage" in value &&
    typeof value.statusMessage === "string" &&
    "sourceText" in value && isNullableString(value.sourceText) &&
    "nativeIntentText" in value && isNullableString(value.nativeIntentText) &&
    "normalizedText" in value && isNullableString(value.normalizedText) &&
    "readOnly" in value && value.readOnly === true;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

const FLOATING_ASSISTANT_STATUSES: ReadonlySet<string> = new Set([
  "analyzing",
  "completed",
  "configuration-required",
  "unsupported",
  "failed",
]);

const WINDOWS_UNAVAILABLE_REASONS = new Set([
  "no-focused-element",
  "own-process",
  "protected-field",
  "disabled-element",
  "not-focusable",
  "unsupported-text-pattern",
  "selection-unavailable",
  "multiple-selection",
  "element-disappeared",
  "native-uia-unavailable",
]);
