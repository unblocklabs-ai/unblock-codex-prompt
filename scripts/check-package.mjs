import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], { encoding: "utf8" }));
// npm 10 prints an array; npm 11 inside a run-script prints an object keyed by package name.
const pack = Array.isArray(packed) ? packed[0] : Object.values(packed)[0];
const files = pack.files.map((file) => file.path);
assert(files.includes("dist/catalog.js"), "Missing catalog manager");
assert(files.includes("dist/compatibility.js"), "Missing version compatibility guard");
for (const required of ["dist/index.js", "dist/manager.js", "dist/config.js", "dist/toml.js", "dist/adapter.js", "dist/claude-adapter.js", "dist/claude-prompt.js", "dist/patched-files.js", "dist/managed-target.js", "dist/runtimes.js", "dist/compiler.js", "dist/runtime.js", "dist/remote.js", "openclaw.plugin.json", "README.md", "LICENSE"]) assert(files.includes(required), `Missing package file: ${required}`);
for (const path of files) assert(!/^(prompts|work|reports|test|node_modules)\//u.test(path), `Unexpected bundled prompt or private/development file: ${path}`);
console.log(`Package verified: ${pack.name}@${pack.version}, ${files.length} files`);
