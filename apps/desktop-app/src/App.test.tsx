/** @vitest-environment jsdom */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App.js";
import "./styles.css";

const desktopStyles = readFileSync(
  resolve(process.cwd(), "src/styles.css"),
  "utf8",
);

describe("desktop app shell", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function renderApp(): void {
    act(() => root.render(<App />));
  }

  function enterText(editor: HTMLTextAreaElement, value: string): void {
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    if (valueSetter === undefined) {
      throw new Error("The textarea value setter is unavailable.");
    }
    valueSetter.call(editor, value);
    editor.setSelectionRange(value.length, value.length);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function dispatchComposition(
    editor: HTMLTextAreaElement,
    type: "compositionstart" | "compositionupdate" | "compositionend",
    data: string,
  ): void {
    editor.dispatchEvent(
      new CompositionEvent(type, { bubbles: true, data }),
    );
  }

  it("renders the writing editor and neutral assistance placeholders", () => {
    renderApp();

    expect(container.querySelector("textarea#writing-editor")).not.toBeNull();
    expect(container.textContent).toContain("Native Intent");
    expect(container.textContent).toContain("Normalized");
    expect(container.textContent?.match(/No analysis yet/g)).toHaveLength(2);
  });

  it("typing updates the captured textarea host state", () => {
    renderApp();
    const editor = container.querySelector("textarea")!;

    act(() => {
      enterText(editor, "Hello 文");
    });

    expect(editor.value).toBe("Hello 文");
    expect(container.textContent).toContain("Caret 7");
    expect(container.textContent).toContain("Selection None");
  });

  it("uses explicit soft wrapping without changing the textarea value", () => {
    renderApp();
    const editor = container.querySelector("textarea")!;
    const value = `这是中文${"uninterrupted".repeat(30)}English`;

    act(() => {
      enterText(editor, value);
    });

    expect(editor.wrap).toBe("soft");
    expect(editor.value).toBe(value);
    expect(editor.value).not.toContain("\n");
  });

  it("uses start alignment and mixed-language soft-wrap styles", () => {
    renderApp();
    const editor = container.querySelector("textarea")!;
    const style = getComputedStyle(editor);

    expect(style.textAlign).toBe("start");
    expect(style.whiteSpace).toBe("pre-wrap");
    expect(desktopStyles).toMatch(/overflow-wrap:\s*anywhere;/);
    expect(style.letterSpacing).toBe("normal");
    expect(style.wordSpacing).toBe("normal");
  });

  it("does not add whitespace when Chinese IME text commits beside English", () => {
    renderApp();
    const editor = container.querySelector("textarea")!;

    act(() => {
      enterText(editor, "English");
      editor.setSelectionRange(0, 0);
      dispatchComposition(editor, "compositionstart", "");
      dispatchComposition(editor, "compositionupdate", "这是中文");
      enterText(editor, "这是中文English");
      editor.setSelectionRange(4, 4);
      dispatchComposition(editor, "compositionend", "这是中文");
    });

    expect(editor.value).toBe("这是中文English");
    expect(editor.value).not.toContain(" ");
    expect(container.textContent).toContain("Composition Inactive");
  });

  it("does not call a provider while editing", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderApp();
    const editor = container.querySelector("textarea")!;

    act(() => {
      enterText(editor, "No provider request");
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
