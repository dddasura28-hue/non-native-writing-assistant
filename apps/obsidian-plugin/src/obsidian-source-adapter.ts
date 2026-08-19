import type { MarkdownView } from "obsidian";

import type { ObservedDocumentSource } from "./writing-assistant-controller.js";

export class ObsidianSourceAdapter {
  readonly #untitledDocumentKeys = new WeakMap<MarkdownView, string>();
  #nextUntitledDocumentNumber = 0;

  observe(view: MarkdownView): ObservedDocumentSource {
    return Object.freeze({
      documentKey: view.file?.path ?? this.#untitledDocumentKey(view),
      text: view.editor.getValue(),
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
