import {
  assertTextReplacementMatches,
  type TextContext,
  type TextEditPort,
  type TextReplacement,
} from "@non-native-writing/application";

import {
  captureTextareaTextContext,
  type TextareaSnapshotSource,
} from "./textarea-text-context-adapter.js";

export interface TextareaEditTarget extends TextareaSnapshotSource {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  selectionDirection: "forward" | "backward" | "none";
  setRangeText(
    replacement: string,
    start: number,
    end: number,
    selectionMode: "end",
  ): void;
}

export interface TextareaSessionState {
  /** Opaque, process-local identity for the current mounted editor session. */
  readonly token: symbol;
  /** Advances for text mutations and composition state transitions. */
  readonly generation: number;
  readonly compositionActive: boolean;
}

export interface CapturedTextareaEditPortOptions {
  readonly target: TextareaEditTarget;
  readonly context: TextContext;
  readonly session: TextareaSessionState;
  readonly getCurrentSession: () => TextareaSessionState;
  readonly onDidReplace: (context: TextContext) => void;
}

/** Creates a one-shot edit port bound to one captured textarea session. */
export function createCapturedTextareaEditPort(
  options: CapturedTextareaEditPortOptions,
): TextEditPort {
  const target = options.target;
  const capturedContext = options.context;
  const capturedSession = options.session;
  let valid = true;

  return Object.freeze({
    replace(replacement: TextReplacement): void {
      if (!valid) {
        throw new Error("The captured desktop edit session is no longer current.");
      }

      const currentSession = options.getCurrentSession();
      if (
        capturedContext.composition !== null ||
        currentSession.compositionActive
      ) {
        throw new Error("Text cannot be replaced during active composition.");
      }
      if (
        currentSession.token !== capturedSession.token ||
        currentSession.generation !== capturedSession.generation ||
        target.value !== capturedContext.text
      ) {
        throw new Error("The captured desktop edit session is no longer current.");
      }

      assertTextReplacementMatches(target.value, replacement);
      target.setRangeText(
        replacement.replacementText,
        replacement.range.start,
        replacement.range.end,
        "end",
      );

      valid = false;
      options.onDidReplace(captureTextareaTextContext(target));
    },
  });
}
