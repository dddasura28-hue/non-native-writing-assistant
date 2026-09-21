import { describe, expect, it, vi } from "vitest";

import { DesktopHttpTransport, assertRequestAllowedForProfile } from "./desktop-http-transport.js";
import {
  DesktopSecretResolver,
  TauriDesktopSecretStore,
} from "./desktop-secret-store.js";
import { TauriProviderSettingsPersistence } from "./desktop-provider-settings-persistence.js";
import type { NativeInvoke } from "./native-command-client.js";

function nativeInvoke(
  implementation: (command: string, args?: Record<string, unknown>) => Promise<unknown>,
): { readonly invoke: NativeInvoke; readonly mock: ReturnType<typeof vi.fn> } {
  const mock = vi.fn(implementation);
  return {
    invoke: <T>(command: string, args?: Record<string, unknown>) =>
      mock(command, args) as Promise<T>,
    mock,
  };
}

describe("desktop native boundaries", () => {
  it("resolves configured and missing credentials through fixed commands", async () => {
    const { invoke, mock } = nativeInvoke(async (command: string) =>
      command === "get_provider_secret" ? "resolved-secret" : null,
    );
    const resolver = new DesktopSecretResolver(new TauriDesktopSecretStore(invoke));
    await expect(resolver.resolveSecret("profile-one")).resolves.toBe("resolved-secret");
    expect(mock).toHaveBeenCalledWith("get_provider_secret", {
      secretRef: "profile-one",
    });

    const missing = new DesktopSecretResolver(
      new TauriDesktopSecretStore(nativeInvoke(async () => null).invoke),
    );
    await expect(missing.resolveSecret("profile-one")).resolves.toBeNull();
  });

  it("stores replacement credentials and removes them only explicitly", async () => {
    const { invoke, mock } = nativeInvoke(async () => undefined);
    const store = new TauriDesktopSecretStore(invoke);
    await store.setSecret("profile-one", "new-secret");
    await store.deleteSecret("profile-one");
    expect(mock.mock.calls).toEqual([
      ["set_provider_secret", { secretRef: "profile-one", secret: "new-secret" }],
      ["delete_provider_secret", { secretRef: "profile-one" }],
    ]);
  });

  it("persists profile metadata without adding secret values", async () => {
    const { invoke, mock } = nativeInvoke(async () => undefined);
    const persistence = new TauriProviderSettingsPersistence(invoke);
    const settings = {
      activeProfileId: "one",
      profiles: [{
        id: "one",
        name: "OpenAI",
        providerId: "openai",
        modelId: "model",
        secretRef: "profile-one",
        enabled: true,
      }],
    };
    await persistence.save(settings);
    const sent = mock.mock.calls[0]?.[1];
    expect(JSON.stringify(sent)).toContain("profile-one");
    expect(JSON.stringify(sent)).not.toContain("apiKey");
    expect(JSON.stringify(sent)).not.toContain("secret\"");
  });

  it("allows only the active profile origin and base path", async () => {
    const profile = {
      id: "one",
      name: "Custom",
      providerId: "openai-compatible",
      modelId: "model",
      secretRef: "profile-one",
      enabled: true,
      baseUrl: "https://models.example/v1",
      compatibilityMode: "json-schema" as const,
    };
    expect(() =>
      assertRequestAllowedForProfile(
        "https://models.example/v1/chat/completions",
        profile,
      ),
    ).not.toThrow();
    expect(() =>
      assertRequestAllowedForProfile("https://evil.example/v1", profile),
    ).toThrow(/active profile endpoint/u);
  });

  it("returns native status, headers, and body without provider logic", async () => {
    const settings = {
      getSettings: () => ({
        profiles: [{
          id: "one",
          name: "OpenAI",
          providerId: "openai",
          modelId: "model",
          secretRef: "profile-one",
          enabled: true,
        }],
        activeProfileId: "one",
      }),
      onDidChange: () => () => undefined,
    };
    const { invoke, mock } = nativeInvoke(async () => ({ status: 200, headers: { "x-id": "1" }, body: "{}" }));
    const transport = new DesktopHttpTransport(settings, invoke);
    await expect(transport.send({
      url: "https://api.openai.com/v1/responses",
      method: "POST",
      headers: { Authorization: "Bearer fake" },
      body: "{}",
    })).resolves.toEqual({ status: 200, headers: { "x-id": "1" }, body: "{}" });
    expect(mock).toHaveBeenCalledWith("send_provider_http_request", {
      request: expect.objectContaining({ method: "POST" }),
    });
  });
});
