/** @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";

import {
  calculateTextareaInlinePosition,
  calculateTextareaTextAnchor,
  createTextareaMeasurementMirror,
  measureTextareaTextAnchor,
} from "./textarea-text-anchor.js";

function rect(
  left: number,
  top: number,
  width: number,
  height: number,
): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  };
}

function textarea(value: string): HTMLTextAreaElement {
  const element = document.createElement("textarea");
  element.value = value;
  element.style.fontFamily = "sans-serif";
  element.style.fontSize = "16px";
  element.style.lineHeight = "24px";
  element.style.letterSpacing = "1px";
  element.style.wordSpacing = "2px";
  element.style.textAlign = "start";
  element.style.whiteSpace = "pre-wrap";
  element.style.overflowWrap = "anywhere";
  return element;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("textarea text anchor", () => {
  it("returns no anchor for a missing or disconnected textarea target", () => {
    const editor = textarea("Draft");
    const container = document.createElement("section");
    expect(measureTextareaTextAnchor(editor, container, 5)).toBeNull();
  });

  it("preserves UTF-16 caret offsets around emoji", () => {
    const editor = textarea("A😀B");
    const mirror = createTextareaMeasurementMirror(editor, editor.value, 3);

    expect(mirror.element.childNodes[0]?.textContent).toBe("A😀");
    expect(mirror.element.childNodes[2]?.textContent).toBe("B");
    expect(editor.value).toBe("A😀B");
  });

  it.each([
    "这个方法不太合理",
    "I think这个方法不太合理because cost.",
    "A😀B",
    "第一行 mixed 😀\nSecond 行",
  ])("passes exact multilingual and multiline source into measurement: %s", (source) => {
    const editor = textarea(source);
    const offset = Math.floor(source.length / 2);
    const mirror = createTextareaMeasurementMirror(editor, source, offset);
    const measuredSource =
      (mirror.element.childNodes[0]?.textContent ?? "") +
      (mirror.element.childNodes[2]?.textContent ?? "");

    expect(measuredSource).toBe(source);
    expect(editor.value).toBe(source);
  });

  it("mirrors soft wrapping properties without altering source", () => {
    const source = "中文 English with a very long uninterruptedword";
    const editor = textarea(source);
    const mirror = createTextareaMeasurementMirror(
      editor,
      editor.value,
      editor.value.length,
    );

    expect(mirror.element.style.whiteSpace).toBe("pre-wrap");
    expect(mirror.element.style.overflowWrap).toBe("anywhere");
    expect(mirror.element.style.textAlign).toBe("start");
    expect(editor.value).toBe(source);
  });

  it("subtracts textarea scroll offsets from container-local position", () => {
    const anchor = calculateTextareaTextAnchor({
      textareaRect: rect(100, 50, 300, 120),
      containerRect: rect(80, 20, 360, 240),
      markerRect: rect(250, 130, 0, 24),
      scrollTop: 40,
      scrollLeft: 25,
      lineHeight: 24,
    });

    expect(anchor).toEqual({
      left: 145,
      top: 70,
      lineHeight: 24,
      visible: true,
    });
  });

  it("marks an offscreen caret anchor as hidden", () => {
    const anchor = calculateTextareaTextAnchor({
      textareaRect: rect(100, 50, 300, 100),
      containerRect: rect(80, 20, 360, 240),
      markerRect: rect(140, 230, 0, 24),
      scrollTop: 0,
      scrollLeft: 0,
      lineHeight: 24,
    });

    expect(anchor.visible).toBe(false);
  });

  it("recalculates deterministic clamped placement for resized bounds", () => {
    const anchor = { left: 330, top: 180, lineHeight: 24, visible: true };
    expect(calculateTextareaInlinePosition(
      anchor,
      { width: 400, height: 240 },
      { width: 200, height: 120 },
    )).toEqual({ left: 192, top: 54, placement: "above" });
    expect(calculateTextareaInlinePosition(
      anchor,
      { width: 700, height: 500 },
      { width: 200, height: 120 },
    )).toEqual({ left: 330, top: 210, placement: "below" });
  });

  it("creates an aria-hidden noninteractive mirror", () => {
    const editor = textarea("Source");
    const mirror = createTextareaMeasurementMirror(editor, editor.value, 3);

    expect(mirror.element.getAttribute("aria-hidden")).toBe("true");
    expect(mirror.element.tabIndex).toBe(-1);
    expect(mirror.element.style.visibility).toBe("hidden");
    expect(mirror.element.style.pointerEvents).toBe("none");
    expect(mirror.element.dataset.textareaMeasurementMirror).toBe("true");
  });
});
