import {
  BUILT_IN_PROVIDER_DEFINITIONS,
  OPENAI_COMPATIBLE_PROVIDER_DEFINITION,
  type ProviderDefinition,
} from "./provider-definitions.js";
import {
  createProviderProfile,
  type ProviderProfile,
} from "./provider-profile.js";

export type ProviderProfileValidation =
  | {
      readonly valid: true;
      readonly profile: ProviderProfile;
      readonly issues: readonly string[];
    }
  | {
      readonly valid: false;
      readonly issues: readonly string[];
    };

export function validateProviderProfileForAnalysis(
  candidate: ProviderProfile,
  definitions: readonly ProviderDefinition[] = BUILT_IN_PROVIDER_DEFINITIONS,
): ProviderProfileValidation {
  const issues: string[] = [];
  const knownProvider = definitions.some(
    (definition) => definition.id === candidate.providerId,
  );

  if (!knownProvider) {
    issues.push("Choose a supported provider.");
  }
  if (!candidate.enabled) {
    issues.push("Enable this profile before using it.");
  }
  if (
    candidate.providerId === OPENAI_COMPATIBLE_PROVIDER_DEFINITION.id &&
    (candidate.baseUrl === undefined || candidate.baseUrl.trim().length === 0)
  ) {
    issues.push("Enter a base URL for the custom provider.");
  }

  let profile: ProviderProfile | undefined;
  try {
    profile = createProviderProfile(candidate);
  } catch (error) {
    issues.push(
      error instanceof Error ? error.message : "The profile is invalid.",
    );
  }

  if (issues.length > 0 || profile === undefined) {
    return Object.freeze({
      valid: false as const,
      issues: Object.freeze([...new Set(issues)]),
    });
  }

  return Object.freeze({
    valid: true as const,
    profile,
    issues: Object.freeze([]),
  });
}
