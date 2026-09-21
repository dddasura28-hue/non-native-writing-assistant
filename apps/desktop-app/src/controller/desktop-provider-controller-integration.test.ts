import { createTextContext } from "@non-native-writing/application";
import {
  MutableProviderSettings,
  createBuiltInProviderRegistry,
  createProviderProfile,
  type HttpTransport,
  type HttpTransportRequest,
  type SecretResolver,
} from "@non-native-writing/model-integration";
import { describe, expect, it } from "vitest";

import { DesktopProfileAnalysisConfigurationSource } from "../provider/desktop-analysis-configuration-source.js";
import { DesktopProfiledAnalysisProvider } from "../provider/desktop-profiled-analysis-provider.js";
import {
  DESKTOP_ANALYSIS_CONFIGURATION,
  DesktopEngineController,
  type DesktopAssistancePresentation,
} from "./desktop-engine-controller.js";

class FakeTransport implements HttpTransport {
  readonly requests: HttpTransportRequest[] = [];

  async send(request: HttpTransportRequest) {
    this.requests.push(request);
    return {
      status: 200,
      headers: {},
      body: JSON.stringify({
        output: [{
          content: [{
            type: "output_text",
            text: JSON.stringify({
              nativeIntent: { text: "准备好了。" },
              normalized: [{ text: "Ready.", label: null }],
            }),
          }],
        }],
      }),
    };
  }
}

const fakeSecrets: SecretResolver = {
  resolveSecret: async () => "deterministic-test-secret",
};

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}

describe("desktop provider/controller integration", () => {
  it("analyzes a completed unit through the configured real adapter composition", async () => {
    const profile = createProviderProfile({
      id: "primary",
      name: "Primary",
      providerId: "openai",
      modelId: "open-model",
      secretRef: "primary-credential",
      enabled: true,
    });
    const settings = new MutableProviderSettings({
      profiles: [profile],
      activeProfileId: profile.id,
    });
    const transport = new FakeTransport();
    const presentations: DesktopAssistancePresentation[] = [];
    const controller = new DesktopEngineController(
      new DesktopProfiledAnalysisProvider(
        settings,
        createBuiltInProviderRegistry(transport),
        fakeSecrets,
      ),
      (presentation) => presentations.push(presentation),
      {
        configurationSource: new DesktopProfileAnalysisConfigurationSource(
          DESKTOP_ANALYSIS_CONFIGURATION,
          settings,
        ),
      },
    );

    controller.observe(createTextContext({
      text: "Ready.",
      cursorOffset: 6,
      selection: null,
      composition: null,
    }));
    await settle();

    expect(transport.requests).toHaveLength(1);
    expect(presentations.at(-1)?.active?.nativeIntentTracks[0]?.text).toBe("准备好了。");
    expect(presentations.at(-1)?.active?.normalizedTracks[0]?.text).toBe("Ready.");
    controller.dispose();
  });

  it("makes no transport request without configuration and keeps accepting editor input", async () => {
    const settings = new MutableProviderSettings();
    const transport = new FakeTransport();
    const presentations: DesktopAssistancePresentation[] = [];
    const controller = new DesktopEngineController(
      new DesktopProfiledAnalysisProvider(
        settings,
        createBuiltInProviderRegistry(transport),
        fakeSecrets,
      ),
      (presentation) => presentations.push(presentation),
    );

    controller.observe(createTextContext({
      text: "First.",
      cursorOffset: 6,
      selection: null,
      composition: null,
    }));
    await settle();
    expect(transport.requests).toHaveLength(0);
    expect(presentations.at(-1)?.active?.statusMessage).toBe("Configuration required");

    controller.observe(createTextContext({
      text: "Second.",
      cursorOffset: 7,
      selection: null,
      composition: null,
    }));
    await settle();
    expect(presentations.at(-1)?.active?.sourceText).toBe("Second.");
    expect(transport.requests).toHaveLength(0);
    controller.dispose();
  });
});
