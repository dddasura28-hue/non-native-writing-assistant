import { describe, expect, it } from "vitest";

import {
  LocalBlockContextSelector,
  assertTextReplacementMatches,
  createHostCapabilities,
  createTextContext,
  createTextReplacement,
  createSelectionTextReplacement,
  createWritingUnit,
  createWritingUnitTextReplacement,
  type TextEditPort,
} from "../src/index.js";

function context(text: string) {
  return createTextContext({ text, cursorOffset: 0, selection: null, composition: null });
}

// A host-owned transient identity and revision, with no path or document.
function fakeHost(text = "A😀B") {
  const state = { text, session: Symbol(), revision: 0, available: true, composing: false };
  const capture = (): TextEditPort => {
    const session = state.session;
    const revision = state.revision;
    return {
      replace(replacement) {
        if (!state.available || state.session !== session || state.revision !== revision || state.composing) {
          throw new Error("Captured host text is no longer current.");
        }
        assertTextReplacementMatches(state.text, replacement);
        state.text = state.text.slice(0, replacement.range.start) + replacement.replacementText + state.text.slice(replacement.range.end);
        state.revision += 1;
      },
    };
  };
  return { state, capture };
}

describe("host boundary", () => {
  it("copies and freezes only technical capabilities", () => {
    const input = { canReplaceText: true, canObserveComposition: false, canObserveSelection: true, canProvideSurroundingText: false, editor: {} };
    const value = createHostCapabilities(input);
    input.canReplaceText = false;
    expect(value.canReplaceText).toBe(true);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Reflect.set(value, "canReplaceText", false)).toBe(false);
    expect(value).not.toHaveProperty("editor");
  });

  it("captures immutable exact UTF-16 emoji replacement data", () => {
    const input = { range: { start: 1, end: 3 }, expectedText: "😀", replacementText: "🙂!", editor: {} };
    const value = createTextReplacement(context("A😀B"), input);
    input.range.end = 4;
    expect(value).toEqual({ range: { start: 1, end: 3 }, expectedText: "😀", replacementText: "🙂!" });
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.range)).toBe(true);
    expect(Reflect.set(value.range, "start", 0)).toBe(false);
    const host = fakeHost();
    const port = host.capture();
    port.replace(value);
    expect(host.state.text).toBe("A🙂!B");
    expect(() => port.replace(value)).toThrow();
  });

  it.each([
    [-1, 1], [2, 1], [0, 5], [0.5, 2], [0, NaN], [0, Infinity],
  ])("rejects invalid range [%s, %s)", (start, end) => {
    expect(() => createTextReplacement(context("A😀B"), {
      range: { start, end }, expectedText: "", replacementText: "x",
    })).toThrow(RangeError);
  });

  it("does not trim, normalize or relocate expected text", () => {
    for (const expectedText of ["draft", " Draft ", "DRAFT"]) {
      expect(() => createTextReplacement(context("Draft"), {
        range: { start: 0, end: 5 }, expectedText, replacementText: "x",
      })).toThrow();
    }
    expect(() => createTextReplacement(context("é"), {
      range: { start: 0, end: 1 }, expectedText: "e\u0301", replacementText: "x",
    })).toThrow();
  });

  it.each([
    [0, 0, "", "x", "xA😀B"],
    [4, 4, "", "x", "A😀Bx"],
    [1, 3, "😀", "", "AB"],
  ])("supports exact insertion/deletion at [%s, %s)", (start, end, expectedText, replacementText, result) => {
    const host = fakeHost();
    host.capture().replace(createTextReplacement(context(host.state.text), {
      range: { start, end }, expectedText, replacementText,
    }));
    expect(host.state.text).toBe(result);
  });

  it("rejects stale expectedText without changing the fake host", () => {
    const host = fakeHost();
    const replacement = createTextReplacement(context(host.state.text), {
      range: { start: 1, end: 3 }, expectedText: "😀", replacementText: "x",
    });
    const port = host.capture();
    host.state.text = "A🙂B";
    expect(() => port.replace(replacement)).toThrow(/expectedText/);
    expect(host.state.text).toBe("A🙂B");
  });

  it.each(["session", "revision", "closed", "composition"])("rejects changed %s even with identical text", (change) => {
    const host = fakeHost();
    const port = host.capture();
    const replacement = createTextReplacement(context(host.state.text), {
      range: { start: 1, end: 3 }, expectedText: "😀", replacementText: "x",
    });
    if (change === "session") host.state.session = Symbol();
    if (change === "revision") host.state.revision += 1;
    if (change === "closed") host.state.available = false;
    if (change === "composition") host.state.composing = true;
    expect(() => port.replace(replacement)).toThrow(/no longer current/);
    expect(host.state.text).toBe("A😀B");
  });

  it("keeps host objects out of captured context and blocks uncommitted input", () => {
    const input = { text: "文", cursorOffset: 1, selection: null, composition: { start: 0, end: 1, text: "文", editor: {} }, editor: {} };
    const captured = createTextContext(input);
    expect(captured).toEqual({ text: "文", cursorOffset: 1, selection: null, composition: { start: 0, end: 1, text: "文" } });
    expect(new LocalBlockContextSelector().select(captured)).toBeNull();
    expect(new LocalBlockContextSelector().select(createTextContext({ ...captured, composition: null }))?.activeText).toBe("文");
  });

  it("maps a cursor-local unit range to absolute host UTF-16 coordinates", () => {
    const captured = createTextContext({
      text: "前文\n\nA😀B. Next.",
      cursorOffset: 8,
      selection: null,
      composition: null,
    });
    const selection = new LocalBlockContextSelector().select(captured)!;
    const unit = createWritingUnit({
      id: "unit-emoji",
      sourceText: selection.activeText,
      range: { start: 0, end: 5 },
      order: 0,
    });

    const edit = createWritingUnitTextReplacement(
      captured,
      selection,
      unit,
      "甲🙂乙。",
    );

    expect(edit).toEqual({
      range: { start: 4, end: 9 },
      expectedText: "A😀B.",
      replacementText: "甲🙂乙。",
    });
  });

  it("maps an explicit multi-sentence selection without splitting it", () => {
    const captured = createTextContext({
      text: "Before This have issue. It cost too much. After",
      cursorOffset: 20,
      selection: { start: 7, end: 41 },
      composition: null,
    });
    const selection = new LocalBlockContextSelector().select(captured)!;

    const edit = createSelectionTextReplacement(
      captured,
      selection,
      "This has an issue. It costs too much.",
    );

    expect(edit.range).toEqual({ start: 7, end: 41 });
    expect(edit.expectedText).toBe("This have issue. It cost too much.");
    expect(edit.replacementText).toBe(
      "This has an issue. It costs too much.",
    );
  });
});
