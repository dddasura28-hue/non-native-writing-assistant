import type { WritingUnit } from "./writing-unit.js";

declare const unitSourceFingerprintBrand: unique symbol;

export type UnitSourceFingerprint = string & {
  readonly [unitSourceFingerprintBrand]: true;
};

/**
 * Deterministic change detection over exact unit text and its UTF-16 range.
 * This compact fingerprint is not a cryptographic or security boundary.
 */
export function createUnitSourceFingerprint(
  unit: WritingUnit,
): UnitSourceFingerprint {
  const input = JSON.stringify([unit.range.start, unit.range.end, unit.text]);
  let hash = 14_695_981_039_346_656_037n;
  const prime = 1_099_511_628_211n;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * prime);
  }

  return `unit-source:v1:${input.length}:${hash.toString(16).padStart(16, "0")}` as UnitSourceFingerprint;
}
