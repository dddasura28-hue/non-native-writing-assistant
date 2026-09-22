import type {
  AnalysisOutcome,
  AnalysisProvider,
} from "@non-native-writing/application";

import {
  DesktopEngineController,
  EMPTY_DESKTOP_ASSISTANCE,
  type DesktopAssistancePresentation,
  type DesktopEngineControllerOptions,
  type DesktopNormalizedAcceptResult,
  type DesktopNormalizedAcceptTarget,
} from "./desktop-engine-controller.js";
import {
  createActiveTextSurfaceCapture,
  deriveDesktopHostAssistanceMode,
  type ActiveTextSurfaceCapture,
  type ActiveTextSurfacePort,
  type DesktopHostAssistanceMode,
} from "../host/active-text-surface.js";

export type GlobalDesktopAssistantStatus =
  | "capturing"
  | "no-host"
  | "empty"
  | "composition-active"
  | "configuration-required"
  | "idle"
  | "analyzing"
  | "completed"
  | "failed"
  | "updated";

export interface GlobalDesktopAssistantPresentation {
  readonly hostAvailable: boolean;
  readonly readOnly: boolean;
  readonly automaticRealtimeAllowed: boolean;
  readonly manualAnalysisAllowed: boolean;
  readonly guardedAcceptAllowed: boolean;
  readonly sourceText: string | null;
  readonly status: GlobalDesktopAssistantStatus;
  readonly statusMessage: string;
  readonly assistance: DesktopAssistancePresentation;
}

export type PresentGlobalDesktopAssistant = (
  presentation: GlobalDesktopAssistantPresentation,
) => void;

export type GlobalDesktopManualAnalysisResult =
  | AnalysisOutcome["status"]
  | "unavailable"
  | "empty"
  | "composition-active"
  | "configuration-required"
  | "obsolete";

export interface GlobalDesktopManualAnalysisOptions {
  readonly configurationRequired?: boolean;
}

export type GlobalDesktopAssistantControllerOptions = Pick<
  DesktopEngineControllerOptions,
  "configuration" | "configurationSource"
>;

export const EMPTY_GLOBAL_DESKTOP_ASSISTANCE: GlobalDesktopAssistantPresentation =
  Object.freeze({
    hostAvailable: false,
    readOnly: true,
    automaticRealtimeAllowed: false,
    manualAnalysisAllowed: false,
    guardedAcceptAllowed: false,
    sourceText: null,
    status: "no-host",
    statusMessage: "No active text host",
    assistance: EMPTY_DESKTOP_ASSISTANCE,
  });

/**
 * Manual external-host orchestration over the existing desktop writing engine.
 * It owns invocation freshness but never sees a native host session identity.
 */
export class GlobalDesktopAssistantController {
  readonly #surface: ActiveTextSurfacePort;
  readonly #provider: AnalysisProvider;
  readonly #present: PresentGlobalDesktopAssistant;
  readonly #options: GlobalDesktopAssistantControllerOptions;

  #engine: DesktopEngineController | null = null;
  #capture: ActiveTextSurfaceCapture | null = null;
  #mode: DesktopHostAssistanceMode | null = null;
  #currentAcceptTargets = new Set<DesktopNormalizedAcceptTarget>();
  #invocation = 0;
  #disposed = false;

  constructor(
    surface: ActiveTextSurfacePort,
    provider: AnalysisProvider,
    present: PresentGlobalDesktopAssistant,
    options: GlobalDesktopAssistantControllerOptions = {},
  ) {
    this.#surface = surface;
    this.#provider = provider;
    this.#present = present;
    this.#options = options;
    this.#present(EMPTY_GLOBAL_DESKTOP_ASSISTANCE);
  }

