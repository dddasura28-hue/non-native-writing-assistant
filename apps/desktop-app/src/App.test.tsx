/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App.js";

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
