import {
  BUILT_IN_PROVIDER_DEFINITIONS,
  WritingModelError,
  resolveActiveProviderProfile,
  type HttpTransport,
  type HttpTransportRequest,
  type HttpTransportResponse,
  type ProviderProfile,
  type ProviderSettingsSource,
} from "@non-native-writing/model-integration";

import { invokeNative, type NativeInvoke } from "./native-command-client.js";

export class DesktopHttpTransport implements HttpTransport {
  readonly #profiles: ProviderSettingsSource;
  readonly #invoke: NativeInvoke;

  constructor(
    profiles: ProviderSettingsSource,
    invoke: NativeInvoke = invokeNative,
  ) {
    this.#profiles = profiles;
    this.#invoke = invoke;
  }

  async send(request: HttpTransportRequest): Promise<HttpTransportResponse> {
    const profile = resolveActiveProviderProfile(this.#profiles.getSettings());
    assertRequestAllowedForProfile(request.url, profile);
    const response = await this.#invoke<HttpTransportResponse>(
      "send_provider_http_request",
      { request },
    );
    return Object.freeze({
      status: response.status,
      headers: Object.freeze({ ...response.headers }),
      body: response.body,
    });
  }
}

export function assertRequestAllowedForProfile(
  requestUrl: string,
  profile: ProviderProfile,
): void {
  const definition = BUILT_IN_PROVIDER_DEFINITIONS.find(
    (candidate) => candidate.id === profile.providerId,
  );
  const baseUrl = profile.baseUrl ?? definition?.defaultBaseUrl;
  if (baseUrl === undefined) {
    throw new WritingModelError(
      "invalid-profile",
      "The selected provider profile requires a base URL.",
    );
  }

  let request: URL;
  let base: URL;
  try {
    request = new URL(requestUrl);
    base = new URL(baseUrl);
  } catch {
    throw new WritingModelError(
      "invalid-profile",
      "The provider request URL is invalid.",
    );
  }
  const basePath = base.pathname.replace(/\/+$/u, "");
  const allowedPath =
    request.pathname === basePath ||
    request.pathname.startsWith(`${basePath}/`);
  if (
    request.origin !== base.origin ||
    !allowedPath ||
    request.username.length > 0 ||
    request.password.length > 0 ||
    request.hash.length > 0
  ) {
    throw new WritingModelError(
      "invalid-profile",
      "The provider request does not match the active profile endpoint.",
    );
  }
}
