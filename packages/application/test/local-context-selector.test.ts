import { describe, expect, it } from "vitest";

import {
  LocalBlockContextSelector,
  assertContextSelectionMapsToText,
  createTextContext,
  type ContextSelection,
  type TextComposition,
  type TextRange,
} from "../src/index.js";

interface ContextOptions {
  readonly selection?: TextRange | null;
  readonly composition?: TextComposition | null;
}

const selector = new LocalBlockContextSelector();

function select(
  text: string,
  cursorOffset: number,
  options: ContextOptions = {},
): ContextSelection | null {
  return selector.select(
    createTextContext({
      text,
      cursorOffset,
      selection: options.selection ?? null,
      composition: options.composition ?? null,
    }),
  );
}

function expectExactMapping(text: string, selection: ContextSelection): void {
  expect(
    text.slice(selection.sourceRange.start, selection.sourceRange.end),
  ).toBe(selection.activeText);
}

describe("LocalBlockContextSelector", () => {
  it("selects the single block containing the cursor", () => {
    const text = "First line\nsecond line";
    const result = select(text, 4);

    expect(result?.activeText).toBe(text);
    expect(result?.sourceRange).toEqual({ start: 0, end: text.length });
  });

  it("selects only the middle block containing the cursor", () => {
    const text = "First block\n\nMiddle block\n\nLast block";
    const result = select(text, text.indexOf("Middle") + 3);

    expect(result?.activeText).toBe("Middle block");
  });

  it("uses the immediately preceding block as beforeContext", () => {
    const text = "First block\n\nMiddle block\n\nLast block";
    const result = select(text, text.indexOf("Middle"));

    expect(result?.beforeContext).toBe("First block");
  });

  it("uses the immediately following block as afterContext", () => {
    const text = "First block\n\nMiddle block\n\nLast block";
    const result = select(text, text.indexOf("Middle"));

    expect(result?.afterContext).toBe("Last block");
  });

  it("selects no more than one block on either side", () => {
    const text = "A\n\nB\n\nC\n\nD\n\nE";
    const result = select(text, text.indexOf("C"));

    expect(result).toMatchObject({
      activeText: "C",
      beforeContext: "B",
      afterContext: "D",
    });
    expect(JSON.stringify(result)).not.toContain('"A"');
    expect(JSON.stringify(result)).not.toContain('"E"');
  });

  it("returns null when the cursor is in a blank separator", () => {
    const text = "Block A\n\nBlock B";

    expect(select(text, 8)).toBeNull();
  });

  it("gives an explicit selection priority over the cursor block", () => {
    const text = "Block A\n\nBlock B\n\nBlock C";
    const start = text.indexOf("Block B");
    const end = start + "Block B".length;
    const result = select(text, 1, { selection: { start, end } });

    expect(result).toMatchObject({
      activeText: "Block B",
      sourceRange: { start, end },
      beforeContext: "Block A",
      afterContext: "Block C",
    });
  });

  it("preserves a multi-block explicit selection exactly", () => {
    const text = "Before\n\nSelected one\n\nSelected two\n\nAfter";
    const start = text.indexOf("Selected one");
    const end = text.indexOf("\n\nAfter");
    const result = select(text, 0, { selection: { start, end } });

    expect(result?.activeText).toBe("Selected one\n\nSelected two");
    expect(result?.sourceRange).toEqual({ start, end });
    expect(result?.beforeContext).toBe("Before");
    expect(result?.afterContext).toBe("After");
  });

  it("keeps every returned activeText exactly source-mappable", () => {
    const cases = [
      { text: "A", cursor: 1 },
      { text: "A\nB\n\nC", cursor: 2 },
      { text: "One\r\n\r\nTwo", cursor: 7 },
      { text: "A😀B\n\nC", cursor: 3 },
    ];

    for (const item of cases) {
      const result = select(item.text, item.cursor);
      expect(result).not.toBeNull();
      expectExactMapping(item.text, result!);
    }
  });

  it("rejects a ContextSelection whose activeText does not match its source range", () => {
    const context = createTextContext({
      text: "Actual text",
      cursorOffset: 0,
      selection: null,
      composition: null,
    });

    expect(() =>
      assertContextSelectionMapsToText(context, {
        activeText: "Different text",
        sourceRange: { start: 0, end: 6 },
        beforeContext: "",
        afterContext: "",
      }),
    ).toThrow(/map exactly/i);
  });

  it("preserves UTF-16 offsets around emoji", () => {
    const text = "A😀B\n\nNext";
    const result = select(text, 3);

    expect("A😀B".length).toBe(4);
    expect(result?.sourceRange).toEqual({ start: 0, end: 4 });
    expect(result?.activeText).toBe("A😀B");
    expectExactMapping(text, result!);
  });

  it("keeps CRLF source ranges exact", () => {
    const text = "One\r\n\r\nTwo line 1\r\nTwo line 2\r\n\r\nThree";
    const start = text.indexOf("Two line 1");
    const end = text.indexOf("\r\n\r\nThree");
    const result = select(text, start + 2);

    expect(result?.sourceRange).toEqual({ start, end });
    expect(result?.activeText).toBe("Two line 1\r\nTwo line 2");
    expectExactMapping(text, result!);
  });

  it("treats whitespace-only lines as block separators", () => {
    const text = "First\n \t \nSecond";

    expect(select(text, text.indexOf("Second"))).toMatchObject({
      activeText: "Second",
      beforeContext: "First",
    });
    expect(select(text, text.indexOf("\t"))).toBeNull();
  });

  it("does not trim meaningful block characters", () => {
    const text = "  indented  \ncontinued  \n\nNext";
    const result = select(text, text.indexOf("continued"));

    expect(result?.activeText).toBe("  indented  \ncontinued  ");
    expectExactMapping(text, result!);
  });

  it("returns null when composition overlaps the active region", () => {
    const text = "Before\n\nComposing 文本\n\nAfter";
    const start = text.indexOf("文本");

    expect(
      select(text, start, {
        composition: { start, end: start + 2, text: "文本" },
      }),
    ).toBeNull();
  });

  it("analyzes a non-overlapping region and omits composing context", () => {
    const text = "Composing 文本\n\nStable block\n\nAfter";
    const compositionStart = text.indexOf("文本");
    const result = select(text, text.indexOf("Stable"), {
      composition: {
        start: compositionStart,
        end: compositionStart + 2,
        text: "文本",
      },
    });

    expect(result).toMatchObject({
      activeText: "Stable block",
      beforeContext: "",
      afterContext: "After",
    });
  });
});
