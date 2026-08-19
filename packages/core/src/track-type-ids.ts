import { asTrackTypeId } from "./ids.js";

export const SOURCE_TRACK_TYPE_ID = asTrackTypeId("source");
export const NATIVE_INTENT_TRACK_TYPE_ID = asTrackTypeId("native-intent");
export const NORMALIZED_TRACK_TYPE_ID = asTrackTypeId("normalized");

export const BUILT_IN_TRACK_TYPE_IDS = Object.freeze({
  source: SOURCE_TRACK_TYPE_ID,
  nativeIntent: NATIVE_INTENT_TRACK_TYPE_ID,
  normalized: NORMALIZED_TRACK_TYPE_ID,
});
