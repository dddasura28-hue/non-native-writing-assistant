import type { AnalysisConfiguration } from "@non-native-writing/application";
import type { ProviderSettings } from "@non-native-writing/model-integration";

export type DevelopmentAnalysisProviderKind =
  | "demo"
  | "gateway"
  | "http"
  | "profile";

declare const __NNWA_ANALYSIS_PROVIDER__: DevelopmentAnalysisProviderKind;

export const DEVELOPMENT_ANALYSIS_PROVIDER: DevelopmentAnalysisProviderKind =
  typeof __NNWA_ANALYSIS_PROVIDER__ === "undefined"
    ? "demo"
    : __NNWA_ANALYSIS_PROVIDER__;

export const DEVELOPMENT_GATEWAY_URL =
  "http://127.0.0.1:8787/v1/analyze";

export const DEVELOPMENT_ANALYSIS_CONFIGURATION: AnalysisConfiguration =
  Object.freeze({
    assistPolicyFingerprint: "development-assist-policy:v1",
    styleProfileFingerprint: "development-style-profile:v1",
    languageConfigurationFingerprint: "languages:zh-CN-en:v1",
    processorConfigurationFingerprint: "writing-analysis:v1",
    targetLanguageId: "en",
    nativeLanguageId: "zh-CN",
  });

// Provider-profile persistence and editing UI are intentionally deferred.
// The direct BYOK path therefore starts with no configured profiles.
export const DEVELOPMENT_PROVIDER_SETTINGS: ProviderSettings = Object.freeze({
  profiles: Object.freeze([]),
});
