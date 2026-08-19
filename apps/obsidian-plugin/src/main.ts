import {
  MarkdownView,
  Notice,
  Plugin,
  type WorkspaceLeaf,
} from "obsidian";
import { AnalysisCoordinator } from "@non-native-writing/application";

import { DemoAnalysisProvider } from "./demo-analysis-provider.js";
import { observeEditorSource } from "./obsidian-source-adapter.js";
import { WritingAssistantController } from "./writing-assistant-controller.js";
import {
  WRITING_ASSISTANT_VIEW_TYPE,
  WritingAssistantView,
} from "./writing-assistant-view.js";

export default class NonNativeWritingAssistantPlugin extends Plugin {
  #controller?: WritingAssistantController;

  async onload(): Promise<void> {
    this.registerView(
      WRITING_ASSISTANT_VIEW_TYPE,
      (leaf) => new WritingAssistantView(leaf),
    );

    const coordinator = new AnalysisCoordinator(new DemoAnalysisProvider());
    this.#controller = new WritingAssistantController(coordinator, () =>
      this.#revealWritingAssistant(),
    );

    this.addCommand({
      id: "open-writing-assistant-view",
      name: "Open writing assistant",
      callback: () => {
        void this.#revealWritingAssistant().catch((error: unknown) => {
          new Notice(describeHostError(error, "Could not open the writing assistant."));
        });
      },
    });

    this.addCommand({
      id: "analyze-active-document",
      name: "Analyze active document",
      callback: () => {
        const markdownView =
          this.app.workspace.getActiveViewOfType(MarkdownView);
        if (markdownView === null) {
          new Notice("Open an active Markdown editor before running analysis.");
          return;
        }

        const documentKey =
          markdownView.file?.path ?? "obsidian-active-untitled-document";
        const source = observeEditorSource(markdownView.editor, documentKey);

        void this.#controller?.analyze(source).catch((error: unknown) => {
          new Notice(describeHostError(error, "Could not analyze this document."));
        });
      },
    });
  }

  onunload(): void {
    this.#controller?.dispose();
    this.app.workspace.detachLeavesOfType(WRITING_ASSISTANT_VIEW_TYPE);
  }

  async #revealWritingAssistant(): Promise<WritingAssistantView> {
    let leaf = this.app.workspace.getLeavesOfType(
      WRITING_ASSISTANT_VIEW_TYPE,
    )[0];

    if (leaf === undefined) {
      leaf = this.app.workspace.getRightLeaf(false) ?? undefined;
      if (leaf === undefined) {
        throw new Error("No workspace leaf is available for the assistant view.");
      }

      await leaf.setViewState({
        type: WRITING_ASSISTANT_VIEW_TYPE,
        active: true,
      });
    }

    await this.app.workspace.revealLeaf(leaf);
    return getWritingAssistantView(leaf);
  }
}

function getWritingAssistantView(leaf: WorkspaceLeaf): WritingAssistantView {
  if (!(leaf.view instanceof WritingAssistantView)) {
    throw new TypeError("The writing assistant view is not ready.");
  }

  return leaf.view;
}

function describeHostError(error: unknown, fallback: string): string {
  return error instanceof Error ? `${fallback} ${error.message}` : fallback;
}
