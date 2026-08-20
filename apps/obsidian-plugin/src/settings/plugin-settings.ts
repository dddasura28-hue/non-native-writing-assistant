import type {
  ProviderProfile,
  StructuredOutputMode,
} from "@non-native-writing/model-integration";
import { STRUCTURED_OUTPUT_MODES } from "@non-native-writing/model-integration";

export interface StoredProviderProfile {
  readonly id: string;
  readonly name: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly secretRef: string;
  readonly baseUrl?: string;
  readonly compatibilityMode?: StructuredOutputMode;
  readonly enabled: boolean;
}

export interface ObsidianPluginSettings {
  readonly providerSettings: {
    readonly activeProfileId: string | null;
    readonly profiles: readonly StoredProviderProfile[];
  };
}

export const DEFAULT_PLUGIN_SETTINGS: ObsidianPluginSettings = Object.freeze({
  providerSettings: Object.freeze({
    activeProfileId: null,
    profiles: Object.freeze([]),
  }),
});

export function loadPluginSettings(value: unknown): ObsidianPluginSettings {
  const root = asRecord(value);
  const providerSettings = asRecord(root?.providerSettings);
  const rawProfiles = Array.isArray(providerSettings?.profiles)
    ? providerSettings.profiles
    : [];
  const ids = new Set<string>();
  const profiles: StoredProviderProfile[] = [];

  for (const rawProfile of rawProfiles) {
    const profile = loadStoredProfile(rawProfile);
    if (profile === undefined || ids.has(profile.id)) {
      continue;
    }
    ids.add(profile.id);
    profiles.push(profile);
  }

  const requestedActiveProfileId =
    typeof providerSettings?.activeProfileId === "string"
      ? providerSettings.activeProfileId
      : null;
  const activeProfileId =
    requestedActiveProfileId !== null && ids.has(requestedActiveProfileId)
      ? requestedActiveProfileId
      : null;

  return createPluginSettings(activeProfileId, profiles);
}

export function createPluginSettings(
  activeProfileId: string | null,
  profiles: readonly StoredProviderProfile[],
): ObsidianPluginSettings {
  return Object.freeze({
    providerSettings: Object.freeze({
      activeProfileId,
      profiles: Object.freeze(profiles.map(copyStoredProfile)),
    }),
  });
}

export function storedProfileAsCandidate(
  profile: StoredProviderProfile,
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

function loadStoredProfile(value: unknown): StoredProviderProfile | undefined {
  const profile = asRecord(value);
  const id = readString(profile?.id);
  if (id.trim().length === 0) {
    return undefined;
  }

  const compatibilityMode = readCompatibilityMode(
    profile?.compatibilityMode,
  );
  return copyStoredProfile({
    id,
    name: readString(profile?.name),
    providerId: readString(profile?.providerId),
    modelId: readString(profile?.modelId),
    secretRef: readString(profile?.secretRef),
    enabled: typeof profile?.enabled === "boolean" ? profile.enabled : true,
    ...(typeof profile?.baseUrl === "string"
      ? { baseUrl: profile.baseUrl }
      : {}),
    ...(compatibilityMode === undefined ? {} : { compatibilityMode }),
  });
}

function copyStoredProfile(
  profile: StoredProviderProfile,
): StoredProviderProfile {
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
