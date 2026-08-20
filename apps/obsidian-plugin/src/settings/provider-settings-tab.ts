import {
  Notice,
  PluginSettingTab,
  SecretComponent,
  Setting,
  type App,
  type Plugin,
} from "obsidian";
import {
  BUILT_IN_PROVIDER_DEFINITIONS,
  OPENAI_COMPATIBLE_PROVIDER_DEFINITION,
  type ProviderDefinition,
  type StructuredOutputMode,
} from "@non-native-writing/model-integration";

import {
  ProviderProfileStore,
  type ProviderProfilePatch,
} from "./provider-profile-store.js";
import type { StoredProviderProfile } from "./plugin-settings.js";

const COMPATIBILITY_MODE_LABELS: Readonly<
  Record<StructuredOutputMode, string>
> = Object.freeze({
  "json-schema": "JSON Schema",
  "json-object": "JSON Object",
  "prompt-json": "Prompt JSON",
});

export class ProviderSettingsTab extends PluginSettingTab {
  readonly #profiles: ProviderProfileStore;
  readonly #origin = Symbol("provider-settings-tab");
  #unsubscribe: (() => void) | undefined;

  constructor(app: App, plugin: Plugin, profiles: ProviderProfileStore) {
    super(app, plugin);
    this.#profiles = profiles;
  }

