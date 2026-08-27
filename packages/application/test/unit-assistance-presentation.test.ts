import {
  NATIVE_INTENT_TRACK_TYPE_ID,
  NORMALIZED_TRACK_TYPE_ID,
  asTrackId,
} from "@non-native-writing/core";
import { describe, expect, it } from "vitest";

import {
  AnalysisCoordinator,
  IncrementalUnitAnalysisCoordinator,
  RECENT_ASSISTANCE_LIMIT,
  SimpleWritingUnitSegmenter,
  createUnitAssistancePresentationModel,
  type AnalysisConfiguration,
  type AnalysisProposal,
  type ContextSelection,
} from "../src/index.js";
import {
  MockAnalysisProvider,
  type PendingAnalysisRequest,
} from "./mock-analysis-provider.js";

const segmenter = new SimpleWritingUnitSegmenter();

function configuration(
  processorConfigurationFingerprint = "processor:one",
): AnalysisConfiguration {
  return {
    assistPolicyFingerprint: "assist:test",
    styleProfileFingerprint: "style:test",
    languageConfigurationFingerprint: "languages:zh-en",
    processorConfigurationFingerprint,
    targetLanguageId: "en",
    nativeLanguageId: "zh-CN",
  };
}

function selection(
  activeText: string,
  beforeContext = "",
): ContextSelection {
  return Object.freeze({
    activeText,
    sourceRange: Object.freeze({ start: 0, end: activeText.length }),
    beforeContext,
    afterContext: "",
  });
}

function harness(text: string) {
  const provider = new MockAnalysisProvider();
  const coordinator = new IncrementalUnitAnalysisCoordinator(
    new AnalysisCoordinator(provider),
  );
  const contextSelection = selection(text);
  const units = segmenter.segment(text);
  coordinator.synchronize(contextSelection, units);
  return { provider, coordinator, units };
}

interface ProposalText {
  readonly nativeIntent?: string;
  readonly normalized?: readonly string[];
}

