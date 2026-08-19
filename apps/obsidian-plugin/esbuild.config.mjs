import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const appDirectory = dirname(fileURLToPath(import.meta.url));
const outputDirectory = join(appDirectory, "dist");

await mkdir(outputDirectory, { recursive: true });

await build({
  entryPoints: [join(appDirectory, "src", "main.ts")],
  outfile: join(outputDirectory, "main.js"),
  bundle: true,
  external: ["obsidian"],
  format: "cjs",
  platform: "node",
  target: "es2022",
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
