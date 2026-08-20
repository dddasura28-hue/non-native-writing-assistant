import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import {
  gatewayAnalysisRequestSchema,
  type GatewayAnalysisRequest,
  type WritingAnalysisOutput,
} from "./analysis-contract.js";

const ANALYSIS_PATH = "/v1/analyze";
const MAX_REQUEST_BYTES = 256 * 1024;

export interface WritingAnalyzer {
  analyze(
    request: GatewayAnalysisRequest,
    signal: AbortSignal,
  ): Promise<WritingAnalysisOutput>;
}

export function createGatewayServer(analyzer: WritingAnalyzer): Server {
  return createServer((request, response) => {
    void handleRequest(request, response, analyzer);
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  analyzer: WritingAnalyzer,
): Promise<void> {
  setCorsHeaders(response);

  if (request.method === "OPTIONS" && request.url === ANALYSIS_PATH) {
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method !== "POST" || request.url !== ANALYSIS_PATH) {
    writeError(response, 404, "not_found", "Endpoint not found.");
    return;
  }

  const controller = new AbortController();
  request.once("aborted", () => controller.abort());
  response.once("close", () => {
    if (!response.writableEnded) {
      controller.abort();
    }
  });

  try {
    const body = await readJsonBody(request);
    const parsedRequest = gatewayAnalysisRequestSchema.safeParse(body);
    if (!parsedRequest.success) {
      writeError(response, 400, "invalid_request", "Invalid analysis request.");
      return;
    }

    const result = await analyzer.analyze(parsedRequest.data, controller.signal);
    if (!response.destroyed) {
      writeJson(response, 200, result);
    }
  } catch (error) {
    if (controller.signal.aborted || response.destroyed) {
      return;
    }

    if (error instanceof RequestBodyTooLargeError) {
      writeError(response, 413, "request_too_large", error.message);
      return;
    }

    if (error instanceof SyntaxError) {
      writeError(response, 400, "invalid_json", "Request body must be valid JSON.");
      return;
    }

    console.error(describeProviderFailure(error));
    writeError(
      response,
      502,
      "analysis_failed",
      "AI analysis failed. Check the development gateway status.",
    );
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_REQUEST_BYTES) {
      throw new RequestBodyTooLargeError();
    }
    chunks.push(buffer);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function setCorsHeaders(response: ServerResponse): void {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function writeError(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  writeJson(response, status, { error: { code, message } });
}

class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Analysis request is too large.");
  }
}

function describeProviderFailure(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
  ) {
    return `OpenAI analysis request failed with HTTP ${error.status}.`;
  }

  return "OpenAI analysis request failed.";
}
