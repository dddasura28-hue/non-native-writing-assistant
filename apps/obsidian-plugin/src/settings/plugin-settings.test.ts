import { describe, expect, it } from "vitest";

import {
  DEFAULT_PLUGIN_SETTINGS,
  loadPluginSettings,
} from "./plugin-settings.js";

describe("plugin settings loading", () => {
  it("loads missing settings as empty provider settings", () => {
    expect(loadPluginSettings(undefined)).toEqual(DEFAULT_PLUGIN_SETTINGS);
    expect(loadPluginSettings({})).toEqual(DEFAULT_PLUGIN_SETTINGS);
  });

  it("keeps an incomplete or unknown profile editable without trusting extra fields", () => {
    const loaded = loadPluginSettings({
      providerSettings: {
        activeProfileId: "legacy-profile",
        profiles: [
          null,
          { id: "", providerId: "openai" },
          {
            id: "legacy-profile",
            name: "Legacy",
            providerId: "obsolete-provider",
            modelId: "",
            secretRef: "",
            enabled: true,
            apiKey: "fake-key-that-must-be-discarded",
            unexpected: "discarded",
          },
        ],
      },
    });

    expect(loaded.providerSettings.activeProfileId).toBe("legacy-profile");
    expect(loaded.providerSettings.profiles).toEqual([
      {
        id: "legacy-profile",
        name: "Legacy",
        providerId: "obsolete-provider",
        modelId: "",
        secretRef: "",
        enabled: true,
      },
    ]);
    expect(JSON.stringify(loaded)).not.toContain("apiKey");
    expect(JSON.stringify(loaded)).not.toContain("fake-key-that-must-be-discarded");
  });

  it("drops duplicate identities and a missing active-profile reference safely", () => {
    const loaded = loadPluginSettings({
      providerSettings: {
        activeProfileId: "missing",
        profiles: [
          { id: "same", name: "First" },
          { id: "same", name: "Second" },
        ],
      },
    });

    expect(loaded.providerSettings.activeProfileId).toBeNull();
    expect(loaded.providerSettings.profiles).toHaveLength(1);
    expect(loaded.providerSettings.profiles[0]?.name).toBe("First");
  });

  it("round-trips OpenAI-compatible fields", () => {
    const loaded = loadPluginSettings({
      providerSettings: {
        activeProfileId: "custom",
        profiles: [
          {
            id: "custom",
            name: "Local model",
            providerId: "openai-compatible",
            modelId: "custom-model",
            secretRef: "shared-secret",
            baseUrl: "https://models.example.test/v1",
            compatibilityMode: "prompt-json",
            enabled: true,
          },
        ],
      },
    });

    expect(loaded.providerSettings.profiles[0]).toMatchObject({
      baseUrl: "https://models.example.test/v1",
      compatibilityMode: "prompt-json",
    });
  });
});
