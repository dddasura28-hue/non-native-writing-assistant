/** Technical host facilities, not user permissions or provider capabilities. */
export interface HostCapabilities {
  readonly canReplaceText: boolean;
  readonly canObserveComposition: boolean;
  readonly canObserveSelection: boolean;
  readonly canProvideSurroundingText: boolean;
}

export function createHostCapabilities(input: HostCapabilities): HostCapabilities {
  return Object.freeze({
    canReplaceText: input.canReplaceText,
    canObserveComposition: input.canObserveComposition,
    canObserveSelection: input.canObserveSelection,
    canProvideSurroundingText: input.canProvideSurroundingText,
  });
}
