import {
  createProviderProfile,
  type ProviderProfile,
} from "./provider-profile.js";
import { WritingModelError } from "./writing-model-error.js";

export interface ProviderSettings {
  readonly profiles: readonly ProviderProfile[];
  readonly activeProfileId?: string;
}

export interface ProviderSettingsSource {
  getSettings(): ProviderSettings;
  onDidChange(listener: () => void): () => void;
}

export class MutableProviderSettings implements ProviderSettingsSource {
  #settings: ProviderSettings;
  readonly #listeners = new Set<() => void>();

  constructor(settings: ProviderSettings = { profiles: [] }) {
    this.#settings = copyProviderSettings(settings);
  }

  getSettings(): ProviderSettings {
    return this.#settings;
  }

  setActiveProfileId(activeProfileId: string | undefined): void {
    if (this.#settings.activeProfileId === activeProfileId) {
      return;
    }

    this.#settings = copyProviderSettings({
      profiles: this.#settings.profiles,
      activeProfileId,
    });
    this.#emitChange();
  }

  replaceProfiles(profiles: readonly ProviderProfile[]): void {
    this.#settings = copyProviderSettings({
      profiles,
      activeProfileId: this.#settings.activeProfileId,
    });
    this.#emitChange();
  }

  onDidChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emitChange(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

export function copyProviderSettings(
  settings: ProviderSettings,
): ProviderSettings {
  const ids = new Set<string>();
  const profiles = settings.profiles.map((profile) => {
    const copy = createProviderProfile(profile);
    if (ids.has(copy.id)) {
      throw new WritingModelError(
        "invalid-profile",
        "Provider profile IDs must be unique.",
      );
    }
    ids.add(copy.id);
    return copy;
  });

  return Object.freeze({
    profiles: Object.freeze(profiles),
    activeProfileId: settings.activeProfileId,
  });
}

export function resolveActiveProviderProfile(
  settings: ProviderSettings,
): ProviderProfile {
  if (settings.activeProfileId === undefined) {
    throw new WritingModelError(
      "invalid-profile",
      "No active provider profile is configured.",
    );
  }

  const profile = settings.profiles.find(
    (candidate) => candidate.id === settings.activeProfileId,
  );
  if (profile === undefined || !profile.enabled) {
    throw new WritingModelError(
      "invalid-profile",
      "The active provider profile is unavailable or disabled.",
    );
  }

  return profile;
}

export function createActiveProfileFingerprint(
  settings: ProviderSettings,
): string {
  const profile = settings.profiles.find(
    (candidate) => candidate.id === settings.activeProfileId,
  );

  if (profile === undefined) {
    return JSON.stringify({
      activeProfileId: settings.activeProfileId ?? null,
      state: "missing",
    });
  }

  return JSON.stringify({
    profileId: profile.id,
    providerId: profile.providerId,
    modelId: profile.modelId,
    secretRef: profile.secretRef,
    baseUrl: profile.baseUrl ?? null,
    compatibilityMode: profile.compatibilityMode ?? null,
    enabled: profile.enabled,
  });
}
