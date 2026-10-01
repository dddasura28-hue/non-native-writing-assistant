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
import {
  parseNativeWindowsCaptureResponse,
  type NativeWindowsCaptureResponse,
} from "./windows-active-text-surface.js";

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
  readonly presentationRevision: number;
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
      const capture = parseWindowsGlobalCaptureEvent(event.payload);
      if (capture !== null) {
        listener(capture);
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
      presentationRevision: 0,
      status: "unsupported",
      statusMessage: "No editable writing field focused.",
      sourceText: null,
      nativeIntentText: null,
      normalizedText: null,
      readOnly: true,
    });
  }
  return Object.freeze({
    invocationId: event.invocationId,
    presentationRevision: 0,
    status: "analyzing",
    statusMessage: "Analyzing captured text…",
    sourceText: event.response.capture.text,
    nativeIntentText: null,
    normalizedText: null,
    readOnly: true,
  });
}

export function createFloatingAssistantPresentation(
  presentation: GlobalDesktopAssistantPresentation,
): FloatingAssistantPresentation {
  if (presentation.invocationId === null) {
    throw new TypeError("A global invocation is required for floating presentation.");
  }
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
          ? "No editable writing field focused."
          : "Analysis is unavailable. Check the main app settings.";

  return Object.freeze({
    invocationId: presentation.invocationId,
    presentationRevision: presentation.presentationRevision,
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

function parseWindowsGlobalCaptureEvent(
  value: unknown,
): WindowsGlobalCaptureEvent | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["invocationId", "response"]) ||
    !("invocationId" in value) ||
    typeof value.invocationId !== "number" ||
    !Number.isSafeInteger(value.invocationId) ||
    value.invocationId < 1 ||
    !("response" in value)
  ) {
    return null;
  }
  const response = parseNativeWindowsCaptureResponse(value.response);
  if (
    response === null ||
    (response.status === "captured" &&
      response.capture.captureToken !== invocationToken(value.invocationId))
  ) {
    return null;
  }
  return { invocationId: value.invocationId, response };
}

function isFloatingAssistantPresentation(
  value: unknown,
): value is FloatingAssistantPresentation {
  return isRecord(value) &&
    hasOnlyKeys(value, [
      "invocationId",
      "presentationRevision",
      "status",
      "statusMessage",
      "sourceText",
      "nativeIntentText",
      "normalizedText",
      "readOnly",
    ]) &&
    "invocationId" in value &&
    typeof value.invocationId === "number" &&
    Number.isSafeInteger(value.invocationId) &&
    value.invocationId > 0 &&
    "presentationRevision" in value &&
    typeof value.presentationRevision === "number" &&
    Number.isSafeInteger(value.presentationRevision) &&
    value.presentationRevision >= 1 &&
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

/** Accepts each native invocation once and rejects delayed or duplicate events. */
export class LatestWindowsGlobalInvocation {
  #currentInvocationId = 0;

  get currentInvocationId(): number {
    return this.#currentInvocationId;
  }

  begin(invocationId: number): boolean {
    if (
      !Number.isSafeInteger(invocationId) ||
      invocationId <= this.#currentInvocationId
    ) {
      return false;
    }
    this.#currentInvocationId = invocationId;
    return true;
  }

  isCurrent(invocationId: number): boolean {
    return invocationId === this.#currentInvocationId;
  }
}

/** Owns the visible floating state independently from React scheduling. */
export class FloatingAssistantPresentationOwner {
  #current: FloatingAssistantPresentation | null = null;

  get current(): FloatingAssistantPresentation | null {
    return this.#current;
  }

  accept(
    next: FloatingAssistantPresentation,
  ): FloatingAssistantPresentation | null {
    const current = this.#current;
    if (
      current !== null &&
      (next.invocationId < current.invocationId ||
        (next.invocationId === current.invocationId &&
          next.presentationRevision <= current.presentationRevision))
    ) {
      return null;
    }
    this.#current = next;
    return next;
  }
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

function invocationToken(invocationId: number): string {
  return `windows-invocation-${invocationId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}
