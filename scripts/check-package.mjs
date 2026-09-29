import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const [pack] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], { encoding: "utf8" }));
const files = pack.files.map((file) => file.path);
assert(files.includes("dist/catalog.js"), "Missing catalog manager");
assert(files.includes("dist/compatibility.js"), "Missing version compatibility guard");
for (const required of ["dist/index.js", "dist/manager.js", "dist/config.js", "dist/toml.js", "dist/adapter.js", "dist/compiler.js", "dist/runtime.js", "dist/remote.js", "prompts/system.md", "prompts/developer.md", "openclaw.plugin.json", "README.md", "LICENSE"]) assert(files.includes(required), `Missing package file: ${required}`);
for (const path of files) assert(!/^(work|reports|test|node_modules)\//u.test(path), `Unexpected private/development file: ${path}`);
console.log(`Package verified: ${pack.name}@${pack.version}, ${files.length} files`);
