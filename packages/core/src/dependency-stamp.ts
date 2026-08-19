export interface DependencyStamp {
  readonly sourceRevision: number;
  readonly confirmedNativeIntentRevision?: number;
  readonly assistPolicyFingerprint: string;
  readonly styleProfileFingerprint: string;
  readonly languageConfigurationFingerprint: string;
  readonly processorConfigurationFingerprint: string;
}

function assertRevision(value: number, fieldName: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${fieldName} must be a non-negative integer.`);
  }
}

export function createDependencyStamp(
  stamp: DependencyStamp,
): DependencyStamp {
  assertRevision(stamp.sourceRevision, "sourceRevision");

  if (stamp.confirmedNativeIntentRevision !== undefined) {
    assertRevision(
      stamp.confirmedNativeIntentRevision,
      "confirmedNativeIntentRevision",
    );
  }

  return Object.freeze({ ...stamp });
}

/** A result is current exactly when this comparison succeeds. */
export function dependencyStampMatches(
  resultStamp: DependencyStamp,
  currentStamp: DependencyStamp,
): boolean {
  return (
    resultStamp.sourceRevision === currentStamp.sourceRevision &&
    resultStamp.confirmedNativeIntentRevision ===
      currentStamp.confirmedNativeIntentRevision &&
    resultStamp.assistPolicyFingerprint ===
      currentStamp.assistPolicyFingerprint &&
    resultStamp.styleProfileFingerprint ===
      currentStamp.styleProfileFingerprint &&
    resultStamp.languageConfigurationFingerprint ===
      currentStamp.languageConfigurationFingerprint &&
    resultStamp.processorConfigurationFingerprint ===
      currentStamp.processorConfigurationFingerprint
  );
}
