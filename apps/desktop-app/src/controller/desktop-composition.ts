import type {
  TextContext,
  TextEditPort,
} from "@non-native-writing/application";
import { createBuiltInProviderRegistry } from "@non-native-writing/model-integration";

import {
  DESKTOP_ANALYSIS_CONFIGURATION,
  DesktopEngineController,
  type DesktopNormalizedAcceptResult,
  type DesktopNormalizedAcceptTarget,
  type DesktopNativeIntentConfirmationResult,
  type DesktopNativeIntentTarget,
  type DesktopObservationOptions,
  type PresentDesktopAssistance,
} from "./desktop-engine-controller.js";
import {
  GlobalDesktopAssistantController,
  type GlobalDesktopManualAnalysisResult,
  type PresentGlobalDesktopAssistant,
} from "./global-desktop-assistant-controller.js";
import { DesktopHttpTransport } from "../native/desktop-http-transport.js";
import { TauriProviderSettingsPersistence } from "../native/desktop-provider-settings-persistence.js";
import {
  DesktopSecretResolver,
  TauriDesktopSecretStore,
} from "../native/desktop-secret-store.js";
import { WindowsActiveTextSurfacePort } from "../native/windows-active-text-surface.js";
import { DesktopProfileAnalysisConfigurationSource } from "../provider/desktop-analysis-configuration-source.js";
import { DesktopProfiledAnalysisProvider } from "../provider/desktop-profiled-analysis-provider.js";
import { DesktopProviderProfileStore } from "../settings/desktop-provider-settings.js";
import {
  DesktopProviderSettingsController,
  type DesktopProviderSettingsPort,
  type PresentDesktopProviderSettings,
} from "../settings/desktop-settings-controller.js";

export interface DesktopControllerPort extends DesktopProviderSettingsPort {
  observe(
    context: TextContext,
    editPort?: TextEditPort | null,
    options?: DesktopObservationOptions,
  ): void;
  confirmNativeIntent(
    target: DesktopNativeIntentTarget,
    text: string,
  ): DesktopNativeIntentConfirmationResult;
  acceptNormalized(
    target: DesktopNormalizedAcceptTarget,
  ): Promise<DesktopNormalizedAcceptResult>;
  analyzeWindowsActiveTextSurface(): Promise<GlobalDesktopManualAnalysisResult>;
  acceptWindowsNormalized(
    target: DesktopNormalizedAcceptTarget,
  ): Promise<DesktopNormalizedAcceptResult>;
  dispose(): void;
}

export type DesktopControllerFactory = (
  present: PresentDesktopAssistance,
  presentSettings: PresentDesktopProviderSettings,
  presentGlobal: PresentGlobalDesktopAssistant,
) => DesktopControllerPort;

/** Desktop composition root. React receives only the controller port. */
export const createDesktopController: DesktopControllerFactory = (
  present,
  presentSettings,
  presentGlobal,
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
  let global: GlobalDesktopAssistantController | null = null;
  let pendingContext: TextContext | null = null;
  let pendingEditPort: TextEditPort | null = null;
  let pendingObservationOptions: DesktopObservationOptions | undefined;
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
    const configurationSource = new DesktopProfileAnalysisConfigurationSource(
      DESKTOP_ANALYSIS_CONFIGURATION,
      profiles,
    );
    writing = new DesktopEngineController(provider, present, {
      configurationSource,
    });
    global = new GlobalDesktopAssistantController(
      new WindowsActiveTextSurfacePort(),
      provider,
      presentGlobal,
      { configurationSource },
    );
    if (pendingContext !== null) {
      writing.observe(
        pendingContext,
        pendingEditPort,
        pendingObservationOptions,
      );
      pendingContext = null;
      pendingEditPort = null;
      pendingObservationOptions = undefined;
    }
  });

  return {
    observe: (context, editPort, options) => {
      if (writing === null) {
        pendingContext = context;
        pendingEditPort = editPort ?? null;
        pendingObservationOptions = options;
      } else {
        writing.observe(context, editPort, options);
      }
    },
    confirmNativeIntent: (target, text) =>
      writing?.confirmNativeIntent(target, text) ?? "obsolete",
    acceptNormalized: (target) =>
      writing?.acceptNormalized(target) ?? Promise.resolve("obsolete"),
    analyzeWindowsActiveTextSurface: () =>
      global?.analyzeActiveTextSurface() ?? Promise.resolve("unavailable"),
    acceptWindowsNormalized: (target) =>
      global?.acceptNormalized(target) ?? Promise.resolve("obsolete"),
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
      pendingEditPort = null;
      pendingObservationOptions = undefined;
      settings.dispose();
      writing?.dispose();
      global?.dispose();
    },
  };
};
