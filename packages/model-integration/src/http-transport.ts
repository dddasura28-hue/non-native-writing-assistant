export interface HttpTransportRequest {
  readonly url: string;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface HttpTransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface HttpTransport {
  send(request: HttpTransportRequest): Promise<HttpTransportResponse>;
}
