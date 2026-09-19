import { createSegmentRange } from "@non-native-writing/core";

import type { TextContext, TextRange } from "./text-context.js";

/** Exact replacement data relative to the captured TextContext.text. */
export interface TextReplacement {
  /** UTF-16 code units, half-open [start, end); never editor positions. */
  readonly range: TextRange;
  readonly expectedText: string;
  readonly replacementText: string;
}

/**
 * A port instance is bound by the host to ONE captured session, revision and
 * available-text coordinate window. It must never retarget the active editor.
 * Only a future explicit user apply action may invoke it, after checking the
 * result's existing DependencyStamp/source fingerprint for currentness.
 *
 * The host must atomically check that the captured session is still available,
 * its revision/window is unchanged, composition permits writing, and the exact
 * current slice equals expectedText, then perform its normal undoable edit.
 * Reject by throwing/rejecting without mutation if any check fails or cannot
 * be guaranteed. Async hosts must check at commit, not only before awaiting.
 * A successful edit invalidates this captured port. No runtime adapter yet.
 */
export interface TextEditPort {
  replace(replacement: TextReplacement): Promise<void> | void;
}

export function createTextReplacement(
  context: TextContext,
  input: TextReplacement,
): TextReplacement {
  const replacement = Object.freeze({
    range: createSegmentRange(input.range.start, input.range.end),
    expectedText: input.expectedText,
    replacementText: input.replacementText,
  });
  assertTextReplacementMatches(context.text, replacement);
  return replacement;
}

/** Pure text guard only; session/revision/composition checks remain host-owned. */
export function assertTextReplacementMatches(
  text: string,
  replacement: TextReplacement,
): void {
  const range = createSegmentRange(replacement.range.start, replacement.range.end);
  if (range.end > text.length) {
    throw new RangeError("TextReplacement range exceeds available text.");
  }
  if (text.slice(range.start, range.end) !== replacement.expectedText) {
    throw new Error("TextReplacement expectedText does not match source text.");
  }
}
