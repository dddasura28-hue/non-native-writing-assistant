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

  return Object.freeze({ ...state });
}
