import {
  WritingModelError,
  type SecretResolver,
} from "@non-native-writing/model-integration";

import { validateSecretReference } from "../settings/desktop-provider-settings.js";
import {
  invokeNative,
  safeNativeErrorMessage,
  type NativeInvoke,
} from "./native-command-client.js";

export interface DesktopSecretStore {
  setSecret(secretRef: string, secret: string): Promise<void>;
  getSecret(secretRef: string): Promise<string | null>;
  hasSecret(secretRef: string): Promise<boolean>;
  deleteSecret(secretRef: string): Promise<void>;
}

export class TauriDesktopSecretStore implements DesktopSecretStore {
  readonly #invoke: NativeInvoke;

  constructor(invoke: NativeInvoke = invokeNative) {
    this.#invoke = invoke;
  }

  async setSecret(secretRef: string, secret: string): Promise<void> {
    assertSecretReference(secretRef);
    if (secret.trim().length === 0) {
      throw new Error("Enter a non-empty API credential.");
    }
    try {
      await this.#invoke<void>("set_provider_secret", { secretRef, secret });
    } catch (error) {
      throw new Error(
        safeNativeErrorMessage(
          error,
          "The operating system credential store could not save the credential.",
        ),
      );
    }
  }

  async getSecret(secretRef: string): Promise<string | null> {
    assertSecretReference(secretRef);
    try {
      return await this.#invoke<string | null>("get_provider_secret", {
        secretRef,
      });
    } catch {
      throw new WritingModelError(
        "missing-secret",
        "The operating system credential store could not read the configured credential.",
      );
    }
  }

  async hasSecret(secretRef: string): Promise<boolean> {
    assertSecretReference(secretRef);
    try {
      return await this.#invoke<boolean>("has_provider_secret", { secretRef });
    } catch (error) {
      throw new Error(
        safeNativeErrorMessage(
          error,
          "The credential status could not be read.",
        ),
      );
    }
  }

  async deleteSecret(secretRef: string): Promise<void> {
    assertSecretReference(secretRef);
    try {
      await this.#invoke<void>("delete_provider_secret", { secretRef });
    } catch (error) {
      throw new Error(
        safeNativeErrorMessage(
          error,
          "The operating system credential store could not remove the credential.",
        ),
      );
    }
  }
}

export class DesktopSecretResolver implements SecretResolver {
  readonly #secrets: Pick<DesktopSecretStore, "getSecret">;

  constructor(secrets: Pick<DesktopSecretStore, "getSecret">) {
    this.#secrets = secrets;
  }

  resolveSecret(secretRef: string): Promise<string | null> {
    return this.#secrets.getSecret(secretRef);
  }
}

function assertSecretReference(secretRef: string): void {
  if (!validateSecretReference(secretRef)) {
    throw new TypeError("The credential reference is invalid.");
  }
}
