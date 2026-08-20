import { createTextContext } from "@non-native-writing/application";
import type { TextContext } from "@non-native-writing/application";
import type { Editor, MarkdownView } from "obsidian";

import type { ObservedTextContext } from "./writing-assistant-controller.js";

type TextContextEditor = Pick<
  Editor,
  "getValue" | "getCursor" | "posToOffset"
>;

/**
 * Captures the primary Obsidian selection using public Editor APIs.
 * The cursor is the selection head; the stored selection range is normalized.
 * Obsidian composition capture is deferred because Editor exposes no public API.
 */
export function captureObsidianTextContext(
  editor: TextContextEditor,
): TextContext {
  const text = editor.getValue();
  const headOffset = editor.posToOffset(editor.getCursor("head"));
  const anchorOffset = editor.posToOffset(editor.getCursor("anchor"));

  return createTextContext({
    text,
    cursorOffset: headOffset,
    selection:
      anchorOffset === headOffset
        ? null
        : {
            start: Math.min(anchorOffset, headOffset),
            end: Math.max(anchorOffset, headOffset),
          },
    composition: null,
  });
}

export class ObsidianTextContextAdapter {
  readonly #untitledDocumentKeys = new WeakMap<MarkdownView, string>();
  #nextUntitledDocumentNumber = 0;

  observe(view: MarkdownView): ObservedTextContext {
    return Object.freeze({
      documentKey: view.file?.path ?? this.#untitledDocumentKey(view),
      textContext: captureObsidianTextContext(view.editor),
    });
  }

  #untitledDocumentKey(view: MarkdownView): string {
    const existingKey = this.#untitledDocumentKeys.get(view);
    if (existingKey !== undefined) {
      return existingKey;
    }

    const key = `obsidian-untitled-${++this.#nextUntitledDocumentNumber}`;
    this.#untitledDocumentKeys.set(view, key);
    return key;
  }
}
