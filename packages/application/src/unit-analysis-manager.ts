import {
  createIdleUnitAnalysisState,
  createUnitAnalysisState,
  type UnitAnalysisState,
} from "./unit-analysis-state.js";
import {
  createUnitSourceFingerprint,
  type UnitSourceFingerprint,
} from "./unit-source-fingerprint.js";
import type { WritingUnit } from "./writing-unit.js";

/**
 * Synchronizes lifecycle states by ephemeral WritingUnit ID. This manager is
 * scoped to one selection analysis and performs no matching across edits.
 */
export class UnitAnalysisManager {
  #states = new Map<string, UnitAnalysisState>();
  #sourceFingerprints = new Map<string, UnitSourceFingerprint>();

  synchronize(units: readonly WritingUnit[]): void {
    assertUniqueUnitIds(units);

    const synchronized = new Map<string, UnitAnalysisState>();
    const sourceFingerprints = new Map<string, UnitSourceFingerprint>();
    for (const unit of units) {
      const sourceFingerprint = createUnitSourceFingerprint(unit);
      const existingState = this.#states.get(unit.id);
      const existingSourceFingerprint = this.#sourceFingerprints.get(unit.id);

      sourceFingerprints.set(unit.id, sourceFingerprint);
      synchronized.set(
        unit.id,
        existingState !== undefined &&
          existingSourceFingerprint === sourceFingerprint
          ? existingState
          : createIdleUnitAnalysisState(unit.id),
      );
    }

    this.#states = synchronized;
    this.#sourceFingerprints = sourceFingerprints;
  }

  getState(unitId: string): UnitAnalysisState | null {
    return this.#states.get(unitId) ?? null;
  }

  setState(unitId: string, state: UnitAnalysisState): void {
    const currentSourceFingerprint = this.#sourceFingerprints.get(unitId);
    if (currentSourceFingerprint === undefined) {
      throw new TypeError("Cannot set state for an unknown WritingUnit ID.");
    }
    if (state.unitId !== unitId) {
      throw new TypeError("UnitAnalysisState unitId must match the target ID.");
    }

    const replacement = createUnitAnalysisState(state);
    if (
      replacement.sourceFingerprint !== null &&
      replacement.sourceFingerprint !== currentSourceFingerprint
    ) {
      throw new TypeError(
        "UnitAnalysisState source must match the synchronized WritingUnit.",
      );
    }

    this.#states.set(unitId, replacement);
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
