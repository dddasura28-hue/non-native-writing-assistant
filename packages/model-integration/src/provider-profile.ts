import { WritingModelError } from "./writing-model-error.js";

export type StructuredOutputMode =
  | "json-schema"
  | "json-object"
  | "prompt-json";

export interface ProviderProfile {
  readonly id: string;
  readonly name: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly secretRef: string;
  readonly baseUrl?: string;
  readonly compatibilityMode?: StructuredOutputMode;
  readonly enabled: boolean;
}

export function createProviderProfile(
  profile: ProviderProfile,
): ProviderProfile {
  assertNonEmpty(profile.id, "Provider profile ID");
  assertNonEmpty(profile.name, "Provider profile name");
  assertNonEmpty(profile.providerId, "Provider ID");
  assertNonEmpty(profile.modelId, "Model ID");
  assertNonEmpty(profile.secretRef, "Secret reference");

  if (profile.baseUrl !== undefined) {
    validateBaseUrl(profile.baseUrl);
  }

  return Object.freeze({ ...profile });
}

function assertNonEmpty(value: string, fieldName: string): void {
  if (value.trim().length === 0) {
    throw new WritingModelError(
      "invalid-profile",
      `${fieldName} must not be empty.`,
    );
  }
}

function validateBaseUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WritingModelError(
      "invalid-profile",
      "Provider base URL must be a valid HTTP or HTTPS URL.",
    );
  }

  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new WritingModelError(
      "invalid-profile",
      "Provider base URL must be an HTTP or HTTPS URL without credentials, query, or fragment.",
    );
  }
}
