import { describe, expect, it } from "vitest";

import {
  UnitAnalysisManager,
  createUnitAnalysisState,
  createUnitSourceFingerprint,
  createWritingUnit,
  isUnitAnalysisStateCurrent,
  markUnitAnalysisAnalyzing,
  markUnitAnalysisCompleted,
  type UnitAnalysisState,
  type WritingUnit,
} from "../src/index.js";

function unit(
  id: string,
  text = id,
  start = 0,
  order = 0,
): WritingUnit {
  const sourceText = `${" ".repeat(start)}${text}`;
  return createWritingUnit({
    id,
    sourceText,
    range: { start, end: start + text.length },
    order,
  });
}

function complete(
  manager: UnitAnalysisManager,
  writingUnit: WritingUnit,
  result: unknown = Object.freeze({ normalized: "Natural expression" }),
): UnitAnalysisState {
  const analyzing = markUnitAnalysisAnalyzing(writingUnit, 3);
  manager.setState(writingUnit.id, analyzing);
  const completed = markUnitAnalysisCompleted(
    analyzing,
    writingUnit,
    result,
  );
  manager.setState(writingUnit.id, completed);
  return manager.getState(writingUnit.id)!;
}

describe("unit source identity", () => {
  it("is deterministic for the same text and UTF-16 range", () => {
    const first = unit("unit-a", "Same text", 4);
    const second = unit("unit-a", "Same text", 4);

    expect(createUnitSourceFingerprint(first)).toBe(
      createUnitSourceFingerprint(second),
    );
  });

  it("changes when identical text moves to a different range", () => {
    const original = unit("unit-a", "Hello.", 0);
    const moved = unit("unit-a", "Hello.", 10);

    expect(createUnitSourceFingerprint(original)).not.toBe(
      createUnitSourceFingerprint(moved),
    );
  });

  it("uses UTF-16 offsets deterministically around emoji", () => {
    const writingUnit = unit("unit-a", "😀 Hello.", 2);
    const equivalent = unit("unit-a", "😀 Hello.", 2);
    const moved = unit("unit-a", "😀 Hello.", 3);

    expect("😀".length).toBe(2);
    expect(writingUnit.range).toEqual({ start: 2, end: 11 });
    expect(createUnitSourceFingerprint(writingUnit)).toBe(
      createUnitSourceFingerprint(equivalent),
    );
    expect(createUnitSourceFingerprint(writingUnit)).not.toBe(
      createUnitSourceFingerprint(moved),
    );
  });
});

describe("UnitAnalysisState", () => {
  it("stores an immutable completed result for a specific source", () => {
    const writingUnit = unit("unit-a", "Draft.");
    const analyzing = markUnitAnalysisAnalyzing(writingUnit, 3);
    const result = Object.freeze({ normalized: "Natural expression" });
    const completed = markUnitAnalysisCompleted(
      analyzing,
      writingUnit,
      result,
    );

    expect(completed).toMatchObject({
      unitId: writingUnit.id,
      status: "completed",
      sourceRevision: 3,
      sourceFingerprint: createUnitSourceFingerprint(writingUnit),
      result,
    });
    expect(Object.isFrozen(completed)).toBe(true);
    expect(completed.result).toBe(result);
  });

  it("treats a completed state as current only for matching unit source", () => {
    const original = unit("unit-a", "Original.");
    const analyzing = markUnitAnalysisAnalyzing(original, 1);
    const completed = markUnitAnalysisCompleted(analyzing, original, {
      normalized: "Original.",
    });

    expect(isUnitAnalysisStateCurrent(completed, original)).toBe(true);
    expect(
      isUnitAnalysisStateCurrent(
        completed,
        unit("unit-a", "Edited source.", 0),
      ),
    ).toBe(false);
    expect(
      isUnitAnalysisStateCurrent(completed, unit("unit-a", "Original.", 5)),
    ).toBe(false);
  });

  it("prevents obviously invalid idle and completed combinations", () => {
    expect(() =>
      createUnitAnalysisState({
        unitId: "unit-a",
        status: "idle",
        sourceRevision: 1,
        sourceFingerprint: null,
        result: null,
      }),
    ).toThrow(/idle/i);

    expect(() =>
      createUnitAnalysisState({
        unitId: "unit-a",
        status: "completed",
        sourceRevision: 1,
        sourceFingerprint: null,
        result: { normalized: "Result" },
      }),
    ).toThrow(/fingerprint/i);
  });

  it("contains no provider, model, API, or UI fields", () => {
    const writingUnit = unit("unit-a", "Draft.");
    const state = markUnitAnalysisAnalyzing(writingUnit, 1);

    expect(Object.keys(state).sort()).toEqual([
      "result",
      "sourceFingerprint",
      "sourceRevision",
      "status",
      "unitId",
    ]);
    expect(state).not.toHaveProperty("provider");
    expect(state).not.toHaveProperty("model");
    expect(state).not.toHaveProperty("apiKey");
    expect(state).not.toHaveProperty("visible");
  });
});

