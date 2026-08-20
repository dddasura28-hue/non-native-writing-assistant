import { requestUrl } from "obsidian";
import type {
  HttpTransport,
  HttpTransportRequest,
  HttpTransportResponse,
} from "@non-native-writing/model-integration";

export class ObsidianHttpTransport implements HttpTransport {
  async send(request: HttpTransportRequest): Promise<HttpTransportResponse> {
    const response = await requestUrl({
      url: request.url,
      method: request.method,
      contentType: "application/json",
      headers: { ...request.headers },
      body: request.body,
      throw: false,
    });

    return Object.freeze({
      status: response.status,
      headers: Object.freeze({ ...response.headers }),
      body: response.text,
    });
  }
}
