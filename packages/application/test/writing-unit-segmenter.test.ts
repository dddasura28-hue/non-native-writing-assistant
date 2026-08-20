import { describe, expect, it } from "vitest";

import {
  SimpleWritingUnitSegmenter,
  createWritingUnit,
} from "../src/index.js";

const segmenter = new SimpleWritingUnitSegmenter();

describe("SimpleWritingUnitSegmenter", () => {
  it("produces one unit for a single sentence", () => {
    const text = "First sentence.";

    expect(segmenter.segment(text)).toEqual([
      {
        id: "writing-unit:0",
        text,
        range: { start: 0, end: text.length },
        order: 0,
      },
    ]);
  });

  it("produces ordered units for multiple sentences", () => {
    const text = "First sentence. Second sentence.";
    const units = segmenter.segment(text);

    expect(units.map((unit) => unit.text)).toEqual([
      "First sentence.",
      "Second sentence.",
    ]);
    expect(units.map((unit) => unit.order)).toEqual([0, 1]);
    expect(units.map((unit) => unit.id)).toEqual([
      "writing-unit:0",
      "writing-unit:1",
    ]);
  });

  it.each(["\n\n", "\r\n\r\n"])(
    "splits unfinished paragraphs separated by %j",
    (separator) => {
      const text = `First paragraph${separator}Second paragraph`;

      expect(segmenter.segment(text).map((unit) => unit.text)).toEqual([
        "First paragraph",
        "Second paragraph",
      ]);
    },
  );

  it("splits at question and exclamation boundaries", () => {
    expect(segmenter.segment("Really? Yes!").map((unit) => unit.text)).toEqual([
      "Really?",
      "Yes!",
    ]);
  });

  it("splits at Chinese sentence punctuation", () => {
    expect(
      segmenter.segment("第一句。第二句！真的吗？").map((unit) => unit.text),
    ).toEqual(["第一句。", "第二句！", "真的吗？"]);
  });

  it("retains an unfinished sentence", () => {
    const text = "I think this policy is";

    expect(segmenter.segment(text).map((unit) => unit.text)).toEqual([text]);
  });

  it("produces no units for empty text", () => {
    expect(segmenter.segment("")).toEqual([]);
  });

  it("produces no units for whitespace-only text", () => {
    expect(segmenter.segment(" \t\r\n ")).toEqual([]);
  });

  it("maps every range back to the exact source slice", () => {
    const text = "First.\n\n第二个 unfinished paragraph\r\ncontinues? Last";
    const units = segmenter.segment(text);

    for (const unit of units) {
      expect(text.slice(unit.range.start, unit.range.end)).toBe(unit.text);
    }
  });

  it("uses UTF-16 offsets around emoji", () => {
    const text = "😀 Hi. Next?";
    const units = segmenter.segment(text);

    expect("😀".length).toBe(2);
    expect(units).toMatchObject([
      { text: "😀 Hi.", range: { start: 0, end: 6 } },
      { text: "Next?", range: { start: 7, end: 12 } },
    ]);
    for (const unit of units) {
      expect(text.slice(unit.range.start, unit.range.end)).toBe(unit.text);
    }
  });

  it("preserves meaningful whitespace inside a unit range", () => {
    const text = "  First line\ncontinues here  ";

    expect(segmenter.segment(text).map((unit) => unit.text)).toEqual([text]);
  });

  it("returns immutable units, ranges, and collections", () => {
    const units = segmenter.segment("First. Second.");

    expect(Object.isFrozen(units)).toBe(true);
    expect(Object.isFrozen(units[0])).toBe(true);
    expect(Object.isFrozen(units[0]?.range)).toBe(true);
  });
});

describe("createWritingUnit", () => {
  it("derives text from and validates its source range", () => {
    const sourceText = "Before selected after";
    const unit = createWritingUnit({
      id: "selection-unit",
      sourceText,
      range: { start: 7, end: 15 },
      order: 0,
    });

    expect(unit.text).toBe("selected");
    expect(sourceText.slice(unit.range.start, unit.range.end)).toBe(unit.text);
    expect(() =>
      createWritingUnit({
        id: "invalid-unit",
        sourceText,
        range: { start: 0, end: sourceText.length + 1 },
        order: 0,
      }),
    ).toThrow(RangeError);
  });
});
