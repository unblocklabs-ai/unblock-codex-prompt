import { readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const { outputFiles, metafile } = await build({
  stdin: {
    contents: 'export { readFrozenPolicy, readCodexBaseInstructions, normalizeOpenClawAdditions, normalizeOpenClawTurnContext } from "./src/runtime.ts";',
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: "node",
  target: "node22",
  format: "iife",
  globalName: "unblockBridge",
  minify: true,
  metafile: true,
  write: false,
});
if (Object.values(metafile.outputs).some(output => output.imports.some(entry => !entry.path.startsWith("node:")))) {
  throw new Error("The installed Codex bridge may only import Node built-ins");
}

// The generated patch carries its dependencies' license notices with the code.
const dependencies = new Set(Object.keys(metafile.inputs).flatMap(input => {
  const match = [...input.matchAll(/(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+(?=\/)/gu)].at(-1);
  return match ? [input.slice(0, match.index + match[0].length)] : [];
}));
const notices = await Promise.all([...dependencies].map(async dir =>
  "/*! " + (await readFile(dir + "/LICENSE", "utf8")).trim().replaceAll("*/", "* /") + " */"));
const source = [...notices, outputFiles[0].text].join("\n");
await writeFile("dist/codex-bridge-source.js", `export const codexBridgeSource = ${JSON.stringify(source)};\n`);
