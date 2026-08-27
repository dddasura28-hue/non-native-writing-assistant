import {
  NATIVE_INTENT_TRACK_TYPE_ID,
  NORMALIZED_TRACK_TYPE_ID,
  asTrackId,
  dependencyStampMatches,
} from "@non-native-writing/core";
import { describe, expect, it } from "vitest";

import {
  IncrementalUnitAnalysisCoordinator,
  SimpleWritingUnitSegmenter,
  createUnitSourceFingerprint,
  createWritingUnitAnalysisContext,
  mapWritingUnitToSourceRange,
  selectCurrentWritingUnit,
  type AnalysisConfiguration,
  type AnalysisOutcome,
  type AnalysisProposal,
  type ContextSelection,
} from "../src/index.js";
import { AnalysisCoordinator } from "../src/analysis-coordinator.js";
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
  options: {
    readonly start?: number;
    readonly beforeContext?: string;
    readonly afterContext?: string;
  } = {},
): ContextSelection {
  const start = options.start ?? 0;
  return Object.freeze({
    activeText,
    sourceRange: Object.freeze({ start, end: start + activeText.length }),
    beforeContext: options.beforeContext ?? "",
    afterContext: options.afterContext ?? "",
  });
}

function proposalFor(
  request: PendingAnalysisRequest,
  suffix: string,
): AnalysisProposal {
  return Object.freeze({
    outputs: Object.freeze([
      Object.freeze({
        id: asTrackId(`intent-${suffix}`),
        typeId: NATIVE_INTENT_TRACK_TYPE_ID,
        text: `Intent ${suffix}`,
        provenance: "model" as const,
        dependencyStamp: request.snapshot.dependencyStamp,
      }),
      Object.freeze({
        id: asTrackId(`normalized-${suffix}`),
        typeId: NORMALIZED_TRACK_TYPE_ID,
        text: `Normalized ${suffix}`,
        provenance: "model" as const,
        dependencyStamp: request.snapshot.dependencyStamp,
        label: `Variant ${suffix}`,
        order: 1,
      }),
    ]),
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
  return { provider, coordinator, selection: contextSelection, units };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function resolveRequest(
  provider: MockAnalysisProvider,
  index: number,
  suffix: string,
): Promise<void> {
  const request = provider.request(index);
  request.resolve(proposalFor(request, suffix));
  await flushMicrotasks();
}

async function completeUnit(
  coordinator: IncrementalUnitAnalysisCoordinator,
  provider: MockAnalysisProvider,
  unitId: string,
  suffix: string,
  config = configuration(),
): Promise<AnalysisOutcome> {
  const requestIndex = provider.requests.length;
  const outcome = coordinator.analyze(unitId, config);
  expect(provider.requests).toHaveLength(requestIndex + 1);
  await resolveRequest(provider, requestIndex, suffix);
  return outcome;
}

async function completeAllUnits(
  coordinator: IncrementalUnitAnalysisCoordinator,
  provider: MockAnalysisProvider,
  unitIds: readonly string[],
  config = configuration(),
): Promise<void> {
  for (const [index, unitId] of unitIds.entries()) {
    await expect(
      completeUnit(coordinator, provider, unitId, `${index + 1}`, config),
    ).resolves.toMatchObject({ status: "applied" });
  }
}

describe("IncrementalUnitAnalysisCoordinator", () => {
  it("keeps an unchanged unit current when its exact context and configuration match", async () => {
    const { coordinator, provider, selection: initial, units } = harness("Draft.");
    await completeUnit(coordinator, provider, units[0]!.id, "initial");

    coordinator.synchronize(initial, segmenter.segment(initial.activeText));

    expect(coordinator.getRecord(units[0]!.id)?.state.status).toBe("completed");
    expect(coordinator.getCurrentResult(units[0]!.id, configuration())).not.toBeNull();
    const requestCount = provider.requests.length;
    await expect(
      coordinator.analyze(units[0]!.id, configuration()),
    ).resolves.toEqual({ status: "applied", appliedTrackIds: [] });
    expect(provider.requests).toHaveLength(requestCount);
  });

  it("marks an unchanged unit stale when exact beforeContext changes", async () => {
    const { coordinator, provider, units } = harness("Draft.");
    await completeUnit(coordinator, provider, units[0]!.id, "before-old");

    const changed = selection("Draft.", { beforeContext: "New premise." });
    coordinator.synchronize(changed, segmenter.segment(changed.activeText));

    const state = coordinator.getRecord(units[0]!.id)?.state;
    expect(state?.status).toBe("stale");
    expect(state?.result).not.toBeNull();
    expect(coordinator.getCurrentResult(units[0]!.id, configuration())).toBeNull();
    expect(coordinator.getCurrentTrackIds(units[0]!.id, configuration())).toEqual([]);
    expect(provider.requests).toHaveLength(1);
  });

  it("marks an unchanged unit stale when exact afterContext changes", async () => {
    const { coordinator, provider, units } = harness("Draft.");
    await completeUnit(coordinator, provider, units[0]!.id, "after-old");

    const changed = selection("Draft.", { afterContext: "New consequence." });
    coordinator.synchronize(changed, segmenter.segment(changed.activeText));

    expect(coordinator.getRecord(units[0]!.id)?.state.status).toBe("stale");
    expect(coordinator.getCurrentResult(units[0]!.id, configuration())).toBeNull();
    expect(provider.requests).toHaveLength(1);
  });

  it("discards an old result and resets to idle when unit source changes", async () => {
    const { coordinator, provider, units } = harness("Old.");
    await completeUnit(coordinator, provider, units[0]!.id, "old");

    const edited = selection("New.");
    coordinator.synchronize(edited, segmenter.segment(edited.activeText));

    expect(coordinator.getRecord(units[0]!.id)?.state).toMatchObject({
      status: "idle",
      result: null,
      sourceFingerprint: null,
    });
  });

  it("preserves earlier causal siblings and analyzes only the active future edit", async () => {
    const { coordinator, provider, units } = harness("A. B. C.");
    await completeAllUnits(coordinator, provider, units.map((unit) => unit.id));

    const edited = selection("A. B. Changed C!");
    const editedUnits = segmenter.segment(edited.activeText);
    coordinator.synchronize(edited, editedUnits);

    expect(coordinator.getRecord("writing-unit:0")?.state.status).toBe("completed");
    expect(coordinator.getRecord("writing-unit:1")?.state.status).toBe("completed");
    expect(coordinator.getRecord("writing-unit:2")?.state.status).toBe("idle");
    expect(provider.requests).toHaveLength(3);

    const activeOutcome = coordinator.analyze("writing-unit:2", configuration());
    expect(provider.requests).toHaveLength(4);
    expect(provider.request(3).snapshot.sourceText).toBe("Changed C!");
    await resolveRequest(provider, 3, "changed-c");
    await expect(activeOutcome).resolves.toMatchObject({ status: "applied" });

    expect(coordinator.getRecord("writing-unit:0")?.state.status).toBe("completed");
    expect(coordinator.getRecord("writing-unit:1")?.state.status).toBe("completed");
    expect(coordinator.getRecord("writing-unit:2")?.state.status).toBe("completed");
    expect(provider.requests).toHaveLength(4);

    await expect(
      coordinator.analyze("writing-unit:1", configuration()),
    ).resolves.toEqual({ status: "applied", appliedTrackIds: [] });
    expect(provider.requests).toHaveLength(4);
  });

  it("invalidates later units when their causal beforeContext changes", async () => {
    const { coordinator, provider, units } = harness("A. B. C.");
    await completeAllUnits(coordinator, provider, units.map((unit) => unit.id));

    const edited = selection("X. B. C.");
    coordinator.synchronize(edited, segmenter.segment(edited.activeText));

    expect(coordinator.getRecord("writing-unit:0")?.state.status).toBe("idle");
    expect(coordinator.getRecord("writing-unit:1")?.state.status).toBe("stale");
    expect(coordinator.getRecord("writing-unit:2")?.state.status).toBe("stale");
    expect(provider.requests).toHaveLength(3);
  });

  it("retains hidden stale data while reanalyzing and replaces its DependencyStamp", async () => {
    const { coordinator, provider, units } = harness("Draft.");
    await completeUnit(coordinator, provider, units[0]!.id, "old");
    const oldStamp = coordinator.getRecord(units[0]!.id)!.state.result!.dependencyStamp;

    const changed = selection("Draft.", { beforeContext: "Changed." });
    coordinator.synchronize(changed, segmenter.segment(changed.activeText));
    const outcome = coordinator.analyze(units[0]!.id, configuration());

    expect(coordinator.getRecord(units[0]!.id)?.state).toMatchObject({
      status: "analyzing",
      result: { nativeIntent: "Intent old" },
    });
    expect(coordinator.getCurrentResult(units[0]!.id, configuration())).toBeNull();
    const newStamp = provider.request(1).snapshot.dependencyStamp;
    expect(dependencyStampMatches(oldStamp, newStamp)).toBe(false);

    await resolveRequest(provider, 1, "new");
    await outcome;
    const completed = coordinator.getRecord(units[0]!.id)!.state;
    expect(completed.status).toBe("completed");
    expect(completed.result?.nativeIntent).toBe("Intent new");
    expect(completed.result?.dependencyStamp).toEqual(newStamp);
  });

  it("marks all affected cached units stale on profile change but refreshes only the chosen active unit", async () => {
    const { coordinator, provider, units } = harness("One. Two. Three.");
    await completeAllUnits(coordinator, provider, units.map((unit) => unit.id));

    const profileTwo = configuration("provider:two");
    coordinator.updateConfiguration(profileTwo);
    expect(coordinator.listRecords().map((record) => record.state.status)).toEqual([
      "stale",
      "stale",
      "stale",
    ]);
    expect(provider.requests).toHaveLength(3);

    await completeUnit(coordinator, provider, units[2]!.id, "profile-two-c", profileTwo);
    expect(provider.requests).toHaveLength(4);
    expect(coordinator.listRecords().map((record) => record.state.status)).toEqual([
      "stale",
      "stale",
      "completed",
    ]);

    await completeUnit(coordinator, provider, units[0]!.id, "profile-two-a", profileTwo);
    expect(provider.requests).toHaveLength(5);
    expect(coordinator.getRecord(units[0]!.id)?.state.status).toBe("completed");
    expect(coordinator.getRecord(units[1]!.id)?.state.status).toBe("stale");
  });

  it("requires both source identity and the complete DependencyStamp for currentness", async () => {
    const { coordinator, provider, units } = harness("Draft.");
    await completeUnit(coordinator, provider, units[0]!.id, "current");

    const current = coordinator.getRecord(units[0]!.id)!.state.result!.dependencyStamp;
    expect(coordinator.getCurrentResult(units[0]!.id, configuration())).not.toBeNull();

    const moved = selection("Draft.", { start: 10 });
    coordinator.synchronize(moved, segmenter.segment(moved.activeText));
    const movedState = coordinator.getRecord(units[0]!.id)!.state;
    expect(movedState.sourceFingerprint).toBe(createUnitSourceFingerprint(units[0]!));
    expect(movedState.result?.dependencyStamp).toEqual(current);
    expect(movedState.status).toBe("stale");
    expect(coordinator.getCurrentResult(units[0]!.id, configuration())).toBeNull();
  });

  it("rejects a late result after the active unit changes source", async () => {
    const { coordinator, provider, units } = harness("Old.");
    const oldOutcome = coordinator.analyze(units[0]!.id, configuration());
    const oldRequest = provider.request(0);

    const edited = selection("New.");
    coordinator.synchronize(edited, segmenter.segment(edited.activeText));
    expect(oldRequest.signal.aborted).toBe(true);
    oldRequest.resolve(proposalFor(oldRequest, "late"));

    await expect(oldOutcome).resolves.toEqual({ status: "stale" });
    expect(coordinator.getRecord(units[0]!.id)?.state.status).toBe("idle");
    expect(coordinator.getCurrentResult(units[0]!.id, configuration())).toBeNull();
  });

  it("keeps a valid completed-unit request running while queuing the next unit", async () => {
    const { coordinator, provider, units } = harness("A.");
    const first = coordinator.analyze(
      units[0]!.id,
      configuration(),
      "completion",
    );

    const expanded = selection("A. B.");
    const expandedUnits = segmenter.segment(expanded.activeText);
    coordinator.synchronize(expanded, expandedUnits);
    const second = coordinator.analyze(
      expandedUnits[1]!.id,
      configuration(),
      "completion",
    );

    expect(provider.requests).toHaveLength(1);
    expect(provider.request(0).signal.aborted).toBe(false);
    await resolveRequest(provider, 0, "a");
    expect(provider.requests).toHaveLength(2);
    expect(provider.request(1).snapshot.sourceText).toBe("B.");
    await resolveRequest(provider, 1, "b");

    await expect(first).resolves.toMatchObject({ status: "applied" });
    await expect(second).resolves.toMatchObject({ status: "applied" });
    expect(coordinator.getRecord(expandedUnits[0]!.id)?.state.status).toBe(
      "completed",
    );
  });

  it("processes rapid completed units sequentially without provider fan-out", async () => {
    const { coordinator, provider, units } = harness("A.");
    const first = coordinator.analyze(
      units[0]!.id,
      configuration(),
      "completion",
    );

    const two = selection("A. B.");
    const twoUnits = segmenter.segment(two.activeText);
    coordinator.synchronize(two, twoUnits);
    const second = coordinator.analyze(
      twoUnits[1]!.id,
      configuration(),
      "completion",
    );

    const three = selection("A. B. C.");
    const threeUnits = segmenter.segment(three.activeText);
    coordinator.synchronize(three, threeUnits);
    const third = coordinator.analyze(
      threeUnits[2]!.id,
      configuration(),
      "completion",
    );

    expect(provider.requests.map((request) => request.snapshot.sourceText)).toEqual([
      "A.",
    ]);
    await resolveRequest(provider, 0, "rapid-a");
    expect(provider.requests.map((request) => request.snapshot.sourceText)).toEqual([
      "A.",
      "B.",
    ]);
    await resolveRequest(provider, 1, "rapid-b");
    expect(provider.requests.map((request) => request.snapshot.sourceText)).toEqual([
      "A.",
      "B.",
      "C.",
    ]);
    await resolveRequest(provider, 2, "rapid-c");

    await Promise.all([first, second, third]);
  });

  it("drops a queued unit whose source becomes obsolete", async () => {
    const { coordinator, provider, units } = harness("A.");
    const first = coordinator.analyze(
      units[0]!.id,
      configuration(),
      "completion",
    );
    const expanded = selection("A. B.");
    const expandedUnits = segmenter.segment(expanded.activeText);
    coordinator.synchronize(expanded, expandedUnits);
    const obsolete = coordinator.analyze(
      expandedUnits[1]!.id,
      configuration(),
      "completion",
    );

    const edited = selection("A. Changed B.");
    coordinator.synchronize(edited, segmenter.segment(edited.activeText));
    await expect(obsolete).resolves.toEqual({ status: "stale" });

    await resolveRequest(provider, 0, "only-a");
    await first;
    expect(provider.requests).toHaveLength(1);
  });

  it("deduplicates equivalent completion requests", async () => {
    const { coordinator, provider, units } = harness("Done.");
    const first = coordinator.analyze(
      units[0]!.id,
      configuration(),
      "completion",
    );
    const duplicate = coordinator.analyze(
      units[0]!.id,
      configuration(),
      "completion",
    );

    expect(provider.requests).toHaveLength(1);
    await resolveRequest(provider, 0, "deduplicated");
    await expect(first).resolves.toMatchObject({ status: "applied" });
    await expect(duplicate).resolves.toMatchObject({ status: "applied" });
    expect(provider.requests).toHaveLength(1);
  });

  it("keeps sibling states isolated when the active unit fails", async () => {
    const { coordinator, provider, units } = harness("One. Two. Three.");
    await completeUnit(coordinator, provider, units[0]!.id, "one");

    const outcome = coordinator.analyze(units[1]!.id, configuration());
    const failure = new Error("Provider failed safely");
    provider.request(1).reject(failure);
    await flushMicrotasks();

    await expect(outcome).resolves.toEqual({ status: "failed", error: failure });
    expect(coordinator.getRecord(units[0]!.id)?.state.status).toBe("completed");
    expect(coordinator.getRecord(units[1]!.id)?.state.status).toBe("failed");
    expect(coordinator.getRecord(units[2]!.id)?.state.status).toBe("idle");
    expect(provider.requests).toHaveLength(2);
  });

  it("keeps provider secrets out of state and deterministic fingerprints", async () => {
    const fakeSecret = "fake-secret-must-not-enter-unit-state";
    const { coordinator, provider, units } = harness("Draft.");
    await completeUnit(coordinator, provider, units[0]!.id, "safe");

    expect(JSON.stringify(coordinator.getRecord(units[0]!.id)?.state)).not.toContain(
      fakeSecret,
    );
    expect(createUnitSourceFingerprint(units[0]!)).not.toContain(fakeSecret);
    expect(JSON.stringify(provider.request(0).snapshot.dependencyStamp)).not.toContain(
      fakeSecret,
    );
  });
});

describe("WritingUnit context and target helpers", () => {
  const contextSelection = selection("First. Second. Third.", {
    start: 10,
    beforeContext: "Outer before",
    afterContext: "Outer after",
  });
  const units = segmenter.segment(contextSelection.activeText);

  it("builds causal same-block beforeContext and retains outer afterContext", () => {
    const second = units[1]!;
    const context = createWritingUnitAnalysisContext(contextSelection, second);

    expect(context.beforeContext).toBe("Outer before\n\nFirst. ");
    expect(context.afterContext).toBe("Outer after");
    expect(context.beforeContext).not.toContain(second.text);
    expect(context.afterContext).not.toContain(second.text);
  });

  it("does not change an earlier fingerprint for later same-block edits", () => {
    const initial = selection("A. B. C.");
    const edited = selection("A. B. Changed C!");
    const initialUnits = segmenter.segment(initial.activeText);
    const editedUnits = segmenter.segment(edited.activeText);

    expect(
      createWritingUnitAnalysisContext(initial, initialUnits[1]!).contextFingerprint,
    ).toBe(
      createWritingUnitAnalysisContext(edited, editedUnits[1]!).contextFingerprint,
    );
  });

  it("changes a later fingerprint when earlier same-block context changes", () => {
    const initial = selection("A. B. C.");
    const edited = selection("X. B. C.");
    const initialUnits = segmenter.segment(initial.activeText);
    const editedUnits = segmenter.segment(edited.activeText);

    expect(
      createWritingUnitAnalysisContext(initial, initialUnits[1]!).contextFingerprint,
    ).not.toBe(
      createWritingUnitAnalysisContext(edited, editedUnits[1]!).contextFingerprint,
    );
  });

  it("maps unit-relative UTF-16 ranges to absolute source ranges", () => {
    const emojiSelection = selection("😀 Hi. Next?", { start: 20 });
    const emojiUnits = segmenter.segment(emojiSelection.activeText);

    expect(emojiUnits[0]?.range).toEqual({ start: 0, end: 6 });
    expect(emojiUnits[1]?.range).toEqual({ start: 7, end: 12 });
    expect(mapWritingUnitToSourceRange(emojiSelection, emojiUnits[1]!)).toEqual({
      start: 27,
      end: 32,
    });
    expect(
      emojiSelection.activeText.slice(
        emojiUnits[1]!.range.start,
        emojiUnits[1]!.range.end,
      ),
    ).toBe(emojiUnits[1]!.text);
  });

  it("selects cursor targets deterministically at unit boundaries", () => {
    expect(selectCurrentWritingUnit(units, 1)?.text).toBe("First.");
    expect(selectCurrentWritingUnit(units, units[0]!.range.end)?.text).toBe(
      "First.",
    );
    expect(selectCurrentWritingUnit(units, units[1]!.range.start)?.text).toBe(
      "Second.",
    );
    expect(
      selectCurrentWritingUnit(units, contextSelection.activeText.length)?.text,
    ).toBe("Third.");
  });

  it("selects an unfinished final unit at its end", () => {
    const unfinished = segmenter.segment("Done. I think this policy is");

    expect(
      selectCurrentWritingUnit(
        unfinished,
        "Done. I think this policy is".length,
      )?.text,
    ).toBe("I think this policy is");
  });
});
