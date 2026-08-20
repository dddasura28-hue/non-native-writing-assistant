import type { ContextSelection } from "./context-selector.js";

export interface AnalysisContext {
  readonly beforeContext: string;
  readonly afterContext: string;
  readonly contextFingerprint: string;
}

export function createAnalysisContext(
  selection: ContextSelection,
): AnalysisContext {
  return createAnalysisContextValue(
    selection.sourceRange.start,
    selection.sourceRange.end,
    selection.beforeContext,
    selection.afterContext,
  );
}

export function createWholeAvailableAnalysisContext(
  sourceText: string,
): AnalysisContext {
  return createAnalysisContextValue(0, sourceText.length, "", "");
}

export function copyAnalysisContext(context: AnalysisContext): AnalysisContext {
  return Object.freeze({ ...context });
}

function createAnalysisContextValue(
  sourceStart: number,
  sourceEnd: number,
  beforeContext: string,
  afterContext: string,
): AnalysisContext {
  const fingerprintInput = JSON.stringify([
    sourceStart,
    sourceEnd,
    beforeContext,
    afterContext,
  ]);

  return Object.freeze({
    beforeContext,
    afterContext,
    contextFingerprint: nonSecurityFingerprint(fingerprintInput),
  });
}

/** Deterministic change detection only; this is not a security hash. */
function nonSecurityFingerprint(value: string): string {
  let hash = 14_695_981_039_346_656_037n;
  const prime = 1_099_511_628_211n;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * prime);
  }

  return `context:v1:${value.length}:${hash.toString(16).padStart(16, "0")}`;
}
