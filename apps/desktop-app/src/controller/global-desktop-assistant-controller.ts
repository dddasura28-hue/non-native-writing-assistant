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
import { traceGlobalInvocation } from "../native/global-invocation-diagnostics.js";

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
  readonly invocationId: number | null;
  readonly presentationRevision: number;
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
    invocationId: null,
    presentationRevision: 0,
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
 * Native invocation identity remains authoritative through provider completion.
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
  #currentInvocationId = 0;
  #presentationRevision = 0;
  #configurationRequired = false;
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
    invocationId: number,
    options: GlobalDesktopManualAnalysisOptions = {},
  ): Promise<GlobalDesktopManualAnalysisResult> {
    if (
      this.#disposed ||
      !Number.isSafeInteger(invocationId) ||
      invocationId <= this.#currentInvocationId
    ) {
      traceGlobalInvocation(invocationId, "invocation-discarded", this.#disposed ? "disposed" : "stale");
      return "obsolete";
    }

    this.#currentInvocationId = invocationId;
    traceGlobalInvocation(invocationId, "controller-invocation", "started");
    this.#presentationRevision = 0;
    if (options.configurationRequired !== undefined) {
      this.#configurationRequired = options.configurationRequired;
    }
    this.#clearCurrentCapture();
    this.#presentCurrent({
      ...EMPTY_GLOBAL_DESKTOP_ASSISTANCE,
      status: "capturing",
      statusMessage: "Capturing active text",
    });

    let capture: ActiveTextSurfaceCapture | null;
    try {
      const captured = await this.#surface.capture();
      capture = captured === null
        ? null
        : createActiveTextSurfaceCapture(captured);
    } catch {
      capture = null;
    }

    if (this.#disposed || invocationId !== this.#currentInvocationId) {
      traceGlobalInvocation(invocationId, "invocation-discarded", this.#disposed ? "disposed" : "stale");
      return "obsolete";
    }
    if (capture === null) {
      traceGlobalInvocation(invocationId, "analysis", "skipped", { reason: "unavailable" });
      this.#presentCurrent(EMPTY_GLOBAL_DESKTOP_ASSISTANCE);
      return "unavailable";
    }

    const mode = deriveDesktopHostAssistanceMode(capture);
    this.#capture = capture;
    this.#mode = mode;

    if (!/\S/u.test(capture.context.text)) {
      traceGlobalInvocation(invocationId, "analysis", "skipped", { reason: "empty" });
      this.#presentCurrent(this.#captureState(
        "empty",
        "No analyzable text in the active host",
      ));
      return "empty";
    }
    if (capture.context.composition !== null) {
      traceGlobalInvocation(invocationId, "analysis", "skipped", { reason: "composition-active" });
      this.#presentCurrent(this.#captureState(
        "composition-active",
        "Finish composing text before analysis",
      ));
      return "composition-active";
    }
    if (!mode.manualAnalysisAllowed) {
      traceGlobalInvocation(invocationId, "analysis", "skipped", { reason: "manual-disallowed" });
      this.#presentCurrent(this.#captureState(
        "empty",
        "No analyzable text in the active host",
      ));
      return "empty";
    }
    if (this.#configurationRequired) {
      traceGlobalInvocation(invocationId, "analysis", "skipped", { reason: "configuration-required" });
      this.#presentCurrent(this.#captureState(
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
          invocationId === this.#currentInvocationId &&
          this.#engine === engine
        ) {
          this.#presentEngineState(capture, mode, assistance);
        } else {
          traceGlobalInvocation(invocationId, "invocation-discarded", this.#disposed ? "disposed" : "stale");
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
    traceGlobalInvocation(invocationId, "analysis", "started", {
      utf16Length: capture.context.text.length,
    });
    const outcome = await engine.analyze(capture.context);

    if (
      this.#disposed ||
      invocationId !== this.#currentInvocationId ||
      this.#engine !== engine
    ) {
      traceGlobalInvocation(invocationId, "invocation-discarded", this.#disposed ? "disposed" : "stale");
      return "obsolete";
    }
    return outcome?.status ?? "empty";
  }

  async acceptNormalized(
    target: DesktopNormalizedAcceptTarget,
  ): Promise<DesktopNormalizedAcceptResult> {
    const engine = this.#engine;
    const mode = this.#mode;
    const invocationId = this.#currentInvocationId;
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
      invocationId === this.#currentInvocationId &&
      this.#engine === engine
    ) {
      this.#clearCurrentCapture();
      this.#presentCurrent({
        hostAvailable: true,
        readOnly: !mode.guardedAcceptAllowed,
        automaticRealtimeAllowed: mode.automaticRealtimeAllowed,
        manualAnalysisAllowed: mode.manualAnalysisAllowed,
        guardedAcceptAllowed: false,
        sourceText: null,
        status: "updated",
        statusMessage: "Active host text was updated",
        assistance: EMPTY_DESKTOP_ASSISTANCE,
      });
    }
    return result;
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#clearCurrentCapture();
  }

  setConfigurationRequired(required: boolean): void {
    if (this.#disposed || required === this.#configurationRequired) {
      return;
    }
    this.#configurationRequired = required;
    if (!required || this.#capture === null || this.#mode === null) {
      return;
    }

    this.#engine?.dispose();
    this.#engine = null;
    this.#currentAcceptTargets.clear();
    this.#presentCurrent(this.#captureState(
      "configuration-required",
      "Configure a provider in the main app to analyze this text",
    ));
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
    this.#presentCurrent({
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
    });
  }

  #captureState(
    status: "empty" | "composition-active" | "configuration-required",
    statusMessage: string,
  ): Omit<
    GlobalDesktopAssistantPresentation,
    "invocationId" | "presentationRevision"
  > {
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

  #presentCurrent(
    presentation: Omit<
      GlobalDesktopAssistantPresentation,
      "invocationId" | "presentationRevision"
    >,
  ): void {
    if (this.#disposed || this.#currentInvocationId < 1) {
      return;
    }
    this.#presentationRevision += 1;
    traceGlobalInvocation(this.#currentInvocationId, "presentation-emitted", presentation.status);
    this.#present(Object.freeze({
      ...presentation,
      invocationId: this.#currentInvocationId,
      presentationRevision: this.#presentationRevision,
    }));
  }
}
