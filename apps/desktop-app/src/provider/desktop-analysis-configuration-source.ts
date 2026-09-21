import type { AnalysisConfiguration } from "@non-native-writing/application";
import {
  createActiveProfileFingerprint,
  type ProviderSettingsSource,
} from "@non-native-writing/model-integration";

export interface DesktopAnalysisConfigurationSource {
  getConfiguration(): AnalysisConfiguration;
  onDidChange(listener: () => void): () => void;
}

export class StaticDesktopAnalysisConfigurationSource
  implements DesktopAnalysisConfigurationSource
{
  readonly #configuration: AnalysisConfiguration;

  constructor(configuration: AnalysisConfiguration) {
    this.#configuration = Object.freeze({ ...configuration });
  }

  getConfiguration(): AnalysisConfiguration {
    return this.#configuration;
  }

  onDidChange(_listener: () => void): () => void {
    return () => undefined;
  }
}

export class DesktopProfileAnalysisConfigurationSource
  implements DesktopAnalysisConfigurationSource
{
  readonly #base: AnalysisConfiguration;
  readonly #profiles: ProviderSettingsSource;

  constructor(base: AnalysisConfiguration, profiles: ProviderSettingsSource) {
    this.#base = Object.freeze({ ...base });
    this.#profiles = profiles;
  }

  getConfiguration(): AnalysisConfiguration {
    return Object.freeze({
      ...this.#base,
      processorConfigurationFingerprint: `${this.#base.processorConfigurationFingerprint}|provider:${createActiveProfileFingerprint(this.#profiles.getSettings())}`,
    });
  }

  onDidChange(listener: () => void): () => void {
    return this.#profiles.onDidChange(listener);
  }
}
