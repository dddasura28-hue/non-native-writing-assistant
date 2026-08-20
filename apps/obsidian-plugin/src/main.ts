import {
  MarkdownView,
  Notice,
  Plugin,
  type WorkspaceLeaf,
} from "obsidian";
import { AnalysisCoordinator } from "@non-native-writing/application";
import type { AnalysisProvider } from "@non-native-writing/application";
import {
  createBuiltInProviderRegistry,
} from "@non-native-writing/model-integration";

import { DemoAnalysisProvider } from "./demo-analysis-provider.js";
import {
  DEVELOPMENT_ANALYSIS_PROVIDER,
  DEVELOPMENT_ANALYSIS_CONFIGURATION,
  DEVELOPMENT_GATEWAY_URL,
} from "./development-configuration.js";
import { HttpAnalysisProvider } from "./http-analysis-provider.js";
import { ObsidianTextContextAdapter } from "./obsidian-text-context-adapter.js";
import {
  ProfileAnalysisConfigurationSource,
  StaticAnalysisConfigurationSource,
  type AnalysisConfigurationSource,
} from "./provider/analysis-configuration-source.js";
import { ObsidianHttpTransport } from "./provider/obsidian-http-transport.js";
import { ObsidianSecretResolver } from "./provider/obsidian-secret-resolver.js";
import { ProfiledAnalysisProvider } from "./provider/profiled-analysis-provider.js";
import { loadPluginSettings } from "./settings/plugin-settings.js";
import { ProviderProfileStore } from "./settings/provider-profile-store.js";
import { ProviderSettingsTab } from "./settings/provider-settings-tab.js";
import { WritingAssistantController } from "./writing-assistant-controller.js";
import {
  WRITING_ASSISTANT_VIEW_TYPE,
  WritingAssistantView,
} from "./writing-assistant-view.js";

export default class NonNativeWritingAssistantPlugin extends Plugin {
  readonly #textContextAdapter = new ObsidianTextContextAdapter();
  #profiles?: ProviderProfileStore;
  #controller?: WritingAssistantController;

  async onload(): Promise<void> {
    this.#profiles = new ProviderProfileStore(
      loadPluginSettings(await this.loadData()),
      (settings) => this.saveData(settings),
    );
    this.addSettingTab(new ProviderSettingsTab(this.app, this, this.#profiles));

    this.registerView(
      WRITING_ASSISTANT_VIEW_TYPE,
      (leaf) =>
        new WritingAssistantView(
          leaf,
          DEVELOPMENT_ANALYSIS_PROVIDER === "profile"
            ? this.#profiles
            : undefined,
        ),
    );

    const { provider, analysisConfigurationSource } =
      this.#createAnalysisComposition();
    const coordinator = new AnalysisCoordinator(provider);
    this.#controller = new WritingAssistantController(
      coordinator,
      () => this.#revealWritingAssistant(),
      {
        getAutomaticPresenter: () => this.#getOpenWritingAssistant(),
        analysisConfigurationSource,
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
          this.#textContextAdapter.observe(markdownView),
        );
      }),
    );

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (!(leaf?.view instanceof MarkdownView)) {
          return;
        }

        this.#controller?.scheduleAutomaticAnalysis(
          this.#textContextAdapter.observe(leaf.view),
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

        const source = this.#textContextAdapter.observe(markdownView);

        void this.#controller?.analyze(source).catch((error: unknown) => {
          new Notice(describeHostError(error, "Could not analyze this document."));
        });
      },
    });
  }

  #createAnalysisComposition(): {
    readonly provider: AnalysisProvider;
    readonly analysisConfigurationSource: AnalysisConfigurationSource;
  } {
    const staticConfiguration = new StaticAnalysisConfigurationSource(
      DEVELOPMENT_ANALYSIS_CONFIGURATION,
    );

    if (DEVELOPMENT_ANALYSIS_PROVIDER === "profile") {
      const profiles = this.#profiles;
      if (profiles === undefined) {
        throw new Error("Provider profiles were not loaded.");
      }
      const transport = new ObsidianHttpTransport();
      return {
        provider: new ProfiledAnalysisProvider(
          profiles,
          createBuiltInProviderRegistry(transport),
          new ObsidianSecretResolver(this.app.secretStorage),
        ),
        analysisConfigurationSource: new ProfileAnalysisConfigurationSource(
          DEVELOPMENT_ANALYSIS_CONFIGURATION,
          profiles,
        ),
      };
    }

    if (
      DEVELOPMENT_ANALYSIS_PROVIDER === "gateway" ||
      DEVELOPMENT_ANALYSIS_PROVIDER === "http"
    ) {
      return {
        provider: new HttpAnalysisProvider(DEVELOPMENT_GATEWAY_URL),
        analysisConfigurationSource: staticConfiguration,
      };
    }

    return {
      provider: new DemoAnalysisProvider(),
      analysisConfigurationSource: staticConfiguration,
    };
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
