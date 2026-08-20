import {
  MarkdownView,
  Notice,
  Plugin,
  type WorkspaceLeaf,
} from "obsidian";
import { AnalysisCoordinator } from "@non-native-writing/application";

import { DemoAnalysisProvider } from "./demo-analysis-provider.js";
import {
  DEVELOPMENT_ANALYSIS_PROVIDER,
  DEVELOPMENT_GATEWAY_URL,
} from "./development-configuration.js";
import { HttpAnalysisProvider } from "./http-analysis-provider.js";
import { ObsidianSourceAdapter } from "./obsidian-source-adapter.js";
import { WritingAssistantController } from "./writing-assistant-controller.js";
import {
  WRITING_ASSISTANT_VIEW_TYPE,
  WritingAssistantView,
} from "./writing-assistant-view.js";

export default class NonNativeWritingAssistantPlugin extends Plugin {
  readonly #sourceAdapter = new ObsidianSourceAdapter();
  #controller?: WritingAssistantController;

  async onload(): Promise<void> {
    this.registerView(
      WRITING_ASSISTANT_VIEW_TYPE,
      (leaf) => new WritingAssistantView(leaf),
    );

    const provider =
      DEVELOPMENT_ANALYSIS_PROVIDER === "http"
        ? new HttpAnalysisProvider(DEVELOPMENT_GATEWAY_URL)
        : new DemoAnalysisProvider();
    const coordinator = new AnalysisCoordinator(provider);
    this.#controller = new WritingAssistantController(
      coordinator,
      () => this.#revealWritingAssistant(),
      {
        getAutomaticPresenter: () => this.#getOpenWritingAssistant(),
      },
    );

    this.registerEvent(
      this.app.workspace.on("editor-change", (editor) => {
        const markdownView =
          this.app.workspace.getActiveViewOfType(MarkdownView);
        if (markdownView === null || markdownView.editor !== editor) {
          return;
        }

        this.#controller?.scheduleAutomaticAnalysis(
          this.#sourceAdapter.observe(markdownView),
        );
      }),
    );

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (!(leaf?.view instanceof MarkdownView)) {
          return;
        }

        this.#controller?.scheduleAutomaticAnalysis(
          this.#sourceAdapter.observe(leaf.view),
        );
      }),
    );

    this.addCommand({
      id: "open-writing-assistant-view",
      name: "Open writing assistant",
      callback: () => {
        void this.#revealWritingAssistant()
          .then((view) => {
            this.#controller?.presentActive(view);
          })
          .catch((error: unknown) => {
            new Notice(
              describeHostError(error, "Could not open the writing assistant."),
            );
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

        const source = this.#sourceAdapter.observe(markdownView);

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

  async #getOpenWritingAssistant(): Promise<
    WritingAssistantView | undefined
  > {
    const leaf = this.app.workspace.getLeavesOfType(
      WRITING_ASSISTANT_VIEW_TYPE,
    )[0];
    if (leaf === undefined) {
      return undefined;
    }

    await leaf.loadIfDeferred();
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
