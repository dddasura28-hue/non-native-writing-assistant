import { createSegmentRange } from "@non-native-writing/core";
import type { SegmentRange } from "@non-native-writing/core";

/** A UTF-16, half-open range relative to a host-provided text value. */
export type TextRange = SegmentRange;

export interface TextComposition {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface TextContext {
  /** Text available to the host; this need not be a complete document. */
  readonly text: string;
  /** Active/primary cursor offset relative to text. */
  readonly cursorOffset: number;
  /** Null is the canonical representation of no selected text. */
  readonly selection: TextRange | null;
  /** Uncommitted input-method text, when exposed by the host. */
  readonly composition: TextComposition | null;
}

export interface CreateTextContextInput {
  readonly text: string;
  readonly cursorOffset: number;
  readonly selection: TextRange | null;
  readonly composition: TextComposition | null;
}

export function createTextContext(
  input: CreateTextContextInput,
): TextContext {
  assertOffsetWithinText(input.cursorOffset, input.text.length, "cursorOffset");

  const selection =
    input.selection === null
      ? null
      : createBoundedRange(input.selection, input.text.length, "selection");
  const canonicalSelection =
    selection !== null && selection.start === selection.end ? null : selection;
  const composition =
    input.composition === null
      ? null
      : Object.freeze({
          ...createBoundedRange(
            input.composition,
            input.text.length,
            "composition",
          ),
          text: input.composition.text,
        });

  return Object.freeze({
    text: input.text,
    cursorOffset: input.cursorOffset,
    selection: canonicalSelection,
    composition,
  });
}

export function selectedText(context: TextContext): string | null {
  return context.selection === null
    ? null
    : context.text.slice(context.selection.start, context.selection.end);
}

function createBoundedRange(
  range: TextRange,
  textLength: number,
  name: string,
): TextRange {
  const validated = createSegmentRange(range.start, range.end);
  if (validated.end > textLength) {
    throw new RangeError(`${name} end must not exceed text.length.`);
  }
  return validated;
}

function assertOffsetWithinText(
  offset: number,
  textLength: number,
  name: string,
): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > textLength) {
    throw new RangeError(
      `${name} must be an integer between 0 and text.length.`,
    );
  }
}
