import {
  createHostCapabilities,
  createTextContext,
  type HostCapabilities,
  type TextContext,
  type TextEditPort,
} from "@non-native-writing/application";

/** One truthful, host-local capture of the currently active text surface. */
export interface ActiveTextSurfaceCapture {
  readonly context: TextContext;
  readonly capabilities: HostCapabilities;
  readonly editPort: TextEditPort | null;
}

/** Desktop-host seam for a future external application adapter. */
export interface ActiveTextSurfacePort {
  capture(): Promise<ActiveTextSurfaceCapture | null>;
}

export interface DesktopHostAssistanceMode {
  readonly automaticRealtimeAllowed: boolean;
  readonly manualAnalysisAllowed: boolean;
  readonly guardedAcceptAllowed: boolean;
}

export function createActiveTextSurfaceCapture(
  input: ActiveTextSurfaceCapture,
): ActiveTextSurfaceCapture {
  const context = createTextContext(input.context);
  const capabilities = createHostCapabilities(input.capabilities);

  if (!capabilities.canObserveSelection && context.selection !== null) {
    throw new TypeError(
      "A host without selection observation cannot report a precise selection.",
    );
  }
  if (!capabilities.canObserveComposition && context.composition !== null) {
    throw new TypeError(
      "A host without composition observation cannot report a composition range.",
    );
  }
  if (capabilities.canReplaceText !== (input.editPort !== null)) {
    throw new TypeError(
      "Replace capability must agree with the presence of a guarded TextEditPort.",
    );
  }

  return Object.freeze({
    context,
    capabilities,
    editPort: input.editPort,
  });
}

/** Pure capability policy; it never infers missing host information. */
export function deriveDesktopHostAssistanceMode(
  capture: ActiveTextSurfaceCapture,
): DesktopHostAssistanceMode {
  const hasAnalyzableText = /\S/u.test(capture.context.text);
  const compositionActive = capture.context.composition !== null;

  return Object.freeze({
    automaticRealtimeAllowed:
      hasAnalyzableText &&
      capture.capabilities.canObserveComposition &&
      !compositionActive,
    manualAnalysisAllowed: hasAnalyzableText && !compositionActive,
    guardedAcceptAllowed:
      capture.capabilities.canReplaceText &&
      capture.editPort !== null &&
      !compositionActive,
  });
}
