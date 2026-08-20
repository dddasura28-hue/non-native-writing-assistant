export interface ProviderDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly defaultBaseUrl?: string;
  readonly suggestedModelIds: readonly string[];
}

export const OPENAI_PROVIDER_DEFINITION: ProviderDefinition = Object.freeze({
  id: "openai",
  displayName: "OpenAI",
  defaultBaseUrl: "https://api.openai.com/v1",
  suggestedModelIds: Object.freeze([]),
});

export const ANTHROPIC_PROVIDER_DEFINITION: ProviderDefinition = Object.freeze({
  id: "anthropic",
  displayName: "Anthropic",
  defaultBaseUrl: "https://api.anthropic.com/v1",
  suggestedModelIds: Object.freeze([]),
});

export const GEMINI_PROVIDER_DEFINITION: ProviderDefinition = Object.freeze({
  id: "gemini",
  displayName: "Google Gemini",
  defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
  suggestedModelIds: Object.freeze([]),
});

export const OPENAI_COMPATIBLE_PROVIDER_DEFINITION: ProviderDefinition =
  Object.freeze({
    id: "openai-compatible",
    displayName: "OpenAI-compatible / custom",
    suggestedModelIds: Object.freeze([]),
  });

export const BUILT_IN_PROVIDER_DEFINITIONS = Object.freeze([
  OPENAI_PROVIDER_DEFINITION,
  ANTHROPIC_PROVIDER_DEFINITION,
  GEMINI_PROVIDER_DEFINITION,
  OPENAI_COMPATIBLE_PROVIDER_DEFINITION,
]);
