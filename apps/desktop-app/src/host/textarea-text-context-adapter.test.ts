import { describe, expect, it } from "vitest";

import {
  DESKTOP_HOST_CAPABILITIES,
  TextareaCompositionTracker,
  captureTextareaTextContext,
  type TextareaSnapshotSource,
} from "./textarea-text-context-adapter.js";

interface MutableTextareaSnapshot extends TextareaSnapshotSource {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  selectionDirection: "forward" | "backward" | "none";
}

function textarea(
  value: string,
  selectionStart = 0,
  selectionEnd = selectionStart,
  selectionDirection: "forward" | "backward" | "none" = "none",
): MutableTextareaSnapshot {
  return { value, selectionStart, selectionEnd, selectionDirection };
}

describe("textarea TextContext capture", () => {
  it("captures a valid empty TextContext", () => {
    expect(captureTextareaTextContext(textarea(""))).toEqual({
      text: "",
      cursorOffset: 0,
      selection: null,
      composition: null,
    });
  });

  it("captures a plain cursor position", () => {
    expect(captureTextareaTextContext(textarea("Draft", 3))).toMatchObject({
      text: "Draft",
      cursorOffset: 3,
      selection: null,
    });
  });

  it("captures a non-empty forward selection with its head at the end", () => {
    expect(
      captureTextareaTextContext(textarea("abcdef", 1, 4, "forward")),
    ).toMatchObject({
      cursorOffset: 4,
      selection: { start: 1, end: 4 },
    });
  });

  it("uses selectionStart as the active caret for backward selections", () => {
    expect(
      captureTextareaTextContext(textarea("abcdef", 1, 4, "backward")),
    ).toMatchObject({
      cursorOffset: 1,
      selection: { start: 1, end: 4 },
    });
  });

  it("normalizes defensive reversed selection inputs", () => {
    expect(
      captureTextareaTextContext(textarea("abcdef", 5, 2, "forward")),
    ).toMatchObject({
      cursorOffset: 5,
      selection: { start: 2, end: 5 },
    });
  });

  it("preserves UTF-16 emoji offsets", () => {
    const context = captureTextareaTextContext(
      textarea("A😀B", 1, 3, "forward"),
    );

    expect(context.text.length).toBe(4);
    expect(context.cursorOffset).toBe(3);
    expect(context.selection).toEqual({ start: 1, end: 3 });
    expect(context.text.slice(1, 3)).toBe("😀");
  });

  it("captures multiline text without modification", () => {
    const value = "First line\r\n第二行\n\nLast line";
    expect(captureTextareaTextContext(textarea(value, value.length)).text).toBe(
      value,
    );
  });

  it("captures the textarea's current value exactly", () => {
    const source = textarea("before", 6);
    source.value = " after \n";
    source.selectionStart = source.value.length;
    source.selectionEnd = source.value.length;

    expect(captureTextareaTextContext(source).text).toBe(" after \n");
  });

  it("captures an exact active composition when current text confirms it", () => {
    const source = textarea("ab", 1);
    const tracker = new TextareaCompositionTracker();
    tracker.start(source);
    source.value = "a文b";
    source.selectionStart = 2;
    source.selectionEnd = 2;
    tracker.update("文");

    const context = captureTextareaTextContext(
      source,
      tracker.capture(source),
    );
    expect(context.composition).toEqual({ start: 1, end: 2, text: "文" });
  });

  it("uses a conservative current-caret marker when an exact range is unavailable", () => {
    const source = textarea("ab", 1);
    const tracker = new TextareaCompositionTracker();
    tracker.start(source);
    tracker.update("文");

    expect(tracker.capture(source)).toEqual({ start: 1, end: 1, text: "" });
  });

  it("returns committed no-composition state after compositionend", () => {
    const source = textarea("文", 1);
    const tracker = new TextareaCompositionTracker();
    tracker.start(textarea("", 0));
    tracker.update("文");
    tracker.end();

    expect(
      captureTextareaTextContext(source, tracker.capture(source)).composition,
    ).toBeNull();
  });

  it("does not leak the textarea or DOM-shaped extras into TextContext", () => {
    const source = Object.assign(textarea("Draft", 5), {
      ownerDocument: { secret: true },
      style: { color: "red" },
    });
    const context = captureTextareaTextContext(source);

    expect(context).toEqual({
      text: "Draft",
      cursorOffset: 5,
      selection: null,
      composition: null,
    });
    expect(context).not.toHaveProperty("ownerDocument");
    expect(context).not.toHaveProperty("style");
  });
});

describe("desktop host capabilities", () => {
  it("exposes the actual frozen desktop facilities without extra fields", () => {
    expect(DESKTOP_HOST_CAPABILITIES).toEqual({
      canReplaceText: true,
      canObserveComposition: true,
      canObserveSelection: true,
      canProvideSurroundingText: true,
    });
    expect(Object.isFrozen(DESKTOP_HOST_CAPABILITIES)).toBe(true);
    expect(Object.keys(DESKTOP_HOST_CAPABILITIES)).toHaveLength(4);
  });
});
