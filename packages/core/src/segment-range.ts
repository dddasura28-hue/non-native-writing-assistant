export interface SegmentRange {
  readonly start: number;
  readonly end: number;
}

/** UTF-16 offsets in the half-open interval [start, end). */
export function createSegmentRange(start: number, end: number): SegmentRange {
  if (!Number.isSafeInteger(start) || start < 0) {
    throw new RangeError("SegmentRange start must be a non-negative integer.");
  }

  if (!Number.isSafeInteger(end) || end < start) {
    throw new RangeError(
      "SegmentRange end must be an integer greater than or equal to start.",
    );
  }

  return Object.freeze({ start, end });
}
