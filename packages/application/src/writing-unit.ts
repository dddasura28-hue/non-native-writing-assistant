import { createSegmentRange } from "@non-native-writing/core";

import type { TextRange } from "./text-context.js";

/**
 * A source-mappable writing fragment for analysis-layer use. Its identity is
 * meaningful only within the selection analysis that created it.
 */
export interface WritingUnit {
  readonly id: string;
  readonly text: string;
  /** UTF-16, half-open offsets relative to the segmented text. */
  readonly range: TextRange;
  /** Zero-based position within the segmenter's result. */
  readonly order: number;
}

export interface CreateWritingUnitInput {
  readonly id: string;
  readonly sourceText: string;
  readonly range: TextRange;
  readonly order: number;
}

export function createWritingUnit(
  input: CreateWritingUnitInput,
): WritingUnit {
  if (input.id.trim().length === 0) {
    throw new TypeError("WritingUnit id must not be empty.");
  }
  if (!Number.isSafeInteger(input.order) || input.order < 0) {
    throw new RangeError("WritingUnit order must be a non-negative integer.");
  }

  const range = createSegmentRange(input.range.start, input.range.end);
  if (range.end > input.sourceText.length) {
    throw new RangeError("WritingUnit range must not exceed sourceText.");
  }

  const text = input.sourceText.slice(range.start, range.end);
  if (!/\S/u.test(text)) {
    throw new TypeError("WritingUnit text must contain non-whitespace content.");
  }

  return Object.freeze({
    id: input.id,
    text,
    range,
    order: input.order,
  });
}
