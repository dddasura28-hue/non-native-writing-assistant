import type {
  TextContext,
  TextEditPort,
} from "@non-native-writing/application";

import {
  createActiveTextSurfaceCapture,
  type ActiveTextSurfaceCapture,
} from "./active-text-surface.js";
import { DESKTOP_HOST_CAPABILITIES } from "./textarea-text-context-adapter.js";
import {
  createCapturedTextareaEditPort,
  type TextareaEditTarget,
  type TextareaSessionState,
} from "./textarea-text-edit-port.js";

export interface CapturedTextareaTextSurfaceOptions {
  readonly target: TextareaEditTarget;
  readonly context: TextContext;
  readonly session: TextareaSessionState;
  readonly getCurrentSession: () => TextareaSessionState;
  readonly onDidReplace: (context: TextContext) => void;
}

/** Binds the owned textarea's capture and one-shot edit port to one host view. */
export function createCapturedTextareaTextSurface(
  options: CapturedTextareaTextSurfaceOptions,
): ActiveTextSurfaceCapture & { readonly editPort: TextEditPort } {
  const editPort = createCapturedTextareaEditPort(options);
  const capture = createActiveTextSurfaceCapture({
    context: options.context,
    capabilities: DESKTOP_HOST_CAPABILITIES,
    editPort,
  });
  return Object.freeze({
    context: capture.context,
    capabilities: capture.capabilities,
    editPort,
  });
}
