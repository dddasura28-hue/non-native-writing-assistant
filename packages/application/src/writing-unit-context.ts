import { createSegmentRange } from "@non-native-writing/core";

import {
  createAnalysisContext,
  type AnalysisContext,
} from "./analysis-context.js";
import type { ContextSelection } from "./context-selector.js";
import type { TextRange } from "./text-context.js";
import type { WritingUnit } from "./writing-unit.js";

export function mapWritingUnitToSourceRange(
  selection: ContextSelection,
  unit: WritingUnit,
): TextRange {
  assertUnitMapsToSelection(selection, unit);
  return createSegmentRange(
    selection.sourceRange.start + unit.range.start,
    selection.sourceRange.start + unit.range.end,
  );
}

export function createWritingUnitAnalysisContext(
  selection: ContextSelection,
  unit: WritingUnit,
): AnalysisContext {
  const beforeInBlock = selection.activeText.slice(0, unit.range.start);
  const afterInBlock = selection.activeText.slice(unit.range.end);

  return createAnalysisContext({
    activeText: unit.text,
    sourceRange: mapWritingUnitToSourceRange(selection, unit),
    beforeContext: joinContext(selection.beforeContext, beforeInBlock),
    afterContext: joinContext(afterInBlock, selection.afterContext),
  });
}

/** Chooses a unit deterministically from a UTF-16 offset in activeText. */
export function selectCurrentWritingUnit(
  units: readonly WritingUnit[],
  cursorRelativeOffset: number,
): WritingUnit | null {
  if (!Number.isSafeInteger(cursorRelativeOffset) || cursorRelativeOffset < 0) {
    throw new RangeError("The cursor-relative offset must be non-negative.");
  }
  if (units.length === 0) {
    return null;
  }

  let previous: WritingUnit | undefined;
  for (const unit of units) {
    if (
      cursorRelativeOffset >= unit.range.start &&
      cursorRelativeOffset < unit.range.end
    ) {
      return unit;
    }
    if (cursorRelativeOffset < unit.range.start) {
      return previous ?? unit;
    }
    previous = unit;
  }

  // Includes the end of an unfinished final unit and trailing unit whitespace.
  return previous ?? null;
}

function assertUnitMapsToSelection(
  selection: ContextSelection,
  unit: WritingUnit,
): void {
  if (
    unit.range.end > selection.activeText.length ||
    selection.activeText.slice(unit.range.start, unit.range.end) !== unit.text
  ) {
    throw new TypeError("WritingUnit must map exactly to selection.activeText.");
  }
}

function joinContext(first: string, second: string): string {
  if (first.length === 0) {
    return second;
  }
  if (second.length === 0) {
    return first;
  }
  return `${first}\n\n${second}`;
}
