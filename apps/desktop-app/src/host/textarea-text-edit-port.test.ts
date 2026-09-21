import { createTextReplacement } from "@non-native-writing/application";
import type {
  TextContext,
  TextReplacement,
} from "@non-native-writing/application";
import { describe, expect, it } from "vitest";

import { captureTextareaTextContext } from "./textarea-text-context-adapter.js";
import {
  createCapturedTextareaEditPort,
  type TextareaEditTarget,
  type TextareaSessionState,
} from "./textarea-text-edit-port.js";

class FakeTextarea implements TextareaEditTarget {
  selectionDirection: "forward" | "backward" | "none" = "none";

  constructor(
    public value: string,
    public selectionStart = 0,
    public selectionEnd = selectionStart,
  ) {}

  setRangeText(
    replacement: string,
    start: number,
    end: number,
    selectionMode: "end",
  ): void {
    expect(selectionMode).toBe("end");
    this.value = this.value.slice(0, start) + replacement + this.value.slice(end);
    const caret = start + replacement.length;
    this.selectionStart = caret;
    this.selectionEnd = caret;
    this.selectionDirection = "none";
  }
}

function harness(text = "A😀B") {
  const target = new FakeTextarea(text);
  const context = captureTextareaTextContext(target);
  let session: TextareaSessionState = {
    token: Symbol("test-session"),
    generation: 0,
    compositionActive: false,
  };
  let capturedAfterEdit: TextContext | null = null;
  const port = createCapturedTextareaEditPort({
    target,
    context,
    session,
    getCurrentSession: () => session,
    onDidReplace: (freshContext) => {
      capturedAfterEdit = freshContext;
    },
  });

  return {
    target,
    context,
    port,
    get session() {
      return session;
    },
    set session(value: TextareaSessionState) {
      session = value;
    },
    get capturedAfterEdit() {
      return capturedAfterEdit;
    },
  };
}

function replacement(
  context: TextContext,
  range: { readonly start: number; readonly end: number },
  expectedText: string,
  replacementText: string,
): TextReplacement {
  return createTextReplacement(context, {
    range,
    expectedText,
    replacementText,
  });
}

describe("captured textarea TextEditPort", () => {
  it("applies an exact guarded replacement", () => {
    const host = harness("Draft text");
    host.port.replace(replacement(host.context, { start: 0, end: 5 }, "Draft", "Final"));

    expect(host.target.value).toBe("Final text");
    expect(host.capturedAfterEdit?.text).toBe("Final text");
  });

  it("preserves UTF-16 coordinates around emoji", () => {
    const host = harness();
    host.port.replace(replacement(host.context, { start: 1, end: 3 }, "😀", "🙂!"));

    expect(host.target.value).toBe("A🙂!B");
    expect(host.target.selectionStart).toBe(4);
  });

  it.each([
    ["前文\n旧句\n后文", { start: 3, end: 5 }, "旧句", "新句\n第二行", "前文\n新句\n第二行\n后文"],
    ["中文 old English", { start: 3, end: 6 }, "old", "新的😀", "中文 新的😀 English"],
  ] as const)("preserves exact multiline and mixed-language text for %s", (
    source,
    range,
    expectedText,
    replacementText,
    finalText,
  ) => {
    const host = harness(source);
    host.port.replace(
      replacement(host.context, range, expectedText, replacementText),
    );

    expect(host.target.value).toBe(finalText);
    expect(host.target.selectionStart).toBe(range.start + replacementText.length);
    expect(host.target.selectionEnd).toBe(host.target.selectionStart);
  });

  it("supports insertion", () => {
    const host = harness("AB");
    host.port.replace(replacement(host.context, { start: 1, end: 1 }, "", "x"));
    expect(host.target.value).toBe("AxB");
  });

  it("supports deletion", () => {
    const host = harness("ABC");
    host.port.replace(replacement(host.context, { start: 1, end: 2 }, "B", ""));
    expect(host.target.value).toBe("AC");
  });

  it("rejects an expected-text mismatch", () => {
    const host = harness("Draft");
    const invalid: TextReplacement = {
      range: { start: 0, end: 5 },
      expectedText: "draft",
      replacementText: "Final",
    };

    expect(() => host.port.replace(invalid)).toThrow(/expectedText/);
  });

  it("rejects a stale captured session even when text is identical", () => {
    const host = harness("Draft");
    host.session = { ...host.session, generation: 1 };

    expect(() =>
      host.port.replace(replacement(host.context, { start: 0, end: 5 }, "Draft", "Final")),
    ).toThrow(/no longer current/);
    expect(host.target.value).toBe("Draft");
  });

  it("rejects repeat use after a successful edit", () => {
    const host = harness("Draft");
    const edit = replacement(host.context, { start: 0, end: 5 }, "Draft", "Final");
    host.port.replace(edit);

    expect(() => host.port.replace(edit)).toThrow(/no longer current/);
  });

  it("rejects a composition-unsafe edit", () => {
    const host = harness("Draft");
    host.session = { ...host.session, compositionActive: true };

    expect(() =>
      host.port.replace(replacement(host.context, { start: 0, end: 5 }, "Draft", "Final")),
    ).toThrow(/composition/);
    expect(host.target.value).toBe("Draft");
  });

  it("does not mutate text when validation fails", () => {
    const host = harness("Draft");
    expect(() =>
      host.port.replace({
        range: { start: 0, end: 5 },
        expectedText: "Other",
        replacementText: "Final",
      }),
    ).toThrow();
    expect(host.target.value).toBe("Draft");
    expect(host.capturedAfterEdit).toBeNull();
  });

  it("places the caret deterministically after inserted text", () => {
    const host = harness("abcdef");
    host.port.replace(replacement(host.context, { start: 2, end: 4 }, "cd", "XYZ"));

    expect(host.target.selectionStart).toBe(5);
    expect(host.target.selectionEnd).toBe(5);
    expect(host.capturedAfterEdit?.cursorOffset).toBe(5);
    expect(host.capturedAfterEdit?.selection).toBeNull();
  });
});
