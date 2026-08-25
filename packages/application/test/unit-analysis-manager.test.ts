import { describe, expect, it } from "vitest";

import {
  UnitAnalysisManager,
  createUnitAnalysisState,
  createWritingUnit,
  type WritingUnit,
} from "../src/index.js";

function unit(id: string, text = id, order = 0): WritingUnit {
  return createWritingUnit({
    id,
    sourceText: text,
    range: { start: 0, end: text.length },
    order,
  });
}

describe("UnitAnalysisState", () => {
  it("stores an analysis result without interpreting it", () => {
    const result = Object.freeze({ normalized: "Natural expression" });
    const state = createUnitAnalysisState({
      unitId: "unit-a",
      status: "completed",
      sourceRevision: 3,
      result,
    });

    expect(state).toEqual({
      unitId: "unit-a",
      status: "completed",
      sourceRevision: 3,
      result,
    });
    expect(state.result).toBe(result);
  });

  it("is immutable", () => {
    const state = createUnitAnalysisState({
      unitId: "unit-a",
      status: "analyzing",
      sourceRevision: 2,
      result: null,
    });

    expect(Object.isFrozen(state)).toBe(true);
  });
});

describe("UnitAnalysisManager", () => {
  it("gives a new unit immutable idle state by default", () => {
    const manager = new UnitAnalysisManager();

    manager.synchronize([unit("unit-a")]);

    const state = manager.getState("unit-a");
    expect(state).toEqual({
      unitId: "unit-a",
      status: "idle",
      sourceRevision: 0,
      result: null,
    });
    expect(Object.isFrozen(state)).toBe(true);
  });

  it("creates a state for every synchronized unit", () => {
    const manager = new UnitAnalysisManager();

    manager.synchronize([
      unit("unit-a", "First.", 0),
      unit("unit-b", "Second.", 1),
    ]);

    expect(manager.getState("unit-a")?.status).toBe("idle");
    expect(manager.getState("unit-b")?.status).toBe("idle");
  });

  it("preserves the existing state for a retained unit ID", () => {
    const manager = new UnitAnalysisManager();
    manager.synchronize([unit("unit-a")]);
    const original = manager.getState("unit-a");

    manager.synchronize([unit("unit-a")]);

    expect(manager.getState("unit-a")).toBe(original);
  });

  it("removes states for missing units", () => {
    const manager = new UnitAnalysisManager();
    manager.synchronize([unit("unit-a"), unit("unit-b", "B", 1)]);

    manager.synchronize([unit("unit-b")]);

    expect(manager.getState("unit-a")).toBeNull();
    expect(manager.getState("unit-b")).not.toBeNull();
  });

  it("adds idle state for a newly introduced unit", () => {
    const manager = new UnitAnalysisManager();
    manager.synchronize([unit("unit-a")]);

    manager.synchronize([
      unit("unit-a"),
      unit("unit-b", "New unit", 1),
    ]);

    expect(manager.getState("unit-b")).toMatchObject({
      status: "idle",
      sourceRevision: 0,
      result: null,
    });
  });

  it("rejects duplicate unit IDs without changing existing states", () => {
    const manager = new UnitAnalysisManager();
    manager.synchronize([unit("existing")]);
    const existing = manager.getState("existing");

    expect(() =>
      manager.synchronize([
        unit("duplicate", "First", 0),
        unit("duplicate", "Second", 1),
      ]),
    ).toThrow(/unique/i);
    expect(manager.getState("existing")).toBe(existing);
    expect(manager.getState("duplicate")).toBeNull();
  });
});
