import { ItemView, Notice, type WorkspaceLeaf } from "obsidian";

import {
  createEmptyViewModel,
  type TrackPresentation,
  type UnitAssistanceViewModel,
  type WritingAssistantViewModel,
} from "./presentation.js";
import type { WritingAssistantPresenter } from "./writing-assistant-controller.js";
import type { ProviderProfileSelectionSource } from "./settings/provider-profile-store.js";

export const WRITING_ASSISTANT_VIEW_TYPE = "non-native-writing-assistant-view";

export class WritingAssistantView
  extends ItemView
  implements WritingAssistantPresenter
{
  readonly #profileSelection: ProviderProfileSelectionSource | undefined;
  #viewModel: WritingAssistantViewModel = createEmptyViewModel();
  #unsubscribeProfileSelection: (() => void) | undefined;

  constructor(
    leaf: WorkspaceLeaf,
    profileSelection?: ProviderProfileSelectionSource,
  ) {
    super(leaf);
    this.#profileSelection = profileSelection;
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
    this.#unsubscribeProfileSelection = this.#profileSelection?.onDidUpdate(
      () => this.#render(),
    );
    this.#render();
  }

  async onClose(): Promise<void> {
    this.#unsubscribeProfileSelection?.();
    this.#unsubscribeProfileSelection = undefined;
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

    this.#renderProfileSelector(root);

    const statusText = this.#viewModel.statusDetail
      ? `${this.#viewModel.status}: ${this.#viewModel.statusDetail}`
      : this.#viewModel.status;
    root.createDiv({ cls: "nnwa-panel__status", text: statusText });

    root.createEl("h3", {
      cls: "nnwa-panel__group-title",
      text: "Current",
    });
    this.#renderSource(root, this.#viewModel);
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
    this.#renderRecentAssistance(root, this.#viewModel.recentAssistance);
  }

  #renderProfileSelector(root: HTMLElement): void {
    if (this.#profileSelection === undefined) {
      return;
    }

    const state = this.#profileSelection.getSelectionState();
    const container = root.createDiv({ cls: "nnwa-panel__profile" });
    container.createEl("label", {
      attr: { for: "nnwa-active-profile" },
      text: "AI profile",
    });
    const select = container.createEl("select", {
      attr: { id: "nnwa-active-profile" },
    });

    if (state.profiles.length === 0) {
      select.createEl("option", {
        attr: { value: "" },
        text: "Configure in settings",
      });
      select.disabled = true;
      container.createDiv({
        cls: "nnwa-panel__empty",
        text: "Configure an AI provider in settings.",
      });
      return;
    }

    if (state.activeProfileId === null) {
      select.createEl("option", {
        attr: { value: "" },
        text: "Select a profile",
      });
    }
    for (const profile of state.profiles) {
      select.createEl("option", {
        attr: { value: profile.id },
        text: profile.name,
      });
    }
    select.value = state.activeProfileId ?? "";
    select.disabled = state.profiles.length < 2 && state.activeProfileId !== null;
    select.addEventListener("change", () => {
      void this.#profileSelection
        ?.setActiveProfileId(select.value.length === 0 ? null : select.value)
        .catch(() => {
          new Notice("Could not change the active AI profile.");
        });
    });
  }

  #renderSource(
    root: HTMLElement,
    item: UnitAssistanceViewModel,
  ): void {
    const section = root.createDiv({ cls: "nnwa-panel__section" });
    section.createEl("h3", {
      cls: "nnwa-panel__section-title",
      text: "Source",
    });

    section.createDiv({
      cls: "nnwa-panel__track",
      text:
        item.sourceText.length > 0
          ? item.sourceText
          : "The active document is empty.",
    });
  }

  #renderRecentAssistance(
    root: HTMLElement,
    items: readonly UnitAssistanceViewModel[],
  ): void {
    if (items.length === 0) {
      return;
    }

    const section = root.createDiv({ cls: "nnwa-panel__recent" });
    section.createEl("h3", {
      cls: "nnwa-panel__group-title",
      text: "Recent Assistance",
    });

    for (const item of items) {
      const card = section.createDiv({ cls: "nnwa-panel__recent-item" });
      if (item.unitId !== null) {
        card.dataset.unitId = item.unitId;
      }

      this.#renderRecentField(card, "Source", [
        Object.freeze({ text: item.sourceText }),
      ]);
      this.#renderRecentField(
        card,
        "Native intent",
        item.nativeIntentTracks,
      );
      this.#renderRecentField(card, "Normalized", item.normalizedTracks);
    }
  }

  #renderRecentField(
    card: HTMLElement,
    title: string,
    tracks: readonly Pick<TrackPresentation, "text" | "label">[],
  ): void {
    const field = card.createDiv({ cls: "nnwa-panel__recent-field" });
    field.createDiv({ cls: "nnwa-panel__recent-label", text: title });

    if (tracks.length === 0) {
      field.createDiv({
        cls: "nnwa-panel__empty",
        text: `No ${title.toLocaleLowerCase()} available.`,
      });
      return;
    }

    for (const track of tracks) {
      const text = field.createDiv({ cls: "nnwa-panel__recent-text" });
      if (track.label !== undefined) {
        text.createDiv({
          cls: "nnwa-panel__track-label",
          text: track.label,
        });
      }
      text.createDiv({ text: track.text });
    }
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
