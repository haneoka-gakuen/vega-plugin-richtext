import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

if (!manifest.repository?.url?.endsWith("/vega-plugin-richtext.git")) {
  throw new Error("package repository must point to the independent rich-text plugin repository");
}
if (manifest.publishConfig?.access !== "public" || manifest.publishConfig?.provenance !== true) {
  throw new Error("public provenance publishing is required");
}
if (!manifest.vega?.capabilities?.includes("rich-text")) {
  throw new Error("rich-text capability metadata is required");
}

process.stdout.write("Rich-text plugin package boundary verified\n");
