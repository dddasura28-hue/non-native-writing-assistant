declare const segmentIdBrand: unique symbol;
declare const trackIdBrand: unique symbol;
declare const trackTypeIdBrand: unique symbol;
declare const generationGroupIdBrand: unique symbol;

export type SegmentId = string & { readonly [segmentIdBrand]: true };
export type TrackId = string & { readonly [trackIdBrand]: true };
export type TrackTypeId = string & { readonly [trackTypeIdBrand]: true };
export type GenerationGroupId = string & {
  readonly [generationGroupIdBrand]: true;
};

export function asSegmentId(value: string): SegmentId {
  return value as SegmentId;
}

export function asTrackId(value: string): TrackId {
  return value as TrackId;
}

export function asTrackTypeId(value: string): TrackTypeId {
  return value as TrackTypeId;
}

export function asGenerationGroupId(value: string): GenerationGroupId {
  return value as GenerationGroupId;
}
