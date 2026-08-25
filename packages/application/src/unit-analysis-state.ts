import {
  createUnitSourceFingerprint,
  type UnitSourceFingerprint,
} from "./unit-source-fingerprint.js";
import type { WritingUnit } from "./writing-unit.js";

export const UNIT_ANALYSIS_STATUSES = Object.freeze([
  "idle",
  "analyzing",
  "completed",
  "stale",
  "failed",
] as const);

export type UnitAnalysisStatus = (typeof UNIT_ANALYSIS_STATUSES)[number];

/** Application lifecycle state for one addressable writing unit. */
export interface UnitAnalysisState {
  readonly unitId: string;
  readonly status: UnitAnalysisStatus;
  readonly sourceRevision: number;
  /** Null only when idle and no source has yet been analyzed. */
  readonly sourceFingerprint: UnitSourceFingerprint | null;
  /** Opaque analysis output, or null when no result is stored. */
  readonly result: unknown | null;
}

export function createUnitAnalysisState(
  state: UnitAnalysisState,
): UnitAnalysisState {
  if (state.unitId.trim().length === 0) {
    throw new TypeError("UnitAnalysisState unitId must not be empty.");
  }
  if (!UNIT_ANALYSIS_STATUSES.includes(state.status)) {
    throw new TypeError("UnitAnalysisState status is not supported.");
  }
  if (!Number.isSafeInteger(state.sourceRevision) || state.sourceRevision < 0) {
    throw new RangeError(
      "UnitAnalysisState sourceRevision must be a non-negative integer.",
    );
  }
  if (state.result === undefined) {
    throw new TypeError("UnitAnalysisState result must be a value or null.");
  }

  if (state.status === "idle") {
    if (
      state.sourceRevision !== 0 ||
      state.sourceFingerprint !== null ||
      state.result !== null
    ) {
      throw new TypeError(
        "An idle UnitAnalysisState must not retain analyzed source or result data.",
      );
    }
  } else if (state.sourceFingerprint === null) {
    throw new TypeError(
      "A non-idle UnitAnalysisState requires a source fingerprint.",
    );
  }

  if (state.status === "analyzing" && state.result !== null) {
    throw new TypeError(
      "An analyzing UnitAnalysisState must not contain a result.",
    );
  }

  if (state.status === "completed" && state.result === null) {
    throw new TypeError("A completed UnitAnalysisState requires a result.");
  }

  return Object.freeze({ ...state });
}

export function createIdleUnitAnalysisState(
  unitId: string,
): UnitAnalysisState {
  return createUnitAnalysisState({
    unitId,
    status: "idle",
    sourceRevision: 0,
    sourceFingerprint: null,
    result: null,
  });
}

export function markUnitAnalysisAnalyzing(
  unit: WritingUnit,
  sourceRevision: number,
): UnitAnalysisState {
  return createUnitAnalysisState({
    unitId: unit.id,
    status: "analyzing",
    sourceRevision,
    sourceFingerprint: createUnitSourceFingerprint(unit),
    result: null,
  });
}

export function markUnitAnalysisCompleted(
  state: UnitAnalysisState,
  unit: WritingUnit,
  result: unknown,
): UnitAnalysisState {
  if (state.status !== "analyzing") {
    throw new TypeError("Only an analyzing UnitAnalysisState can complete.");
  }
  if (state.unitId !== unit.id) {
    throw new TypeError("UnitAnalysisState must complete for the same unit ID.");
  }

  const sourceFingerprint = createUnitSourceFingerprint(unit);
  if (state.sourceFingerprint !== sourceFingerprint) {
    throw new TypeError(
      "UnitAnalysisState cannot complete for a different unit source.",
    );
  }
  if (result === null || result === undefined) {
    throw new TypeError("A completed UnitAnalysisState requires a result.");
  }

  return createUnitAnalysisState({
    ...state,
    status: "completed",
    result,
  });
}

/** True only when a completed result belongs to this exact unit source. */
export function isUnitAnalysisStateCurrent(
  state: UnitAnalysisState,
  unit: WritingUnit,
): boolean {
  return (
    state.status === "completed" &&
    state.unitId === unit.id &&
    state.sourceFingerprint === createUnitSourceFingerprint(unit)
  );
}
