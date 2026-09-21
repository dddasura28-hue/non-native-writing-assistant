import {
  BUILT_IN_PROVIDER_DEFINITIONS,
  OPENAI_COMPATIBLE_PROVIDER_DEFINITION,
  STRUCTURED_OUTPUT_MODES,
  validateProviderProfileForAnalysis,
  type StructuredOutputMode,
} from "@non-native-writing/model-integration";

import type { DesktopSecretStore } from "../native/desktop-secret-store.js";
import {
  DesktopProviderProfileStore,
  storedProfileAsCandidate,
  type DesktopProviderProfilePatch,
} from "./desktop-provider-settings.js";

export interface DesktopProviderDefinitionView {
  readonly id: string;
  readonly name: string;
}

export interface DesktopProviderProfileView {
  readonly id: string;
  readonly name: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly baseUrl?: string;
  readonly compatibilityMode?: StructuredOutputMode;
  readonly enabled: boolean;
  readonly configured: boolean;
  readonly valid: boolean;
  readonly issues: readonly string[];
}

export interface DesktopProviderSettingsView {
  readonly loading: boolean;
  readonly activeProfileId: string | null;
  readonly configurationRequired: boolean;
  readonly providers: readonly DesktopProviderDefinitionView[];
  readonly compatibilityModes: readonly StructuredOutputMode[];
  readonly profiles: readonly DesktopProviderProfileView[];
  readonly error?: string;
}

export type PresentDesktopProviderSettings = (
  view: DesktopProviderSettingsView,
) => void;

export interface DesktopProviderSettingsPort {
  addProfile(providerId: string): Promise<void>;
  updateProfile(
    profileId: string,
    patch: DesktopProviderProfilePatch,
  ): Promise<void>;
  setActiveProfile(profileId: string | null): Promise<void>;
  deleteProfile(profileId: string): Promise<void>;
  saveCredential(profileId: string, secret: string): Promise<void>;
  removeCredential(profileId: string): Promise<void>;
}

const PROVIDERS = Object.freeze(
  BUILT_IN_PROVIDER_DEFINITIONS.map((definition) =>
    Object.freeze({ id: definition.id, name: definition.displayName }),
  ),
);

export class DesktopProviderSettingsController
  implements DesktopProviderSettingsPort
{
  readonly #profiles: DesktopProviderProfileStore;
  readonly #secrets: DesktopSecretStore;
  readonly #present: PresentDesktopProviderSettings;
  readonly #configured = new Map<string, boolean>();
  readonly #unsubscribe: () => void;
  #loading = true;
  #error: string | undefined;
  #disposed = false;

  constructor(
    profiles: DesktopProviderProfileStore,
    secrets: DesktopSecretStore,
    present: PresentDesktopProviderSettings,
  ) {
    this.#profiles = profiles;
    this.#secrets = secrets;
    this.#present = present;
    this.#unsubscribe = profiles.onDidUpdate(() => {
      void this.#refreshCredentialStates();
    });
    this.#emit();
  }

  async initialize(): Promise<void> {
    try {
      await this.#profiles.initialize();
      await this.#refreshCredentialStates();
    } catch {
      this.#error = "Provider settings could not be loaded.";
    } finally {
      this.#loading = false;
      this.#emit();
    }
  }

  async addProfile(providerId: string): Promise<void> {
    await this.#run(async () => {
      await this.#profiles.addProfile(providerId);
    });
  }

  async updateProfile(
    profileId: string,
    patch: DesktopProviderProfilePatch,
  ): Promise<void> {
    await this.#run(() => this.#profiles.updateProfile(profileId, patch));
  }

  async setActiveProfile(profileId: string | null): Promise<void> {
    await this.#run(() => this.#profiles.setActiveProfileId(profileId));
  }

  async deleteProfile(profileId: string): Promise<void> {
    await this.#run(async () => {
      await this.#profiles.deleteProfile(profileId);
      this.#configured.delete(profileId);
    });
  }

  async saveCredential(profileId: string, secret: string): Promise<void> {
    await this.#run(async () => {
      const profile = this.#profile(profileId);
      await this.#secrets.setSecret(profile.secretRef, secret);
      this.#configured.set(profileId, true);
    });
  }

  async removeCredential(profileId: string): Promise<void> {
    await this.#run(async () => {
      const profile = this.#profile(profileId);
      await this.#secrets.deleteSecret(profile.secretRef);
      this.#configured.set(profileId, false);
    });
  }

  dispose(): void {
    this.#disposed = true;
    this.#unsubscribe();
  }

  async #refreshCredentialStates(): Promise<void> {
    const profiles = this.#profiles.getStoredSettings().profiles;
    const entries = await Promise.all(
      profiles.map(async (profile) => {
        try {
          return [profile.id, await this.#secrets.hasSecret(profile.secretRef)] as const;
        } catch {
          return [profile.id, false] as const;
        }
      }),
    );
    this.#configured.clear();
    for (const [profileId, configured] of entries) {
      this.#configured.set(profileId, configured);
    }
    this.#emit();
  }

  async #run(action: () => Promise<void>): Promise<void> {
    this.#error = undefined;
    try {
      await action();
    } catch (error) {
      this.#error = safeSettingsError(error);
      this.#emit();
      throw error;
    }
    this.#emit();
  }

  #profile(profileId: string) {
    const profile = this.#profiles
      .getStoredSettings()
      .profiles.find((candidate) => candidate.id === profileId);
    if (profile === undefined) {
      throw new TypeError("This provider profile no longer exists.");
    }
    return profile;
  }

  #emit(): void {
    if (this.#disposed) {
      return;
    }
    const settings = this.#profiles.getStoredSettings();
    const profiles = settings.profiles.map((profile) => {
      const validation = validateProviderProfileForAnalysis(
        storedProfileAsCandidate(profile),
      );
      return Object.freeze({
        id: profile.id,
        name: profile.name,
        providerId: profile.providerId,
        modelId: profile.modelId,
        enabled: profile.enabled,
        configured: this.#configured.get(profile.id) ?? false,
        valid: validation.valid,
        issues: validation.issues,
        ...(profile.baseUrl === undefined ? {} : { baseUrl: profile.baseUrl }),
        ...(profile.compatibilityMode === undefined
          ? {}
          : { compatibilityMode: profile.compatibilityMode }),
      });
    });
    const active = profiles.find(
      (profile) => profile.id === settings.activeProfileId,
    );
    this.#present(
      Object.freeze({
        loading: this.#loading,
        activeProfileId: settings.activeProfileId,
        configurationRequired:
          active === undefined || !active.valid || !active.configured,
        providers: PROVIDERS,
        compatibilityModes: STRUCTURED_OUTPUT_MODES,
        profiles: Object.freeze(profiles),
        ...(this.#error === undefined ? {} : { error: this.#error }),
      }),
    );
  }
}

export const EMPTY_DESKTOP_PROVIDER_SETTINGS_VIEW: DesktopProviderSettingsView =
  Object.freeze({
    loading: true,
    activeProfileId: null,
    configurationRequired: true,
    providers: PROVIDERS,
    compatibilityModes: STRUCTURED_OUTPUT_MODES,
    profiles: Object.freeze([]),
  });

export function isCustomProvider(providerId: string): boolean {
  return providerId === OPENAI_COMPATIBLE_PROVIDER_DEFINITION.id;
}

function safeSettingsError(error: unknown): string {
  return error instanceof TypeError || error instanceof Error
    ? error.message
    : "Provider settings could not be updated.";
}
