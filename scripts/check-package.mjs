import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const [pack] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], { encoding: "utf8" }));
const files = pack.files.map((file) => file.path);
for (const required of ["dist/index.js", "dist/manager.js", "dist/config.js", "dist/toml.js", "prompts/system.md", "openclaw.plugin.json", "README.md", "LICENSE"]) assert(files.includes(required), `Missing package file: ${required}`);
for (const path of files) assert(!/^(work|reports|test|node_modules)\//u.test(path), `Unexpected private/development file: ${path}`);
console.log(`Package verified: ${pack.name}@${pack.version}, ${files.length} files`);
