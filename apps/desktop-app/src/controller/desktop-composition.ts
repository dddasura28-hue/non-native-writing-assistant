import type { TextContext } from "@non-native-writing/application";
import { createBuiltInProviderRegistry } from "@non-native-writing/model-integration";

import {
  DESKTOP_ANALYSIS_CONFIGURATION,
  DesktopEngineController,
  type DesktopNativeIntentConfirmationResult,
  type DesktopNativeIntentTarget,
  type PresentDesktopAssistance,
} from "./desktop-engine-controller.js";
import { DesktopHttpTransport } from "../native/desktop-http-transport.js";
import { TauriProviderSettingsPersistence } from "../native/desktop-provider-settings-persistence.js";
import {
  DesktopSecretResolver,
  TauriDesktopSecretStore,
} from "../native/desktop-secret-store.js";
import { DesktopProfileAnalysisConfigurationSource } from "../provider/desktop-analysis-configuration-source.js";
import { DesktopProfiledAnalysisProvider } from "../provider/desktop-profiled-analysis-provider.js";
import { DesktopProviderProfileStore } from "../settings/desktop-provider-settings.js";
import {
  DesktopProviderSettingsController,
  type DesktopProviderSettingsPort,
  type PresentDesktopProviderSettings,
} from "../settings/desktop-settings-controller.js";

export interface DesktopControllerPort extends DesktopProviderSettingsPort {
  observe(context: TextContext): void;
  confirmNativeIntent(
    target: DesktopNativeIntentTarget,
    text: string,
  ): DesktopNativeIntentConfirmationResult;
  dispose(): void;
}

export type DesktopControllerFactory = (
  present: PresentDesktopAssistance,
  presentSettings: PresentDesktopProviderSettings,
) => DesktopControllerPort;

/** Desktop composition root. React receives only the controller port. */
export const createDesktopController: DesktopControllerFactory = (
  present,
  presentSettings,
) => {
  const profiles = new DesktopProviderProfileStore(
    new TauriProviderSettingsPersistence(),
  );
  const secrets = new TauriDesktopSecretStore();
  const settings = new DesktopProviderSettingsController(
    profiles,
    secrets,
    presentSettings,
  );
  let writing: DesktopEngineController | null = null;
  let pendingContext: TextContext | null = null;
  let disposed = false;

  void settings.initialize().then(() => {
    if (disposed) {
      return;
    }
    const transport = new DesktopHttpTransport(profiles);
    const provider = new DesktopProfiledAnalysisProvider(
      profiles,
      createBuiltInProviderRegistry(transport),
      new DesktopSecretResolver(secrets),
    );
    writing = new DesktopEngineController(provider, present, {
      configurationSource: new DesktopProfileAnalysisConfigurationSource(
        DESKTOP_ANALYSIS_CONFIGURATION,
        profiles,
      ),
    });
    if (pendingContext !== null) {
      writing.observe(pendingContext);
      pendingContext = null;
    }
  });

  return {
    observe: (context) => {
      if (writing === null) {
        pendingContext = context;
      } else {
        writing.observe(context);
      }
    },
    confirmNativeIntent: (target, text) =>
      writing?.confirmNativeIntent(target, text) ?? "obsolete",
    addProfile: (providerId) => settings.addProfile(providerId),
    updateProfile: (profileId, patch) =>
      settings.updateProfile(profileId, patch),
    setActiveProfile: (profileId) => settings.setActiveProfile(profileId),
    deleteProfile: (profileId) => settings.deleteProfile(profileId),
    saveCredential: (profileId, secret) =>
      settings.saveCredential(profileId, secret),
    removeCredential: (profileId) => settings.removeCredential(profileId),
    dispose: () => {
      disposed = true;
      pendingContext = null;
      settings.dispose();
      writing?.dispose();
    },
  };
};
