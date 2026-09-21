import { describe, expect, it } from "vitest";

import type { DesktopSecretStore } from "../native/desktop-secret-store.js";
import {
  DesktopProviderProfileStore,
  type DesktopProviderSettingsPersistence,
  type DesktopStoredProviderSettings,
} from "./desktop-provider-settings.js";
import {
  DesktopProviderSettingsController,
  type DesktopProviderSettingsView,
} from "./desktop-settings-controller.js";

class MemoryPersistence implements DesktopProviderSettingsPersistence {
  value: unknown = undefined;
  async load(): Promise<unknown> { return this.value; }
  async save(settings: DesktopStoredProviderSettings): Promise<void> { this.value = settings; }
}

class MemorySecrets implements DesktopSecretStore {
  readonly values = new Map<string, string>();
  readonly deletes: string[] = [];
  async setSecret(secretRef: string, secret: string): Promise<void> { this.values.set(secretRef, secret); }
  async getSecret(secretRef: string): Promise<string | null> { return this.values.get(secretRef) ?? null; }
  async hasSecret(secretRef: string): Promise<boolean> { return this.values.has(secretRef); }
  async deleteSecret(secretRef: string): Promise<void> { this.deletes.push(secretRef); this.values.delete(secretRef); }
}

function setup() {
  const persistence = new MemoryPersistence();
  const profiles = new DesktopProviderProfileStore(persistence, () => "profile-one");
  const secrets = new MemorySecrets();
  const views: DesktopProviderSettingsView[] = [];
  const controller = new DesktopProviderSettingsController(
    profiles,
    secrets,
    (view) => views.push(view),
  );
  return { controller, profiles, secrets, views };
}

describe("DesktopProviderSettingsController", () => {
  it("reports configuration required on clean startup", async () => {
    const { controller, views } = setup();
    await controller.initialize();
    expect(views.at(-1)).toMatchObject({ configurationRequired: true, profiles: [] });
  });

  it("saves and replaces a credential without presenting its value", async () => {
    const { controller, secrets, views } = setup();
    await controller.initialize();
    await controller.addProfile("openai");
    await controller.updateProfile("profile-one", { modelId: "arbitrary-model" });
    await controller.saveCredential("profile-one", "first-secret-value");
    await controller.saveCredential("profile-one", "replacement-secret-value");
    expect(secrets.values.get("provider-credential-profile-one")).toBe("replacement-secret-value");
    expect(views.at(-1)?.profiles[0]?.configured).toBe(true);
    expect(JSON.stringify(views)).not.toContain("first-secret-value");
    expect(JSON.stringify(views)).not.toContain("replacement-secret-value");
  });

  it("removes a credential only through the explicit operation", async () => {
    const { controller, profiles, secrets } = setup();
    await controller.initialize();
    await controller.addProfile("openai");
    await controller.saveCredential("profile-one", "secret");
    await controller.deleteProfile("profile-one");
    expect(secrets.deletes).toEqual([]);
    expect(profiles.getStoredSettings().profiles).toEqual([]);

    await controller.addProfile("openai");
    await controller.saveCredential("profile-one", "replacement");
    await controller.removeCredential("profile-one");
    expect(secrets.deletes).toEqual(["provider-credential-profile-one"]);
  });

  it("shows configured after restart without loading a stored key into presentation", async () => {
    const { controller, secrets, views } = setup();
    secrets.values.set("provider-credential-profile-one", "stored-key-never-rendered");
    await controller.initialize();
    await controller.addProfile("openai");
    await Promise.resolve();
    expect(views.at(-1)?.profiles[0]?.configured).toBe(true);
    expect(JSON.stringify(views)).not.toContain("stored-key-never-rendered");
  });
});
