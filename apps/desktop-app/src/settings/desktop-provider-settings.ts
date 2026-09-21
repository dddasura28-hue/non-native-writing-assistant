import {
  BUILT_IN_PROVIDER_DEFINITIONS,
  OPENAI_COMPATIBLE_PROVIDER_DEFINITION,
  STRUCTURED_OUTPUT_MODES,
  createActiveProfileFingerprint,
  validateProviderProfileForAnalysis,
  type ProviderProfile,
  type ProviderSettings,
  type ProviderSettingsSource,
  type StructuredOutputMode,
} from "@non-native-writing/model-integration";

export interface DesktopStoredProviderProfile {
  readonly id: string;
  readonly name: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly secretRef: string;
  readonly baseUrl?: string;
  readonly compatibilityMode?: StructuredOutputMode;
  readonly enabled: boolean;
}

export interface DesktopStoredProviderSettings {
  readonly activeProfileId: string | null;
  readonly profiles: readonly DesktopStoredProviderProfile[];
}

export interface DesktopProviderSettingsPersistence {
  load(): Promise<unknown>;
  save(settings: DesktopStoredProviderSettings): Promise<void>;
}

export interface DesktopProviderProfilePatch {
  readonly name?: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly baseUrl?: string | null;
  readonly compatibilityMode?: StructuredOutputMode | null;
  readonly enabled?: boolean;
}

export type CreateDesktopProfileId = () => string;

export const EMPTY_DESKTOP_PROVIDER_SETTINGS: DesktopStoredProviderSettings =
  Object.freeze({ activeProfileId: null, profiles: Object.freeze([]) });