  async analyzeActiveTextSurface(
    options: GlobalDesktopManualAnalysisOptions = {},
  ): Promise<GlobalDesktopManualAnalysisResult> {
    if (this.#disposed) {
      return "obsolete";
    }

    const invocation = ++this.#invocation;
    this.#clearCurrentCapture();
    this.#present(Object.freeze({
      ...EMPTY_GLOBAL_DESKTOP_ASSISTANCE,
      status: "capturing",
      statusMessage: "Capturing active text",
    }));

    let capture: ActiveTextSurfaceCapture | null;
    try {
      const captured = await this.#surface.capture();
      capture = captured === null
        ? null
        : createActiveTextSurfaceCapture(captured);
    } catch {
      capture = null;
    }

    if (this.#disposed || invocation !== this.#invocation) {
      return "obsolete";
    }
    if (capture === null) {
      this.#present(EMPTY_GLOBAL_DESKTOP_ASSISTANCE);
      return "unavailable";
    }

    const mode = deriveDesktopHostAssistanceMode(capture);
    this.#capture = capture;
    this.#mode = mode;

    if (!/\S/u.test(capture.context.text)) {
      this.#present(this.#captureState(
        "empty",
        "No analyzable text in the active host",
      ));
      return "empty";
    }
    if (capture.context.composition !== null) {
      this.#present(this.#captureState(
        "composition-active",
        "Finish composing text before analysis",
      ));
      return "composition-active";
    }
    if (!mode.manualAnalysisAllowed) {
      this.#present(this.#captureState(
        "empty",
        "No analyzable text in the active host",
      ));
      return "empty";
    }
    if (options.configurationRequired === true) {
      this.#present(this.#captureState(
        "configuration-required",
        "Configure a provider in the main app to analyze this text",
      ));
      return "configuration-required";
    }

    let engine!: DesktopEngineController;
    engine = new DesktopEngineController(
      this.#provider,
      (assistance) => {
        if (
          !this.#disposed &&
          invocation === this.#invocation &&
          this.#engine === engine
        ) {
          this.#presentEngineState(capture, mode, assistance);
        }
      },
      {
        ...this.#options,
        automaticAnalysisEnabled: false,
      },
    );
    this.#engine = engine;
    engine.observe(
      capture.context,
      mode.guardedAcceptAllowed ? capture.editPort : null,
      { suppressAutomaticAnalysis: true },
    );
    const outcome = await engine.analyze(capture.context);

    if (
      this.#disposed ||
      invocation !== this.#invocation ||
      this.#engine !== engine
    ) {
      return "obsolete";
    }
    return outcome?.status ?? "empty";
  }

  async acceptNormalized(
    target: DesktopNormalizedAcceptTarget,
  ): Promise<DesktopNormalizedAcceptResult> {
    const engine = this.#engine;
    const mode = this.#mode;
    const invocation = this.#invocation;
    if (
      this.#disposed ||
      engine === null ||
      mode === null ||
      !mode.guardedAcceptAllowed ||
      !this.#currentAcceptTargets.has(target)
    ) {
      return "obsolete";
    }

    const result = await engine.acceptNormalized(target);
    if (
      result === "accepted" &&
      !this.#disposed &&
      invocation === this.#invocation &&
      this.#engine === engine
    ) {
      this.#invocation += 1;
      this.#clearCurrentCapture();
      this.#present(Object.freeze({
        hostAvailable: true,
        readOnly: !mode.guardedAcceptAllowed,
        automaticRealtimeAllowed: mode.automaticRealtimeAllowed,
        manualAnalysisAllowed: mode.manualAnalysisAllowed,
        guardedAcceptAllowed: false,
        sourceText: null,
        status: "updated",
        statusMessage: "Active host text was updated",
        assistance: EMPTY_DESKTOP_ASSISTANCE,
      }));
    }
    return result;
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#invocation += 1;
    this.#clearCurrentCapture();
  }

  #presentEngineState(
    capture: ActiveTextSurfaceCapture,
    mode: DesktopHostAssistanceMode,
    assistance: DesktopAssistancePresentation,
  ): void {
    this.#currentAcceptTargets = new Set(
      assistance.active?.normalizedTracks.flatMap((track) =>
        track.canAccept && track.acceptTarget !== null
          ? [track.acceptTarget]
          : []) ?? [],
    );
    const active = assistance.active;
    this.#present(Object.freeze({
      hostAvailable: true,
      readOnly: !mode.guardedAcceptAllowed,
      automaticRealtimeAllowed: mode.automaticRealtimeAllowed,
      manualAnalysisAllowed: mode.manualAnalysisAllowed,
      guardedAcceptAllowed:
        mode.guardedAcceptAllowed && this.#currentAcceptTargets.size > 0,
      sourceText: capture.context.text,
      status: active?.status ?? "idle",
      statusMessage: active?.statusMessage ?? "No active writing unit",
      assistance,
    }));
  }

  #captureState(
    status: "empty" | "composition-active" | "configuration-required",
    statusMessage: string,
  ): GlobalDesktopAssistantPresentation {
    const capture = this.#capture!;
    const mode = this.#mode!;
    return Object.freeze({
      hostAvailable: true,
      readOnly: !mode.guardedAcceptAllowed,
      automaticRealtimeAllowed: mode.automaticRealtimeAllowed,
      manualAnalysisAllowed: mode.manualAnalysisAllowed,
      guardedAcceptAllowed: false,
      sourceText: capture.context.text,
      status,
      statusMessage,
      assistance: EMPTY_DESKTOP_ASSISTANCE,
    });
  }

  #clearCurrentCapture(): void {
    this.#engine?.dispose();
    this.#engine = null;
    this.#capture = null;
    this.#mode = null;
    this.#currentAcceptTargets.clear();
  }
}
