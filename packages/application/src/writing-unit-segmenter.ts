import { createWritingUnit, type WritingUnit } from "./writing-unit.js";

export interface WritingUnitSegmenter {
  segment(text: string): readonly WritingUnit[];
}

const EMPTY_WRITING_UNITS: readonly WritingUnit[] = Object.freeze([]);
const SENTENCE_BOUNDARIES = new Set([".", "!", "?", "。", "！", "？"]);

/**
 * Splits on sentence punctuation and blank-line paragraph breaks. Sentence
 * punctuation stays with the preceding unit. Whitespace immediately following
 * a sentence boundary and blank-line separators remain outside units; all
 * characters inside a returned range are preserved without trimming.
 */
export class SimpleWritingUnitSegmenter implements WritingUnitSegmenter {
  segment(text: string): readonly WritingUnit[] {
    if (!containsNonWhitespace(text)) {
      return EMPTY_WRITING_UNITS;
    }

    const units: WritingUnit[] = [];
    let unitStart = 0;
    let cursor = 0;

    const appendUnit = (start: number, end: number): void => {
      if (start >= end || !containsNonWhitespace(text.slice(start, end))) {
        return;
      }

      const order = units.length;
      units.push(
        createWritingUnit({
          id: `writing-unit:${order}`,
          sourceText: text,
          range: { start, end },
          order,
        }),
      );
    };

    while (cursor < text.length) {
      const paragraphEnd = paragraphBreakEndAt(text, cursor);
      if (paragraphEnd !== undefined) {
        appendUnit(unitStart, cursor);
        cursor = paragraphEnd;
        unitStart = cursor;
        continue;
      }

      if (isSentenceBoundary(text[cursor])) {
        cursor += 1;
        while (isSentenceBoundary(text[cursor])) {
          cursor += 1;
        }
        appendUnit(unitStart, cursor);

        while (cursor < text.length && isWhitespace(text[cursor])) {
          cursor += 1;
        }
        unitStart = cursor;
        continue;
      }

      cursor += 1;
    }

    appendUnit(unitStart, text.length);
    return Object.freeze(units);
  }
}

function isSentenceBoundary(value: string | undefined): boolean {
  return value !== undefined && SENTENCE_BOUNDARIES.has(value);
}

function isWhitespace(value: string | undefined): boolean {
  return value !== undefined && /\s/u.test(value);
}

function containsNonWhitespace(value: string): boolean {
  return /\S/u.test(value);
}

function paragraphBreakEndAt(
  text: string,
  offset: number,
): number | undefined {
  let cursor = consumeLineBreak(text, offset);
  if (cursor === undefined) {
    return undefined;
  }

  cursor = consumeHorizontalWhitespace(text, cursor);
  const secondLineBreakEnd = consumeLineBreak(text, cursor);
  if (secondLineBreakEnd === undefined) {
    return undefined;
  }
  cursor = secondLineBreakEnd;

  while (cursor < text.length) {
    const nextLineBreakStart = consumeHorizontalWhitespace(text, cursor);
    const nextLineBreakEnd = consumeLineBreak(text, nextLineBreakStart);
    if (nextLineBreakEnd === undefined) {
      break;
    }
    cursor = nextLineBreakEnd;
  }

  return cursor;
}

function consumeLineBreak(
  text: string,
  offset: number,
): number | undefined {
  if (text[offset] === "\r" && text[offset + 1] === "\n") {
    return offset + 2;
  }
  if (text[offset] === "\r" || text[offset] === "\n") {
    return offset + 1;
  }
  return undefined;
}

function consumeHorizontalWhitespace(text: string, offset: number): number {
  let cursor = offset;
  while (text[cursor] === " " || text[cursor] === "\t") {
    cursor += 1;
  }
  return cursor;
}