const SECRET_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export class DesktopProviderProfileStore implements ProviderSettingsSource {
  readonly #persistence: DesktopProviderSettingsPersistence;
  readonly #createProfileId: CreateDesktopProfileId;
  readonly #runtimeListeners = new Set<() => void>();
  readonly #updateListeners = new Set<() => void>();
  #settings = EMPTY_DESKTOP_PROVIDER_SETTINGS;
  #saveQueue: Promise<void> = Promise.resolve();

  constructor(
    persistence: DesktopProviderSettingsPersistence,
    createProfileId: CreateDesktopProfileId = createUniqueProfileId,
  ) {
    this.#persistence = persistence;
    this.#createProfileId = createProfileId;
  }

  async initialize(): Promise<void> {
    let loaded: unknown;
    try {
      loaded = await this.#persistence.load();
    } catch {
      loaded = undefined;
    }
    this.#replaceSettings(loadDesktopProviderSettings(loaded));
  }

  getStoredSettings(): DesktopStoredProviderSettings {
    return this.#settings;
  }

  getSettings(): ProviderSettings {
    const profiles = this.#validProfiles();
    const activeProfileId = profiles.some(
      (profile) => profile.id === this.#settings.activeProfileId,
    )
      ? (this.#settings.activeProfileId ?? undefined)
      : undefined;
    return Object.freeze({ profiles: Object.freeze(profiles), activeProfileId });
  }

  async addProfile(providerId: string): Promise<string> {
    const definition = BUILT_IN_PROVIDER_DEFINITIONS.find(
      (candidate) => candidate.id === providerId,
    );
    if (definition === undefined) {
      throw new TypeError("Cannot create a profile for an unknown provider.");
    }

    const id = this.#nextUniqueProfileId();
    const custom = providerId === OPENAI_COMPATIBLE_PROVIDER_DEFINITION.id;
    const profile: DesktopStoredProviderProfile = {
      id,
      name: definition.displayName,
      providerId,
      modelId: definition.suggestedModelIds[0] ?? "",
      secretRef: `provider-credential-${id}`,
      enabled: true,
      ...(custom
        ? { baseUrl: "", compatibilityMode: "json-schema" as const }
        : definition.defaultBaseUrl === undefined
          ? {}
          : { baseUrl: definition.defaultBaseUrl }),
    };
    await this.#commit(
      createDesktopStoredProviderSettings(this.#settings.activeProfileId, [
        ...this.#settings.profiles,
        profile,
      ]),
    );
    return id;
  }

  async updateProfile(
    profileId: string,
    patch: DesktopProviderProfilePatch,
  ): Promise<void> {
    const existing = this.#storedProfile(profileId);
    if (existing === undefined) {
      throw new TypeError("Cannot edit a provider profile that does not exist.");
    }

    const providerId = patch.providerId ?? existing.providerId;
    const definition = BUILT_IN_PROVIDER_DEFINITIONS.find(
      (candidate) => candidate.id === providerId,
    );
    if (definition === undefined) {
      throw new TypeError("Cannot select an unknown provider.");
    }
    const custom = providerId === OPENAI_COMPATIBLE_PROVIDER_DEFINITION.id;
    const changedProvider = providerId !== existing.providerId;
    const updated: DesktopStoredProviderProfile = {
      id: existing.id,
      name: patch.name ?? existing.name,
      providerId,
      modelId: patch.modelId ?? existing.modelId,
      secretRef: existing.secretRef,
      enabled: patch.enabled ?? existing.enabled,
      ...(custom
        ? {
            baseUrl:
              patch.baseUrl === null
                ? ""
                : (patch.baseUrl ?? (changedProvider ? "" : existing.baseUrl ?? "")),
            compatibilityMode:
              patch.compatibilityMode === null
                ? "json-schema"
                : (patch.compatibilityMode ??
                  (changedProvider
                    ? "json-schema"
                    : existing.compatibilityMode ?? "json-schema")),
          }
        : definition.defaultBaseUrl === undefined
          ? {}
          : { baseUrl: definition.defaultBaseUrl }),
    };
    const profiles = this.#settings.profiles.map((profile) =>
      profile.id === profileId ? updated : profile,
    );
    const activeProfileId =
      this.#settings.activeProfileId === profileId &&
      !isStoredProfileValid(updated)
        ? firstValidProfileId(profiles)
        : this.#settings.activeProfileId;
    await this.#commit(
      createDesktopStoredProviderSettings(activeProfileId, profiles),
    );
  }

  async setActiveProfileId(profileId: string | null): Promise<void> {
    if (
      profileId !== null &&
      !this.#validProfiles().some((profile) => profile.id === profileId)
    ) {
      throw new TypeError("Only a valid enabled profile can become active.");
    }
    if (profileId === this.#settings.activeProfileId) {
      return;
    }
    await this.#commit(
      createDesktopStoredProviderSettings(profileId, this.#settings.profiles),
    );
  }

  async deleteProfile(profileId: string): Promise<void> {
    const profiles = this.#settings.profiles.filter(
      (profile) => profile.id !== profileId,
    );
    if (profiles.length === this.#settings.profiles.length) {
      return;
    }
    const activeProfileId =
      this.#settings.activeProfileId === profileId
        ? firstValidProfileId(profiles)
        : this.#settings.activeProfileId;
    await this.#commit(
      createDesktopStoredProviderSettings(activeProfileId, profiles),
    );
  }

  onDidChange(listener: () => void): () => void {
    this.#runtimeListeners.add(listener);
    return () => this.#runtimeListeners.delete(listener);
  }

  onDidUpdate(listener: () => void): () => void {
    this.#updateListeners.add(listener);
    return () => this.#updateListeners.delete(listener);
  }

  #validProfiles(): ProviderProfile[] {
    return this.#settings.profiles.flatMap((profile) => {
      const result = validateProviderProfileForAnalysis(
        storedProfileAsCandidate(profile),
      );
      return result.valid ? [result.profile] : [];
    });
  }

  #storedProfile(profileId: string): DesktopStoredProviderProfile | undefined {
    return this.#settings.profiles.find((profile) => profile.id === profileId);
  }

  #nextUniqueProfileId(): string {
    const existing = new Set(this.#settings.profiles.map((profile) => profile.id));
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const id = this.#createProfileId();
      if (validateSecretReference(id) && !existing.has(id)) {
        return id;
      }
    }
    throw new Error("Could not create a unique provider profile ID.");
  }

  async #commit(settings: DesktopStoredProviderSettings): Promise<void> {
    const previousSettings = this.#settings;
    const previousFingerprint = createActiveProfileFingerprint(this.getSettings());
    this.#settings = settings;
    const snapshot = this.#settings;
    const save = this.#saveQueue.then(() => this.#persistence.save(snapshot));
    this.#saveQueue = save.catch(() => undefined);
    try {
      await save;
      if (this.#settings === snapshot) {
        this.#emit(previousFingerprint);
      }
    } catch (error) {
      if (this.#settings === snapshot) {
        this.#settings = previousSettings;
      }
      throw error;
    }
  }

  #replaceSettings(settings: DesktopStoredProviderSettings): void {
    const previousFingerprint = createActiveProfileFingerprint(this.getSettings());
    this.#settings = settings;
    this.#emit(previousFingerprint);
  }

  #emit(previousFingerprint: string): void {
    const currentFingerprint = createActiveProfileFingerprint(this.getSettings());
    if (currentFingerprint !== previousFingerprint) {
      for (const listener of this.#runtimeListeners) {
        listener();
      }
    }
    for (const listener of this.#updateListeners) {
      listener();
    }
  }
}

