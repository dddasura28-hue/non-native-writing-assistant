import {
  BUILT_IN_PROVIDER_DEFINITIONS,
  OPENAI_COMPATIBLE_PROVIDER_DEFINITION,
  createActiveProfileFingerprint,
  validateProviderProfileForAnalysis,
  type ProviderProfile,
  type ProviderProfileValidation,
  type ProviderSettings,
  type ProviderSettingsSource,
  type StructuredOutputMode,
} from "@non-native-writing/model-integration";

import {
  createPluginSettings,
  storedProfileAsCandidate,
  type ObsidianPluginSettings,
  type StoredProviderProfile,
} from "./plugin-settings.js";

export interface ProviderProfilePatch {
  readonly name?: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly secretRef?: string;
  readonly baseUrl?: string | null;
  readonly compatibilityMode?: StructuredOutputMode | null;
  readonly enabled?: boolean;
}

export interface ProfileSelectionOption {
  readonly id: string;
  readonly name: string;
}

export interface ProfileSelectionState {
  readonly activeProfileId: string | null;
  readonly profiles: readonly ProfileSelectionOption[];
}

export interface ProviderProfileSelectionSource {
  getSelectionState(): ProfileSelectionState;
  setActiveProfileId(
    profileId: string | null,
    origin?: unknown,
  ): Promise<void>;
  onDidUpdate(listener: (origin: unknown) => void): () => void;
}

export type SavePluginSettings = (
  settings: ObsidianPluginSettings,
) => Promise<void>;
export type CreateProfileId = () => string;