function proposalFor(
  request: PendingAnalysisRequest,
  suffix: string,
  text: ProposalText = {},
): AnalysisProposal {
  const nativeIntent = text.nativeIntent ?? `Intent ${suffix}`;
  const normalized = text.normalized ?? [`Normalized ${suffix}`];
  return Object.freeze({
    outputs: Object.freeze([
      Object.freeze({
        id: asTrackId(`intent-${suffix}`),
        typeId: NATIVE_INTENT_TRACK_TYPE_ID,
        text: nativeIntent,
        provenance: "model" as const,
        dependencyStamp: request.snapshot.dependencyStamp,
      }),
      ...normalized.map((normalizedText, index) =>
        Object.freeze({
          id: asTrackId(`normalized-${suffix}-${index}`),
          typeId: NORMALIZED_TRACK_TYPE_ID,
          text: normalizedText,
          provenance: "model" as const,
          dependencyStamp: request.snapshot.dependencyStamp,
          label: `Variant ${index + 1}`,
          order: index,
        }),
      ),
    ]),
  });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function completeUnit(
  coordinator: IncrementalUnitAnalysisCoordinator,
  provider: MockAnalysisProvider,
  unitId: string,
  suffix: string,
  text: ProposalText = {},
  config = configuration(),
): Promise<void> {
  const requestIndex = provider.requests.length;
  const outcome = coordinator.analyze(unitId, config);
  const request = provider.request(requestIndex);
  request.resolve(proposalFor(request, suffix, text));
  await flushMicrotasks();
  await expect(outcome).resolves.toMatchObject({ status: "applied" });
}

async function completeAll(
  coordinator: IncrementalUnitAnalysisCoordinator,
  provider: MockAnalysisProvider,
  unitIds: readonly string[],
): Promise<void> {
  for (const [index, unitId] of unitIds.entries()) {
    await completeUnit(coordinator, provider, unitId, `${index}`);
  }
}

describe("unit assistance presentation", () => {
  it("places the active unit in the primary item", () => {
    const { coordinator, units } = harness("One. Two. Three.");

    const model = createUnitAssistancePresentationModel(
      coordinator,
      units[1]!.id,
      configuration(),
    );

    expect(model.active).toMatchObject({
      unitId: units[1]!.id,
      sourceText: "Two.",
      isActive: true,
    });
    expect(model.recent).toEqual([]);
  });

  it("includes a current completed previous unit in Recent Assistance", async () => {
    const { coordinator, provider, units } = harness("One. Two.");
    await completeUnit(coordinator, provider, units[0]!.id, "one");

    const model = createUnitAssistancePresentationModel(
      coordinator,
      units[1]!.id,
      configuration(),
    );

    expect(model.recent).toEqual([
      expect.objectContaining({
        unitId: units[0]!.id,
        sourceText: "One.",
        status: "completed",
        isActive: false,
      }),
    ]);
  });

  it("never duplicates the active unit in Recent Assistance", async () => {
    const { coordinator, provider, units } = harness("One. Two.");
    await completeAll(
      coordinator,
      provider,
      units.map((unit) => unit.id),
    );

    const model = createUnitAssistancePresentationModel(
      coordinator,
      units[1]!.id,
      configuration(),
    );

    expect(model.active?.unitId).toBe(units[1]!.id);
    expect(model.recent.map((item) => item.unitId)).not.toContain(units[1]!.id);
  });

  it("omits dependency-stale units from Recent Assistance", async () => {
    const { coordinator, provider, units } = harness("One. Two.");
    await completeUnit(coordinator, provider, units[0]!.id, "one");
    const changedConfiguration = configuration("processor:two");
    coordinator.updateConfiguration(changedConfiguration);

    const model = createUnitAssistancePresentationModel(
      coordinator,
      units[1]!.id,
      changedConfiguration,
    );

    expect(model.recent).toEqual([]);
  });

  it("does not represent a failed unit as completed assistance", async () => {
    const { coordinator, provider, units } = harness("One. Two.");
    const outcome = coordinator.analyze(units[0]!.id, configuration());
    provider.request(0).reject(new Error("Deterministic failure"));
    await flushMicrotasks();
    await expect(outcome).resolves.toMatchObject({ status: "failed" });

    const model = createUnitAssistancePresentationModel(
      coordinator,
      units[1]!.id,
      configuration(),
    );

    expect(model.recent).toEqual([]);
  });

  it("drops a removed unit from presentation", async () => {
    const { coordinator, provider, units } = harness("One. Two.");
    await completeUnit(coordinator, provider, units[1]!.id, "two");
    const reduced = selection("One.");
    const reducedUnits = segmenter.segment(reduced.activeText);
    coordinator.synchronize(reduced, reducedUnits);

    const model = createUnitAssistancePresentationModel(
      coordinator,
      reducedUnits[0]!.id,
      configuration(),
    );

    expect(model.recent).toEqual([]);
    expect(model.active?.sourceText).toBe("One.");
  });

  it("caps Recent Assistance at the central fixed limit", async () => {
    const { coordinator, provider, units } = harness("A. B. C. D. E. F.");
    await completeAll(
      coordinator,
      provider,
      units.map((unit) => unit.id),
    );

    const model = createUnitAssistancePresentationModel(
      coordinator,
      units[5]!.id,
      configuration(),
    );

    expect(RECENT_ASSISTANCE_LIMIT).toBe(3);
    expect(model.recent).toHaveLength(RECENT_ASSISTANCE_LIMIT);
  });

  it("orders previous units nearest-first, then following units nearest-first", async () => {
    const { coordinator, provider, units } = harness("A. B. C. D. E.");
    await completeAll(
      coordinator,
      provider,
      units.map((unit) => unit.id),
    );

    const model = createUnitAssistancePresentationModel(
      coordinator,
      units[2]!.id,
      configuration(),
    );

    expect(model.recent.map((item) => item.sourceText)).toEqual([
      "B.",
      "A.",
      "D.",
    ]);
  });

  it("preserves multiline Native Intent exactly", async () => {
    const { coordinator, provider, units } = harness("Draft lines\ncontinue");
    const nativeIntent = "第一行\n\n第二行";
    await completeUnit(
      coordinator,
      provider,
      units[0]!.id,
      "multiline-intent",
      { nativeIntent },
    );

    const model = createUnitAssistancePresentationModel(
      coordinator,
      units[0]!.id,
      configuration(),
    );

    expect(model.active?.nativeIntentTracks[0]?.text).toBe(nativeIntent);
  });

  it("preserves multiline Normalized variants exactly and in order", async () => {
    const { coordinator, provider, units } = harness("Draft lines\ncontinue");
    const normalized = ["First\n\nSecond", "Alternative\nline"];
    await completeUnit(
      coordinator,
      provider,
      units[0]!.id,
      "multiline-normalized",
      { normalized },
    );

    const model = createUnitAssistancePresentationModel(
      coordinator,
      units[0]!.id,
      configuration(),
    );

    expect(model.active?.normalizedTracks.map((track) => track.text)).toEqual(
      normalized,
    );
  });

  it("does not expose results after the current context changes", async () => {
    const { coordinator, provider, units } = harness("One. Two.");
    await completeUnit(coordinator, provider, units[0]!.id, "one");
    const changedContext = selection("One. Two.", "Different outer context");
    coordinator.synchronize(
      changedContext,
      segmenter.segment(changedContext.activeText),
    );

    const model = createUnitAssistancePresentationModel(
      coordinator,
      units[1]!.id,
      configuration(),
    );

    expect(model.recent).toEqual([]);
  });

  it("removes dependency-stale output immediately after a profile change", async () => {
    const { coordinator, provider, units } = harness("One. Two.");
    await completeUnit(coordinator, provider, units[0]!.id, "profile-one");
    expect(
      createUnitAssistancePresentationModel(
        coordinator,
        units[1]!.id,
        configuration(),
      ).recent,
    ).toHaveLength(1);

    const profileTwo = configuration("profile:two");
    coordinator.updateConfiguration(profileTwo);

    expect(
      createUnitAssistancePresentationModel(
        coordinator,
        units[1]!.id,
        profileTwo,
      ).recent,
    ).toEqual([]);
  });
});