export function loadDesktopProviderSettings(
  value: unknown,
): DesktopStoredProviderSettings {
  const root = asRecord(value);
  if (root === undefined) {
    return EMPTY_DESKTOP_PROVIDER_SETTINGS;
  }
  const rawProfiles = Array.isArray(root.profiles) ? root.profiles : [];
  const profiles: DesktopStoredProviderProfile[] = [];
  const ids = new Set<string>();
  for (const rawProfile of rawProfiles) {
    const profile = loadStoredProfile(rawProfile);
    if (profile === undefined || ids.has(profile.id)) {
      continue;
    }
    ids.add(profile.id);
    profiles.push(profile);
  }

  const requestedActiveProfileId =
    typeof root.activeProfileId === "string" ? root.activeProfileId : null;
  const activeProfileId = profiles.some(
    (profile) =>
      profile.id === requestedActiveProfileId && isStoredProfileValid(profile),
  )
    ? requestedActiveProfileId
    : firstValidProfileId(profiles);
  return createDesktopStoredProviderSettings(activeProfileId, profiles);
}

export function createDesktopStoredProviderSettings(
  activeProfileId: string | null,
  profiles: readonly DesktopStoredProviderProfile[],
): DesktopStoredProviderSettings {
  return Object.freeze({
    activeProfileId,
    profiles: Object.freeze(profiles.map(copyStoredProfile)),
  });
}

export function storedProfileAsCandidate(
  profile: DesktopStoredProviderProfile,
): ProviderProfile {
  return {
    id: profile.id,
    name: profile.name,
    providerId: profile.providerId,
    modelId: profile.modelId,
    secretRef: profile.secretRef,
    enabled: profile.enabled,
    ...(profile.baseUrl === undefined ? {} : { baseUrl: profile.baseUrl }),
    ...(profile.compatibilityMode === undefined
      ? {}
      : { compatibilityMode: profile.compatibilityMode }),
  };
}

export function validateSecretReference(value: string): boolean {
  return SECRET_REF_PATTERN.test(value);
}

function loadStoredProfile(value: unknown): DesktopStoredProviderProfile | undefined {
  const profile = asRecord(value);
  const id = readString(profile?.id);
  const providerId = readString(profile?.providerId);
  const secretRef = readString(profile?.secretRef);
  const definition = BUILT_IN_PROVIDER_DEFINITIONS.find(
    (candidate) => candidate.id === providerId,
  );
  if (
    !validateSecretReference(id) ||
    !validateSecretReference(secretRef) ||
    definition === undefined
  ) {
    return undefined;
  }
  const compatibilityMode = readCompatibilityMode(profile?.compatibilityMode);
  return copyStoredProfile({
    id,
    name: readString(profile?.name),
    providerId,
    modelId: readString(profile?.modelId),
    secretRef,
    enabled: typeof profile?.enabled === "boolean" ? profile.enabled : true,
    ...(providerId === OPENAI_COMPATIBLE_PROVIDER_DEFINITION.id
      ? typeof profile?.baseUrl === "string"
        ? { baseUrl: profile.baseUrl }
        : {}
      : definition.defaultBaseUrl === undefined
        ? {}
        : { baseUrl: definition.defaultBaseUrl }),
    ...(compatibilityMode === undefined ? {} : { compatibilityMode }),
  });
}

function copyStoredProfile(
  profile: DesktopStoredProviderProfile,
): DesktopStoredProviderProfile {
  return Object.freeze({
    id: profile.id,
    name: profile.name,
    providerId: profile.providerId,
    modelId: profile.modelId,
    secretRef: profile.secretRef,
    enabled: profile.enabled,
    ...(profile.baseUrl === undefined ? {} : { baseUrl: profile.baseUrl }),
    ...(profile.compatibilityMode === undefined
      ? {}
      : { compatibilityMode: profile.compatibilityMode }),
  });
}

function isStoredProfileValid(profile: DesktopStoredProviderProfile): boolean {
  return validateProviderProfileForAnalysis(storedProfileAsCandidate(profile)).valid;
}

function firstValidProfileId(
  profiles: readonly DesktopStoredProviderProfile[],
): string | null {
  return profiles.find(isStoredProfileValid)?.id ?? null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readCompatibilityMode(
  value: unknown,
): StructuredOutputMode | undefined {
  return typeof value === "string" &&
    STRUCTURED_OUTPUT_MODES.includes(value as StructuredOutputMode)
    ? (value as StructuredOutputMode)
    : undefined;
}

let fallbackProfileId = 0;

function createUniqueProfileId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid !== undefined) {
    return `profile-${uuid}`;
  }
  fallbackProfileId += 1;
  return `profile-${Date.now().toString(36)}-${fallbackProfileId}`;
}