export class ProviderProfileStore
  implements ProviderSettingsSource, ProviderProfileSelectionSource
{
  #settings: ObsidianPluginSettings;
  readonly #save: SavePluginSettings;
  readonly #createProfileId: CreateProfileId;
  readonly #runtimeListeners = new Set<() => void>();
  readonly #updateListeners = new Set<(origin: unknown) => void>();
  #saveQueue: Promise<void> = Promise.resolve();

  constructor(
    settings: ObsidianPluginSettings,
    save: SavePluginSettings,
    createProfileId: CreateProfileId = createUniqueProfileId,
  ) {
    this.#settings = createPluginSettings(
      settings.providerSettings.activeProfileId,
      settings.providerSettings.profiles,
    );
    this.#save = save;
    this.#createProfileId = createProfileId;
  }

  getStoredSettings(): ObsidianPluginSettings {
    return this.#settings;
  }

  getSettings(): ProviderSettings {
    const profiles = this.#validProfiles();
    const activeProfileId = profiles.some(
      (profile) =>
        profile.id === this.#settings.providerSettings.activeProfileId,
    )
      ? (this.#settings.providerSettings.activeProfileId ?? undefined)
      : undefined;

    return Object.freeze({
      profiles: Object.freeze(profiles),
      activeProfileId,
    });
  }

  getSelectionState(): ProfileSelectionState {
    const settings = this.getSettings();
    return Object.freeze({
      activeProfileId: settings.activeProfileId ?? null,
      profiles: Object.freeze(
        settings.profiles.map((profile) =>
          Object.freeze({ id: profile.id, name: profile.name }),
        ),
      ),
    });
  }

  validateProfile(profileId: string): ProviderProfileValidation {
    const profile = this.#storedProfile(profileId);
    if (profile === undefined) {
      return Object.freeze({
        valid: false as const,
        issues: Object.freeze(["This profile no longer exists."]),
      });
    }
    return validateProviderProfileForAnalysis(
      storedProfileAsCandidate(profile),
    );
  }

  async addProfile(providerId: string, origin?: unknown): Promise<string> {
    const definition = BUILT_IN_PROVIDER_DEFINITIONS.find(
      (candidate) => candidate.id === providerId,
    );
    if (definition === undefined) {
      throw new TypeError("Cannot create a profile for an unknown provider.");
    }

    const id = this.#nextUniqueProfileId();
    const isCompatible =
      providerId === OPENAI_COMPATIBLE_PROVIDER_DEFINITION.id;
    const profile: StoredProviderProfile = {
      id,
      name: definition.displayName,
      providerId,
      modelId: definition.suggestedModelIds[0] ?? "",
      secretRef: "",
      enabled: true,
      ...(isCompatible
        ? { baseUrl: "", compatibilityMode: "json-schema" as const }
        : {}),
    };

    await this.#commit(
      createPluginSettings(this.#settings.providerSettings.activeProfileId, [
        ...this.#settings.providerSettings.profiles,
        profile,
      ]),
      origin,
    );
    return id;
  }

  async updateProfile(
    profileId: string,
    patch: ProviderProfilePatch,
    origin?: unknown,
  ): Promise<void> {
    const profiles = this.#settings.providerSettings.profiles;
    const existing = this.#storedProfile(profileId);
    if (existing === undefined) {
      throw new TypeError("Cannot edit a provider profile that does not exist.");
    }

    const providerId = patch.providerId ?? existing.providerId;
    const changedToCompatible =
      providerId === OPENAI_COMPATIBLE_PROVIDER_DEFINITION.id &&
      existing.providerId !== OPENAI_COMPATIBLE_PROVIDER_DEFINITION.id;
    const isCompatible =
      providerId === OPENAI_COMPATIBLE_PROVIDER_DEFINITION.id;
    const baseUrl = isCompatible
      ? patch.baseUrl === null
        ? undefined
        : (patch.baseUrl ?? (changedToCompatible ? "" : existing.baseUrl))
      : undefined;
    const compatibilityMode = isCompatible
      ? patch.compatibilityMode === null
        ? undefined
        : (patch.compatibilityMode ??
          (changedToCompatible ? "json-schema" : existing.compatibilityMode))
      : undefined;
    const updated: StoredProviderProfile = {
      id: existing.id,
      name: patch.name ?? existing.name,
      providerId,
      modelId: patch.modelId ?? existing.modelId,
      secretRef: patch.secretRef ?? existing.secretRef,
      enabled: patch.enabled ?? existing.enabled,
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(compatibilityMode === undefined ? {} : { compatibilityMode }),
    };

    await this.#commit(
      createPluginSettings(
        this.#settings.providerSettings.activeProfileId,
        profiles.map((profile) =>
          profile.id === profileId ? updated : profile,
        ),
      ),
      origin,
    );
  }

  async setActiveProfileId(
    profileId: string | null,
    origin?: unknown,
  ): Promise<void> {
    if (
      profileId !== null &&
      !this.#validProfiles().some((profile) => profile.id === profileId)
    ) {
      throw new TypeError("Only a valid enabled profile can become active.");
    }
    if (this.#settings.providerSettings.activeProfileId === profileId) {
      return;
    }

    await this.#commit(
      createPluginSettings(
        profileId,
        this.#settings.providerSettings.profiles,
      ),
      origin,
    );
  }

  async deleteProfile(profileId: string, origin?: unknown): Promise<void> {
    const profiles = this.#settings.providerSettings.profiles.filter(
      (profile) => profile.id !== profileId,
    );
    if (profiles.length === this.#settings.providerSettings.profiles.length) {
      return;
    }

    let activeProfileId = this.#settings.providerSettings.activeProfileId;
    if (activeProfileId === profileId) {
      activeProfileId = firstValidProfileId(profiles);
    }

    await this.#commit(
      createPluginSettings(activeProfileId, profiles),
      origin,
    );
  }

  onDidChange(listener: () => void): () => void {
    this.#runtimeListeners.add(listener);
    return () => this.#runtimeListeners.delete(listener);
  }

  onDidUpdate(listener: (origin: unknown) => void): () => void {
    this.#updateListeners.add(listener);
    return () => this.#updateListeners.delete(listener);
  }

  #validProfiles(): ProviderProfile[] {
    return this.#settings.providerSettings.profiles.flatMap((profile) => {
      const result = validateProviderProfileForAnalysis(
        storedProfileAsCandidate(profile),
      );
      return result.valid ? [result.profile] : [];
    });
  }

  #storedProfile(profileId: string): StoredProviderProfile | undefined {
    return this.#settings.providerSettings.profiles.find(
      (profile) => profile.id === profileId,
    );
  }

  #nextUniqueProfileId(): string {
    const existingIds = new Set(
      this.#settings.providerSettings.profiles.map((profile) => profile.id),
    );
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const id = this.#createProfileId();
      if (id.trim().length > 0 && !existingIds.has(id)) {
        return id;
      }
    }
    throw new Error("Could not create a unique provider profile ID.");
  }

  async #commit(
    settings: ObsidianPluginSettings,
    origin: unknown,
  ): Promise<void> {
    const previousFingerprint = createActiveProfileFingerprint(
      this.getSettings(),
    );
    this.#settings = settings;
    const currentFingerprint = createActiveProfileFingerprint(
      this.getSettings(),
    );
    if (previousFingerprint !== currentFingerprint) {
      for (const listener of this.#runtimeListeners) {
        listener();
      }
    }
    for (const listener of this.#updateListeners) {
      listener(origin);
    }

    const snapshot = this.#settings;
    const save = this.#saveQueue.then(() => this.#save(snapshot));
    this.#saveQueue = save.catch(() => undefined);
    await save;
  }
}

function firstValidProfileId(
  profiles: readonly StoredProviderProfile[],
): string | null {
  for (const profile of profiles) {
    if (
      validateProviderProfileForAnalysis(storedProfileAsCandidate(profile))
        .valid
    ) {
      return profile.id;
    }
  }
  return null;
}

let fallbackProfileId = 0;

function createUniqueProfileId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid !== undefined) {
    return `provider-profile-${uuid}`;
  }
  fallbackProfileId += 1;
  return `provider-profile-${Date.now().toString(36)}-${fallbackProfileId}`;
}
