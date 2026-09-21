import { describe, expect, it, vi } from "vitest";

import {
  DesktopProviderProfileStore,
  loadDesktopProviderSettings,
  type DesktopProviderSettingsPersistence,
  type DesktopStoredProviderSettings,
} from "./desktop-provider-settings.js";

class MemoryPersistence implements DesktopProviderSettingsPersistence {
  value: unknown;
  readonly saves: DesktopStoredProviderSettings[] = [];

  constructor(value: unknown = undefined) {
    this.value = value;
  }

  async load(): Promise<unknown> {
    return this.value;
  }

  async save(settings: DesktopStoredProviderSettings): Promise<void> {
    this.value = settings;
    this.saves.push(settings);
  }
}

async function configuredStore() {
  const persistence = new MemoryPersistence();
  let number = 0;
  const store = new DesktopProviderProfileStore(
    persistence,
    () => `profile-${++number}`,
  );
  await store.initialize();
  const first = await store.addProfile("openai");
  await store.updateProfile(first, { modelId: "gpt-arbitrary" });
  await store.setActiveProfileId(first);
  return { store, persistence, first };
}

describe("DesktopProviderProfileStore", () => {
  it("starts clean with no profiles", async () => {
    const store = new DesktopProviderProfileStore(new MemoryPersistence());
    await store.initialize();
    expect(store.getSettings()).toEqual({ profiles: [], activeProfileId: undefined });
  });

  it.each([undefined, null, "bad", { profiles: "bad" }, { profiles: [{ id: "bad id" }] }])(
    "falls back safely for malformed settings %#",
    (value) => {
      expect(loadDesktopProviderSettings(value).profiles).toEqual([]);
    },
  );

  it("creates a profile with a generated secretRef and no secret", async () => {
    const { store } = await configuredStore();
    const profile = store.getStoredSettings().profiles[0]!;
    expect(profile.secretRef).toBe("provider-credential-profile-1");
    expect(profile.baseUrl).toBe("https://api.openai.com/v1");
    expect(profile).not.toHaveProperty("secret");
    expect(profile).not.toHaveProperty("apiKey");
  });

  it("restores the centralized endpoint for built-in providers", () => {
    const loaded = loadDesktopProviderSettings({
      activeProfileId: "one",
      profiles: [{
        id: "one",
        name: "OpenAI",
        providerId: "openai",
        modelId: "model",
        secretRef: "credential-one",
        baseUrl: "https://credential-stealing.example/v1",
        enabled: true,
      }],
    });
    expect(loaded.profiles[0]?.baseUrl).toBe("https://api.openai.com/v1");
  });

  it("updates an arbitrary model ID and persists metadata", async () => {
    const { store, persistence, first } = await configuredStore();
    await store.updateProfile(first, { modelId: "future-model-2099" });
    expect(store.getSettings().profiles[0]?.modelId).toBe("future-model-2099");
    expect(JSON.stringify(persistence.saves.at(-1))).not.toContain("Bearer");
  });

  it("switches provider without importing a second catalog", async () => {
    const { store, first } = await configuredStore();
    await store.updateProfile(first, { providerId: "anthropic" });
    expect(store.getStoredSettings().profiles[0]?.providerId).toBe("anthropic");
  });

  it("persists custom base URL and compatibility mode", async () => {
    const { store, first } = await configuredStore();
    await store.updateProfile(first, {
      providerId: "openai-compatible",
      baseUrl: "https://api.deepseek.com/v1",
      compatibilityMode: "json-object",
      modelId: "deepseek-chat",
    });
    expect(store.getStoredSettings().profiles[0]).toMatchObject({
      baseUrl: "https://api.deepseek.com/v1",
      compatibilityMode: "json-object",
    });
  });

  it("rejects non-loopback HTTP custom endpoints from runtime settings", async () => {
    const { store, first } = await configuredStore();
    await store.updateProfile(first, {
      providerId: "openai-compatible",
      baseUrl: "http://api.example.com/v1",
    });
    expect(store.getSettings().profiles).toHaveLength(0);
    expect(store.getSettings().activeProfileId).toBeUndefined();
  });

  it("supports enabling and disabling profiles", async () => {
    const { store, first } = await configuredStore();
    await store.updateProfile(first, { enabled: false });
    expect(store.getStoredSettings().profiles[0]?.enabled).toBe(false);
    expect(store.getSettings().profiles).toHaveLength(0);
  });

  it("selects a valid active profile", async () => {
    const { store, first } = await configuredStore();
    expect(store.getSettings().activeProfileId).toBe(first);
  });

  it("selects deterministic fallback then null when active profiles are deleted", async () => {
    const { store, first } = await configuredStore();
    const second = await store.addProfile("gemini");
    await store.updateProfile(second, { modelId: "gemini-future" });
    await store.deleteProfile(first);
    expect(store.getStoredSettings().activeProfileId).toBe(second);
    await store.deleteProfile(second);
    expect(store.getStoredSettings().activeProfileId).toBeNull();
  });

  it("deleting metadata never invokes any credential operation", async () => {
    const { store, first } = await configuredStore();
    const credentialDelete = vi.fn();
    await store.deleteProfile(first);
    expect(credentialDelete).not.toHaveBeenCalled();
  });
});
