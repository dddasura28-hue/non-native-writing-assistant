import {
  LocalBlockContextSelector,
  selectedText,
} from "@non-native-writing/application";
import type { Editor, EditorPosition } from "obsidian";
import { describe, expect, it } from "vitest";

import { captureObsidianTextContext } from "./obsidian-text-context-adapter.js";

type TestEditor = Pick<Editor, "getValue" | "getCursor" | "posToOffset">;

function editorWithSelection(
  text: string,
  anchorOffset: number,
  headOffset: number,
): TestEditor {
  const positionAt = (offset: number): EditorPosition => ({
    line: 0,
    ch: offset,
  });

  return {
    getValue: () => text,
    getCursor: (side) =>
      positionAt(side === "anchor" ? anchorOffset : headOffset),
    posToOffset: (position) => position.ch,
  };
}

describe("ObsidianTextContextAdapter capture", () => {
  it("normalizes a reversed primary selection without losing its head cursor", () => {
    const context = captureObsidianTextContext(
      editorWithSelection("abcdef", 5, 2),
    );

    expect(context.cursorOffset).toBe(2);
    expect(context.selection).toEqual({ start: 2, end: 5 });
    expect(selectedText(context)).toBe("cde");
    expect(new LocalBlockContextSelector().select(context)).toMatchObject({
      activeText: "cde",
      sourceRange: { start: 2, end: 5 },
    });
  });

  it("preserves Obsidian's UTF-16 offsets around a surrogate pair", () => {
    const context = captureObsidianTextContext(
      editorWithSelection("A😀B", 1, 3),
    );

    expect(context.text.length).toBe(4);
    expect(context.cursorOffset).toBe(3);
    expect(context.selection).toEqual({ start: 1, end: 3 });
    expect(selectedText(context)).toBe("😀");
  });

  it("sets composition to null because the public Editor API does not expose it", () => {
    const context = captureObsidianTextContext(
      editorWithSelection("Draft", 5, 5),
    );

    expect(context.selection).toBeNull();
    expect(context.composition).toBeNull();
  });
});