  display(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = this.#profiles.onDidUpdate((origin) => {
      if (origin !== this.#origin) {
        this.display();
      }
    });

    const container = this.containerEl;
    container.empty();
    container.createEl("h2", { text: "Non-Native Writing Assistant" });
    new Setting(container).setName("AI providers").setHeading();

    this.#renderActiveProfile(container);
    this.#renderAddProfile(container);

    const storedProfiles =
      this.#profiles.getStoredSettings().providerSettings.profiles;
    if (storedProfiles.length === 0) {
      container.createDiv({
        cls: "nnwa-settings-empty",
        text: "No AI provider profiles yet. Add one to use direct AI assistance.",
      });
      return;
    }

    for (const profile of storedProfiles) {
      this.#renderProfile(container, profile);
    }
  }

  hide(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    super.hide();
  }

  #renderActiveProfile(container: HTMLElement): void {
    const selection = this.#profiles.getSelectionState();
    const setting = new Setting(container)
      .setName("Active profile")
      .setDesc(
        selection.profiles.length === 0
          ? "Complete and enable a profile before selecting it."
          : "The next analysis uses this profile.",
      );

    setting.addDropdown((dropdown) => {
      dropdown.addOption("", "No active profile");
      for (const profile of selection.profiles) {
        dropdown.addOption(profile.id, profile.name);
      }
      dropdown
        .setValue(selection.activeProfileId ?? "")
        .setDisabled(selection.profiles.length === 0)
        .onChange((value) => {
          this.#run(
            this.#profiles.setActiveProfileId(
              value.length === 0 ? null : value,
              this.#origin,
            ),
          );
        });
    });
  }

  #renderAddProfile(container: HTMLElement): void {
    let selectedProviderId = BUILT_IN_PROVIDER_DEFINITIONS[0]?.id ?? "";
    new Setting(container)
      .setName("Add profile")
      .setDesc("Choose a provider, then enter a model and secret reference.")
      .addDropdown((dropdown) => {
        for (const definition of BUILT_IN_PROVIDER_DEFINITIONS) {
          dropdown.addOption(definition.id, definition.displayName);
        }
        dropdown.setValue(selectedProviderId).onChange((value) => {
          selectedProviderId = value;
        });
      })
      .addButton((button) => {
        button.setButtonText("Add").setCta().onClick(() => {
          this.#run(
            this.#profiles.addProfile(selectedProviderId, this.#origin),
            true,
          );
        });
      });
  }

  #renderProfile(container: HTMLElement, profile: StoredProviderProfile): void {
    const card = container.createDiv({ cls: "nnwa-settings-profile" });
    card.createEl("h3", {
      text: profile.name.trim().length > 0 ? profile.name : "Incomplete profile",
    });
    const validation = this.#profiles.validateProfile(profile.id);
    card.createDiv({
      cls: validation.valid
        ? "nnwa-settings-profile__status is-valid"
        : "nnwa-settings-profile__status is-invalid",
      text: validation.valid
        ? "Ready for analysis"
        : validation.issues.join(" "),
    });

    this.#textSetting(
      card,
      profile.id,
      "Profile name",
      profile.name,
      (name) => ({ name }),
    );
    this.#renderProviderSetting(card, profile);
    this.#renderModelSetting(card, profile);
    this.#renderSecretSetting(card, profile);

    new Setting(card)
      .setName("Enabled")
      .addToggle((toggle) => {
        toggle.setValue(profile.enabled).onChange((enabled) => {
          this.#run(
            this.#profiles.updateProfile(
              profile.id,
              { enabled },
              this.#origin,
            ),
            true,
          );
        });
      });

    if (
      profile.providerId === OPENAI_COMPATIBLE_PROVIDER_DEFINITION.id
    ) {
      this.#textSetting(
        card,
        profile.id,
        "Base URL",
        profile.baseUrl ?? "",
        (baseUrl) => ({ baseUrl }),
        "https://example.test/v1",
      );
      new Setting(card)
        .setName("Compatibility mode")
        .addDropdown((dropdown) => {
          for (const [mode, label] of Object.entries(
            COMPATIBILITY_MODE_LABELS,
          )) {
            dropdown.addOption(mode, label);
          }
          dropdown
            .setValue(profile.compatibilityMode ?? "json-schema")
            .onChange((value) => {
              this.#run(
                this.#profiles.updateProfile(
                  profile.id,
                  { compatibilityMode: value as StructuredOutputMode },
                  this.#origin,
                ),
              );
            });
        });
    }

    new Setting(card)
      .setName("Delete profile")
      .setDesc("The referenced secret is not deleted.")
      .addButton((button) => {
        button.setButtonText("Delete").setWarning().onClick(() => {
          this.#run(
            this.#profiles.deleteProfile(profile.id, this.#origin),
            true,
          );
        });
      });
  }

  #renderProviderSetting(
    card: HTMLElement,
    profile: StoredProviderProfile,
  ): void {
    new Setting(card).setName("Provider").addDropdown((dropdown) => {
      if (providerDefinition(profile.providerId) === undefined) {
        dropdown.addOption(
          profile.providerId,
          `Unknown (${profile.providerId || "empty"})`,
        );
      }
      for (const definition of BUILT_IN_PROVIDER_DEFINITIONS) {
        dropdown.addOption(definition.id, definition.displayName);
      }
      dropdown.setValue(profile.providerId).onChange((providerId) => {
        this.#run(
          this.#profiles.updateProfile(
            profile.id,
            { providerId },
            this.#origin,
          ),
          true,
        );
      });
    });
  }

  #renderModelSetting(
    card: HTMLElement,
    profile: StoredProviderProfile,
  ): void {
    const definition = providerDefinition(profile.providerId);
    const setting = new Setting(card)
      .setName("Model ID")
      .setDesc("Choose a suggestion or enter any model ID.")
      .addText((text) => {
        text
          .setPlaceholder("Enter a model ID")
          .setValue(profile.modelId)
          .onChange((modelId) => {
            this.#run(
              this.#profiles.updateProfile(
                profile.id,
                { modelId },
                this.#origin,
              ),
            );
          });
        text.inputEl.addEventListener("blur", () => this.display());

        if ((definition?.suggestedModelIds.length ?? 0) > 0) {
          const listId = `nnwa-models-${safeDomId(profile.id)}`;
          text.inputEl.setAttr("list", listId);
          const dataList = card.createEl("datalist", { attr: { id: listId } });
          for (const modelId of definition?.suggestedModelIds ?? []) {
            dataList.createEl("option", { attr: { value: modelId } });
          }
        }
      });
    setting.setClass("nnwa-settings-model");
  }

  #renderSecretSetting(
    card: HTMLElement,
    profile: StoredProviderProfile,
  ): void {
    const setting = new Setting(card)
      .setName("API-key secret")
      .setDesc("Select or create an Obsidian secret. Only its reference is saved.");
    const secret = new SecretComponent(this.app, setting.controlEl)
      .setValue(profile.secretRef)
      .onChange((secretRef) => {
        this.#run(
          this.#profiles.updateProfile(
            profile.id,
            { secretRef },
            this.#origin,
          ),
          true,
        );
      });
    setting.components.push(secret);
  }

  #textSetting(
    card: HTMLElement,
    profileId: string,
    name: string,
    value: string,
    patch: (value: string) => ProviderProfilePatch,
    placeholder = "",
  ): void {
    new Setting(card).setName(name).addText((text) => {
      text.setValue(value).setPlaceholder(placeholder).onChange((nextValue) => {
        this.#run(
          this.#profiles.updateProfile(
            profileId,
            patch(nextValue),
            this.#origin,
          ),
        );
      });
      text.inputEl.addEventListener("blur", () => this.display());
    });
  }

  #run(operation: Promise<unknown>, redisplay = false): void {
    void operation
      .then(() => {
        if (redisplay) {
          this.display();
        }
      })
      .catch(() => {
        new Notice("Could not save AI provider settings.");
      });
  }
}

function providerDefinition(
  providerId: string,
): ProviderDefinition | undefined {
  return BUILT_IN_PROVIDER_DEFINITIONS.find(
    (definition) => definition.id === providerId,
  );
}

function safeDomId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}
