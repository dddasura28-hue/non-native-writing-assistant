import { ItemView, type WorkspaceLeaf } from "obsidian";

import {
  createEmptyViewModel,
  type TrackPresentation,
  type WritingAssistantViewModel,
} from "./presentation.js";
import type { WritingAssistantPresenter } from "./writing-assistant-controller.js";

export const WRITING_ASSISTANT_VIEW_TYPE = "non-native-writing-assistant-view";

export class WritingAssistantView
  extends ItemView
  implements WritingAssistantPresenter
{
  #viewModel: WritingAssistantViewModel = createEmptyViewModel();

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return WRITING_ASSISTANT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Writing Assistant";
  }

  getIcon(): string {
    return "languages";
  }

  async onOpen(): Promise<void> {
    this.#render();
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  present(viewModel: WritingAssistantViewModel): void {
    this.#viewModel = viewModel;
    this.#render();
  }

  #render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("nnwa-panel");

    root.createEl("h2", {
      cls: "nnwa-panel__heading",
      text: "Writing Assistant",
    });

    const statusText = this.#viewModel.statusDetail
      ? `${this.#viewModel.status}: ${this.#viewModel.statusDetail}`
      : this.#viewModel.status;
    root.createDiv({ cls: "nnwa-panel__status", text: statusText });

    this.#renderSource(root);
    this.#renderTrackSection(
      root,
      "Native intent",
      this.#viewModel.nativeIntentTracks,
      "No native intent available.",
    );
    this.#renderTrackSection(
      root,
      "Normalized",
      this.#viewModel.normalizedTracks,
      "No normalized expression available.",
    );
  }

  #renderSource(root: HTMLElement): void {
    const section = root.createDiv({ cls: "nnwa-panel__section" });
    section.createEl("h3", {
      cls: "nnwa-panel__section-title",
      text: "Source",
    });

    section.createDiv({
      cls: "nnwa-panel__track",
      text:
        this.#viewModel.sourceText.length > 0
          ? this.#viewModel.sourceText
          : "The active document is empty.",
    });
  }

  #renderTrackSection(
    root: HTMLElement,
    title: string,
    tracks: readonly TrackPresentation[],
    emptyMessage: string,
  ): void {
    const section = root.createDiv({ cls: "nnwa-panel__section" });
    section.createEl("h3", {
      cls: "nnwa-panel__section-title",
      text: title,
    });

    if (tracks.length === 0) {
      section.createDiv({ cls: "nnwa-panel__empty", text: emptyMessage });
      return;
    }

    for (const track of tracks) {
      const trackElement = section.createDiv({ cls: "nnwa-panel__track" });
      trackElement.dataset.trackId = track.id;

      if (track.label !== undefined) {
        trackElement.createDiv({
          cls: "nnwa-panel__track-label",
          text: track.label,
        });
      }

      trackElement.createDiv({ text: track.text });
    }
  }
}
