export interface StyleProfile {
  readonly register: string;
  readonly tone: string;
  readonly verbosity: string;
  readonly domain: string;
  readonly locale: string;
  readonly customInstructions?: string;
}

export function createStyleProfile(profile: StyleProfile): StyleProfile {
  return Object.freeze({ ...profile });
}
