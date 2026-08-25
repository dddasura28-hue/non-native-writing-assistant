import {
  createUnitAnalysisState,
  type UnitAnalysisState,
} from "./unit-analysis-state.js";
import type { WritingUnit } from "./writing-unit.js";

/**
 * Synchronizes lifecycle states by ephemeral WritingUnit ID. This manager is
 * scoped to one selection analysis and performs no matching across edits.
 */
export class UnitAnalysisManager {
  #states = new Map<string, UnitAnalysisState>();

  synchronize(units: readonly WritingUnit[]): void {
    assertUniqueUnitIds(units);

    const synchronized = new Map<string, UnitAnalysisState>();
    for (const unit of units) {
      synchronized.set(
        unit.id,
        this.#states.get(unit.id) ??
          createUnitAnalysisState({
            unitId: unit.id,
            status: "idle",
            sourceRevision: 0,
            result: null,
          }),
      );
    }

    this.#states = synchronized;
  }

  getState(unitId: string): UnitAnalysisState | null {
    return this.#states.get(unitId) ?? null;
  }
}

function assertUniqueUnitIds(units: readonly WritingUnit[]): void {
  const seen = new Set<string>();
  for (const unit of units) {
    if (seen.has(unit.id)) {
      throw new TypeError("WritingUnit IDs must be unique when synchronized.");
    }
    seen.add(unit.id);
  }
}
