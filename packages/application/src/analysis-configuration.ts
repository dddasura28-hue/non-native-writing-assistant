export interface AnalysisConfiguration {
  readonly assistPolicyFingerprint: string;
  readonly styleProfileFingerprint: string;
  readonly languageConfigurationFingerprint: string;
  readonly processorConfigurationFingerprint: string;
  readonly targetLanguageId: string;
  readonly nativeLanguageId: string;
}

export function copyAnalysisConfiguration(
  configuration: AnalysisConfiguration,
): AnalysisConfiguration {
  return Object.freeze({ ...configuration });
}
