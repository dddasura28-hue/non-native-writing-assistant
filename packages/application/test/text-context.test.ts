import { describe, expect, it } from "vitest";

import {
  WholeAvailableContextSelector,
  createTextContext,
  selectedText,
} from "../src/index.js";

function contextAt(cursorOffset: number, text = "Draft") {
  return createTextContext({
    text,
    cursorOffset,
    selection: null,
    composition: null,
  });
}

describe("TextContext", () => {
  it("accepts a cursor at the start", () => {
    expect(contextAt(0).cursorOffset).toBe(0);
  });

  it("accepts a cursor at text.length", () => {
    expect(contextAt("Draft".length).cursorOffset).toBe(5);
  });

  it("rejects a cursor beyond text.length", () => {
    expect(() => contextAt(6)).toThrow(RangeError);
  });

  it.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
  ])("rejects a %s cursor offset", (_label, cursorOffset) => {
    expect(() => contextAt(cursorOffset)).toThrow(RangeError);
  });

  it("bounds selections to the available text", () => {
    const createWithSelection = (start: number, end: number) =>
      createTextContext({
        text: "Draft",
        cursorOffset: 0,
        selection: { start, end },
        composition: null,
      });

    expect(() => createWithSelection(-1, 2)).toThrow(RangeError);
    expect(() => createWithSelection(2, 1)).toThrow(RangeError);
    expect(() => createWithSelection(1, 6)).toThrow(RangeError);
  });

  it("uses null as the canonical representation of no selected text", () => {
    const context = createTextContext({
      text: "Draft",
      cursorOffset: 2,
      selection: { start: 2, end: 2 },
      composition: null,
    });

    expect(context.selection).toBeNull();
    expect(selectedText(context)).toBeNull();
  });

  it("derives selected text from the normalized range", () => {
    const context = createTextContext({
      text: "Write directly",
      cursorOffset: 5,
      selection: { start: 0, end: 5 },
      composition: null,
    });

    expect(selectedText(context)).toBe("Write");
  });

  it("uses UTF-16 code-unit offsets for surrogate pairs", () => {
    const text = "A😀B";
    const context = createTextContext({
      text,
      cursorOffset: 3,
      selection: { start: 1, end: 3 },
      composition: null,
    });

    expect(text.length).toBe(4);
    expect(context.selection).toEqual({ start: 1, end: 3 });
    expect(selectedText(context)).toBe("😀");
  });

  it("represents host-neutral composition state immutably", () => {
    const context = createTextContext({
      text: "A文B",
      cursorOffset: 2,
      selection: null,
      composition: { start: 1, end: 2, text: "文" },
    });

    expect(context.composition).toEqual({ start: 1, end: 2, text: "文" });
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.composition)).toBe(true);
  });

  it("bounds composition ranges to the available text", () => {
    expect(() =>
      createTextContext({
        text: "Draft",
        cursorOffset: 0,
        selection: null,
        composition: { start: 0, end: 6, text: "Drafts" },
      }),
    ).toThrow(RangeError);
  });
});

describe("WholeAvailableContextSelector", () => {
  it("selects the entire text available from the host", () => {
    const context = contextAt(3, "A😀B");
    const selection = new WholeAvailableContextSelector().select(context);

    expect(selection).toMatchObject({
      activeText: "A😀B",
      beforeContext: "",
      afterContext: "",
    });
  });

  it("uses the full UTF-16 source range", () => {
    const context = contextAt(3, "A😀B");
    const selection = new WholeAvailableContextSelector().select(context);

    expect(selection?.sourceRange).toEqual({ start: 0, end: 4 });
  });

  it("returns no selection for empty available text", () => {
    const context = contextAt(0, "");

    expect(new WholeAvailableContextSelector().select(context)).toBeNull();
  });

  it("does not select the whole available text while it is composing", () => {
    const context = createTextContext({
      text: "Composing",
      cursorOffset: 4,
      selection: null,
      composition: { start: 0, end: 9, text: "Composing" },
    });

    expect(new WholeAvailableContextSelector().select(context)).toBeNull();
  });
});
