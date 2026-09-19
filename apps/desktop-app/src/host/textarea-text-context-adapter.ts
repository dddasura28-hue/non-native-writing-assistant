import {
  createHostCapabilities,
  createTextContext,
  type HostCapabilities,
  type TextComposition,
  type TextContext,
} from "@non-native-writing/application";

export type TextareaSelectionDirection = "forward" | "backward" | "none";

/** The primitive textarea state needed at the desktop host boundary. */
export interface TextareaSnapshotSource {
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly selectionDirection: TextareaSelectionDirection;
}

export const DESKTOP_HOST_CAPABILITIES: HostCapabilities =
  createHostCapabilities({
    canReplaceText: true,
    canObserveComposition: true,
    canObserveSelection: true,
    canProvideSurroundingText: true,
  });

interface ActiveComposition {
  readonly originStart: number;
  data: string;
}

/**
 * Tracks browser composition events without exporting DOM objects. When the
 * event data maps exactly into the current textarea value, the exact pre-edit
 * range is exposed. During event-order transitions where it does not, a
 * zero-width marker at the observed current caret conservatively blocks
 * analysis without claiming a range the browser has not confirmed.
 */
export class TextareaCompositionTracker {
  #active: ActiveComposition | null = null;

  get active(): boolean {
    return this.#active !== null;
  }

  start(source: TextareaSnapshotSource, data = ""): void {
    const selection = normalizedSelection(source);
    this.#active = {
      originStart: selection.start,
      data,
    };
  }

  update(data: string): void {
    if (this.#active !== null) {
      this.#active.data = data;
    }
  }

  end(): void {
    this.#active = null;
  }

  capture(source: TextareaSnapshotSource): TextComposition | null {
    const active = this.#active;
    if (active === null) {
      return null;
    }

    const exactEnd = active.originStart + active.data.length;
    if (
      active.originStart <= source.value.length &&
      exactEnd <= source.value.length &&
      source.value.slice(active.originStart, exactEnd) === active.data
    ) {
      return Object.freeze({
        start: active.originStart,
        end: exactEnd,
        text: active.data,
      });
    }

    const caret = Math.min(
      activeCaretOffset(source),
      source.value.length,
    );
    return Object.freeze({ start: caret, end: caret, text: "" });
  }
}

export function captureTextareaTextContext(
  source: TextareaSnapshotSource,
  composition: TextComposition | null = null,
): TextContext {
  const selection = normalizedSelection(source);

  return createTextContext({
    text: source.value,
    cursorOffset: activeCaretOffset(source),
    selection:
      selection.start === selection.end
        ? null
        : { start: selection.start, end: selection.end },
    composition,
  });
}

function normalizedSelection(
  source: TextareaSnapshotSource,
): { readonly start: number; readonly end: number } {
  return {
    start: Math.min(source.selectionStart, source.selectionEnd),
    end: Math.max(source.selectionStart, source.selectionEnd),
  };
}

function activeCaretOffset(source: TextareaSnapshotSource): number {
  const selection = normalizedSelection(source);
  return source.selectionDirection === "backward"
    ? selection.start
    : selection.end;
}
