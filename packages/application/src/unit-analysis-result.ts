import {
  createDependencyStamp,
  type DependencyStamp,
} from "@non-native-writing/core";

export interface UnitNormalizedResult {
  readonly text: string;
  readonly label: string | null;
}

/** Provider-neutral generated content for one WritingUnit analysis. */
export interface UnitAnalysisResult {
  readonly nativeIntent: string | null;
  readonly normalized: readonly UnitNormalizedResult[];
  /** The complete snapshot dependency stamp used for the producing run. */
  readonly dependencyStamp: DependencyStamp;
}

export function createUnitAnalysisResult(
  result: UnitAnalysisResult,
): UnitAnalysisResult {
  if (
    result.nativeIntent !== null &&
    result.nativeIntent.length === 0
  ) {
    throw new TypeError("Unit native intent must be non-empty or null.");
  }

  const normalized = result.normalized.map((item) => {
    if (item.text.length === 0) {
      throw new TypeError("Unit normalized text must not be empty.");
    }
    if (item.label !== null && item.label.length === 0) {
      throw new TypeError("Unit normalized labels must be non-empty or null.");
    }
    return Object.freeze({ ...item });
  });

  return Object.freeze({
    nativeIntent: result.nativeIntent,
    normalized: Object.freeze(normalized),
    dependencyStamp: createDependencyStamp(result.dependencyStamp),
  });
}
