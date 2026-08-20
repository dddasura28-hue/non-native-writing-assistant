import type {
  HttpTransport,
  HttpTransportResponse,
} from "../http-transport.js";
import type { ProviderProfile } from "../provider-profile.js";
import {
  WritingModelError,
  throwIfAnalysisAborted,
} from "../writing-model-error.js";

export async function sendJsonRequest(
  transport: HttpTransport,
  url: string,
  headers: Readonly<Record<string, string>>,
  body: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  throwIfAnalysisAborted(signal);

  let response: HttpTransportResponse;
  try {
    response = await transport.send({
      url,
      method: "POST",
      headers: Object.freeze({ ...headers }),
      body: JSON.stringify(body),
    });
  } catch {
    throwIfAnalysisAborted(signal);
    throw new WritingModelError(
      "network",
      "The writing-model provider could not be reached.",
    );
  }

  throwIfAnalysisAborted(signal);
  assertSuccessfulStatus(response.status);

  try {
    return JSON.parse(response.body) as unknown;
  } catch {
    throw new WritingModelError(
      "invalid-structured-output",
      "The provider returned an invalid JSON response.",
    );
  }
}

export function resolveBaseUrl(
  profile: ProviderProfile,
  defaultBaseUrl: string | undefined,
): string {
  const baseUrl = profile.baseUrl ?? defaultBaseUrl;
  if (baseUrl === undefined) {
    throw new WritingModelError(
      "invalid-profile",
      "The selected provider profile requires a base URL.",
    );
  }
  return baseUrl.replace(/\/+$/, "");
}

export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export function assertProfileProvider(
  profile: ProviderProfile,
  providerId: string,
): void {
  if (profile.providerId !== providerId) {
    throw new WritingModelError(
      "invalid-profile",
      "The provider profile does not match the selected adapter.",
    );
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSuccessfulStatus(status: number): void {
  if (status >= 200 && status < 300) {
    return;
  }

  if (status === 401 || status === 403) {
    throw new WritingModelError(
      "authentication",
      "The writing-model provider rejected the configured credential.",
      { status },
    );
  }

  if (status === 429) {
    throw new WritingModelError(
      "rate-limit",
      "The writing-model provider rate limit was reached.",
      { status },
    );
  }

  throw new WritingModelError(
    "provider-failure",
    "The writing-model provider request failed.",
    { status },
  );
}
