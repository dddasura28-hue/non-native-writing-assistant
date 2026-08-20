import { createSegmentRange } from "@non-native-writing/core";

import type { TextContext, TextRange } from "./text-context.js";

export interface ContextSelection {
  /** The text selected for the existing analysis pipeline. */
  readonly activeText: string;
  /** The active text's UTF-16, half-open range within TextContext.text. */
  readonly sourceRange: TextRange;
  readonly beforeContext: string;
  readonly afterContext: string;
}

export interface ContextSelector {
  select(context: TextContext): ContextSelection | null;
}

export function assertContextSelectionMapsToText(
  context: TextContext,
  selection: ContextSelection,
): void {
  const range = createSegmentRange(
    selection.sourceRange.start,
    selection.sourceRange.end,
  );
  if (
    range.end > context.text.length ||
    context.text.slice(range.start, range.end) !== selection.activeText
  ) {
    throw new TypeError("ContextSelection must map exactly to TextContext.text.");
  }
}

/** Selects all text made available by a host, which may be less than a document. */
export class WholeAvailableContextSelector implements ContextSelector {
  select(context: TextContext): ContextSelection | null {
    if (context.text.length === 0) {
      return null;
    }

    const fullRange = createSegmentRange(0, context.text.length);
    return compositionOverlaps(context, fullRange)
      ? null
      : createContextSelection(context, fullRange);
  }
}

/**
 * Selects an explicit user selection first. Otherwise it selects the cursor's
 * maximal run of non-blank lines; one or more blank/whitespace-only lines are
 * separators. A cursor in a separator has no active analysis region.
 * Composition overlapping active text blocks analysis; an adjacent composing
 * block is omitted from read-only context.
 */
export class LocalBlockContextSelector implements ContextSelector {
  select(context: TextContext): ContextSelection | null {
    const blocks = findTextBlocks(context.text);

    if (context.selection !== null) {
      return this.#selectRange(context, blocks, context.selection);
    }

    const blockIndex = blocks.findIndex(
      (block) =>
        context.cursorOffset >= block.start &&
        context.cursorOffset <= block.end,
    );
    if (blockIndex < 0) {
      return null;
    }

    const activeBlock = blocks[blockIndex]!;
    if (compositionOverlaps(context, activeBlock)) {
      return null;
    }

    return createContextSelection(
      context,
      activeBlock,
      contextBlockWithoutComposition(context, blocks[blockIndex - 1]),
      contextBlockWithoutComposition(context, blocks[blockIndex + 1]),
    );
  }

  #selectRange(
    context: TextContext,
    blocks: readonly TextRange[],
    range: TextRange,
  ): ContextSelection | null {
    if (compositionOverlaps(context, range)) {
      return null;
    }

    let beforeBlock: TextRange | undefined;
    let afterBlock: TextRange | undefined;
    for (const block of blocks) {
      if (block.end <= range.start) {
        beforeBlock = block;
      } else if (afterBlock === undefined && block.start >= range.end) {
        afterBlock = block;
      }
    }

    return createContextSelection(
      context,
      range,
      contextBlockWithoutComposition(context, beforeBlock),
      contextBlockWithoutComposition(context, afterBlock),
    );
  }
}

interface TextLine {
  readonly start: number;
  readonly contentEnd: number;
  readonly blank: boolean;
}

function createContextSelection(
  context: TextContext,
  sourceRange: TextRange,
  beforeBlock?: TextRange,
  afterBlock?: TextRange,
): ContextSelection {
  const range = createSegmentRange(sourceRange.start, sourceRange.end);
  if (range.end > context.text.length) {
    throw new RangeError("ContextSelection sourceRange exceeds TextContext.text.");
  }

  const activeText = context.text.slice(range.start, range.end);
  const selection = Object.freeze({
    activeText,
    sourceRange: range,
    beforeContext:
      beforeBlock === undefined
        ? ""
        : context.text.slice(beforeBlock.start, beforeBlock.end),
    afterContext:
      afterBlock === undefined
        ? ""
        : context.text.slice(afterBlock.start, afterBlock.end),
  });

  assertContextSelectionMapsToText(context, selection);

  return selection;
}

function findTextBlocks(text: string): readonly TextRange[] {
  const blocks: TextRange[] = [];
  let blockStart: number | undefined;
  let blockEnd = 0;

  for (const line of findTextLines(text)) {
    if (line.blank) {
      if (blockStart !== undefined) {
        blocks.push(createSegmentRange(blockStart, blockEnd));
        blockStart = undefined;
      }
      continue;
    }

    blockStart ??= line.start;
    blockEnd = line.contentEnd;
  }

  if (blockStart !== undefined) {
    blocks.push(createSegmentRange(blockStart, blockEnd));
  }

  return Object.freeze(blocks);
}

function findTextLines(text: string): readonly TextLine[] {
  const lines: TextLine[] = [];
  let start = 0;

  while (start < text.length) {
    let contentEnd = start;
    while (
      contentEnd < text.length &&
      text[contentEnd] !== "\r" &&
      text[contentEnd] !== "\n"
    ) {
      contentEnd += 1;
    }

    let nextLineStart = contentEnd;
    if (text[nextLineStart] === "\r" && text[nextLineStart + 1] === "\n") {
      nextLineStart += 2;
    } else if (
      text[nextLineStart] === "\r" ||
      text[nextLineStart] === "\n"
    ) {
      nextLineStart += 1;
    }

    lines.push(
      Object.freeze({
        start,
        contentEnd,
        blank: text.slice(start, contentEnd).trim().length === 0,
      }),
    );
    start = nextLineStart;
  }

  return Object.freeze(lines);
}

function compositionOverlaps(
  context: TextContext,
  range: TextRange,
): boolean {
  const composition = context.composition;
  if (composition === null) {
    return false;
  }

  if (composition.start === composition.end) {
    return composition.start >= range.start && composition.start <= range.end;
  }

  return composition.start < range.end && range.start < composition.end;
}

function contextBlockWithoutComposition(
  context: TextContext,
  block: TextRange | undefined,
): TextRange | undefined {
  return block !== undefined && compositionOverlaps(context, block)
    ? undefined
    : block;
}
