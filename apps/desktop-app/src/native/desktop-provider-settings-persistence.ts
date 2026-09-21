import type {
  DesktopProviderSettingsPersistence,
  DesktopStoredProviderSettings,
} from "../settings/desktop-provider-settings.js";
import { invokeNative, type NativeInvoke } from "./native-command-client.js";

export class TauriProviderSettingsPersistence
  implements DesktopProviderSettingsPersistence
{
  readonly #invoke: NativeInvoke;

  constructor(invoke: NativeInvoke = invokeNative) {
    this.#invoke = invoke;
  }

  load(): Promise<unknown> {
    return this.#invoke<unknown>("load_provider_settings");
  }

  save(settings: DesktopStoredProviderSettings): Promise<void> {
    return this.#invoke<void>("save_provider_settings", { settings });
  }
}
