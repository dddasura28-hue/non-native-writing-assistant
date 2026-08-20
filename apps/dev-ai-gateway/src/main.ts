import OpenAI from "openai";

import { OpenAIWritingAnalyzer } from "./openai-writing-analyzer.js";
import { createGatewayServer } from "./server.js";

const HOST = "127.0.0.1";
const PORT = 8787;
const DEFAULT_MODEL = "gpt-5.6-luna";

const apiKey = process.env.OPENAI_API_KEY?.trim();
if (apiKey === undefined || apiKey.length === 0) {
  throw new Error("OPENAI_API_KEY is required to start the development gateway.");
}

const model = process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL;
const openai = new OpenAI({ apiKey });
const analyzer = new OpenAIWritingAnalyzer(openai.responses, model);
const server = createGatewayServer(analyzer);

server.listen(PORT, HOST, () => {
  console.log(
    `Development AI gateway listening at http://${HOST}:${PORT}/v1/analyze using ${model}.`,
  );
});

server.on("error", () => {
  console.error("Development AI gateway could not start.");
  process.exitCode = 1;
});
