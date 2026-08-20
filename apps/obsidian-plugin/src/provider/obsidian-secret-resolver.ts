import type { SecretStorage } from "obsidian";
import type { SecretResolver } from "@non-native-writing/model-integration";

export class ObsidianSecretResolver implements SecretResolver {
  readonly #secretStorage: Pick<SecretStorage, "getSecret">;

  constructor(secretStorage: Pick<SecretStorage, "getSecret">) {
    this.#secretStorage = secretStorage;
  }

  async resolveSecret(secretRef: string): Promise<string | null> {
    return this.#secretStorage.getSecret(secretRef);
  }
}