describe("UnitAnalysisManager", () => {
  it("creates idle state for a new unit", () => {
    const manager = new UnitAnalysisManager();

    manager.synchronize([unit("unit-a")]);

    expect(manager.getState("unit-a")).toEqual({
      unitId: "unit-a",
      status: "idle",
      sourceRevision: 0,
      sourceFingerprint: null,
      result: null,
    });
  });

  it("preserves completed state for the same ID, text, and range", () => {
    const manager = new UnitAnalysisManager();
    const original = unit("unit-a", "Same source.", 2);
    manager.synchronize([original]);
    const completed = complete(manager, original);

    manager.synchronize([unit("unit-a", "Same source.", 2)]);

    expect(manager.getState("unit-a")).toBe(completed);
  });

  it("resets to idle when the same ID has changed text", () => {
    const manager = new UnitAnalysisManager();
    const original = unit("unit-a", "Old source.");
    manager.synchronize([original]);
    const completed = complete(manager, original);

    manager.synchronize([unit("unit-a", "Edited source.")]);

    expect(manager.getState("unit-a")).toEqual({
      unitId: "unit-a",
      status: "idle",
      sourceRevision: 0,
      sourceFingerprint: null,
      result: null,
    });
    expect(manager.getState("unit-a")).not.toBe(completed);
  });

  it("resets to idle when identical text moves to a different range", () => {
    const manager = new UnitAnalysisManager();
    const original = unit("unit-a", "Hello.", 0);
    manager.synchronize([original]);
    complete(manager, original);

    manager.synchronize([unit("unit-a", "Hello.", 10)]);

    expect(manager.getState("unit-a")).toMatchObject({
      status: "idle",
      sourceRevision: 0,
      sourceFingerprint: null,
      result: null,
    });
  });

  it("removes states for missing units and adds new idle units", () => {
    const manager = new UnitAnalysisManager();
    manager.synchronize([unit("unit-a"), unit("unit-b", "B", 0, 1)]);

    manager.synchronize([unit("unit-b"), unit("unit-c", "C", 0, 1)]);

    expect(manager.getState("unit-a")).toBeNull();
    expect(manager.getState("unit-b")).not.toBeNull();
    expect(manager.getState("unit-c")?.status).toBe("idle");
  });

  it("atomically rejects duplicate unit IDs", () => {
    const manager = new UnitAnalysisManager();
    manager.synchronize([unit("existing")]);
    const existing = manager.getState("existing");

    expect(() =>
      manager.synchronize([
        unit("duplicate", "First", 0),
        unit("duplicate", "Second", 0, 1),
      ]),
    ).toThrow(/unique/i);
    expect(manager.getState("existing")).toBe(existing);
    expect(manager.getState("duplicate")).toBeNull();
  });

  it("safely replaces one known unit with immutable analyzing state", () => {
    const manager = new UnitAnalysisManager();
    const writingUnit = unit("unit-a", "Draft.");
    manager.synchronize([writingUnit]);
    const analyzing = markUnitAnalysisAnalyzing(writingUnit, 2);

    manager.setState(writingUnit.id, analyzing);

    expect(manager.getState(writingUnit.id)).toEqual(analyzing);
    expect(Object.isFrozen(manager.getState(writingUnit.id))).toBe(true);
  });

  it("stores a completed result only for its synchronized source", () => {
    const manager = new UnitAnalysisManager();
    const writingUnit = unit("unit-a", "Draft.");
    const result = Object.freeze({ normalized: "Revised draft." });
    manager.synchronize([writingUnit]);

    const completed = complete(manager, writingUnit, result);

    expect(manager.getState(writingUnit.id)?.result).toBe(result);
    expect(isUnitAnalysisStateCurrent(completed, writingUnit)).toBe(true);
  });

  it("rejects state targeted at the wrong or unknown unit ID", () => {
    const manager = new UnitAnalysisManager();
    const unitA = unit("unit-a", "A.");
    const unitB = unit("unit-b", "B.", 0, 1);
    manager.synchronize([unitA, unitB]);
    const stateForB = markUnitAnalysisAnalyzing(unitB, 1);

    expect(() => manager.setState(unitA.id, stateForB)).toThrow(/unitId/i);
    expect(() => manager.setState("unknown", stateForB)).toThrow(/unknown/i);
  });

  it("rejects an old completed state after source synchronization changes", () => {
    const manager = new UnitAnalysisManager();
    const original = unit("unit-a", "Old source.");
    manager.synchronize([original]);
    const completed = complete(manager, original);
    const edited = unit("unit-a", "New source.");

    manager.synchronize([edited]);

    expect(isUnitAnalysisStateCurrent(completed, edited)).toBe(false);
    expect(() => manager.setState(edited.id, completed)).toThrow(/source/i);
    expect(manager.getState(edited.id)?.status).toBe("idle");
  });
});
