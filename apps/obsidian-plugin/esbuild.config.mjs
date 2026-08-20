import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const appDirectory = dirname(fileURLToPath(import.meta.url));
const outputDirectory = join(appDirectory, "dist");
const analysisProvider = process.env.NNWA_ANALYSIS_PROVIDER ?? "demo";

if (analysisProvider !== "demo" && analysisProvider !== "http") {
  throw new Error("NNWA_ANALYSIS_PROVIDER must be either 'demo' or 'http'.");
}

await mkdir(outputDirectory, { recursive: true });

await build({
  entryPoints: [join(appDirectory, "src", "main.ts")],
  outfile: join(outputDirectory, "main.js"),
  bundle: true,
  external: ["obsidian"],
  format: "cjs",
  platform: "node",
  target: "es2022",
  define: {
    __NNWA_ANALYSIS_PROVIDER__: JSON.stringify(analysisProvider),
  },
  sourcemap: true,
  logLevel: "info",
});

await Promise.all([
  copyFile(
    join(appDirectory, "manifest.json"),
    join(outputDirectory, "manifest.json"),
  ),
  copyFile(
    join(appDirectory, "styles.css"),
    join(outputDirectory, "styles.css"),
  ),
]);
