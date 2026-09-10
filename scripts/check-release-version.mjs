import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const releaseTag = process.argv[2] ?? process.env.RELEASE_TAG;
assert.match(releaseTag ?? "", /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u, "Expected vX.Y.Z or vX.Y.Z-prerelease");
const readJson = async (name) => JSON.parse(await readFile(new URL(`../${name}`, import.meta.url), "utf8"));
const [pkg, manifest, lock] = await Promise.all([readJson("package.json"), readJson("openclaw.plugin.json"), readJson("package-lock.json")]);
assert.equal(pkg.name, "@unblocklabs/unblock-codex-prompt");
for (const version of [pkg.version, manifest.version, lock.version, lock.packages[""].version]) assert.equal(version, releaseTag.slice(1));
console.log(`Release versions match: ${releaseTag}`);
