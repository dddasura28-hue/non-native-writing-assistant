import type { Editor } from "obsidian";

import type { ObservedDocumentSource } from "./writing-assistant-controller.js";

export function observeEditorSource(
  editor: Editor,
  documentKey: string,
): ObservedDocumentSource {
  return Object.freeze({
    documentKey,
    text: editor.getValue(),
  });
}
