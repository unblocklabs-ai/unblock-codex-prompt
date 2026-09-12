import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// Make retries (and the first authenticated bootstrap publish) safe: an existing
// version is accepted only if the registry holds this exact release artifact.
const [pack] = JSON.parse(execFileSync("npm", ["pack", "--json"], { encoding: "utf8" }));
assert.equal(pack.name, "@unblocklabs/unblock-codex-prompt");
const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pack.name)}/${encodeURIComponent(pack.version)}`, {
  signal: AbortSignal.timeout(15_000), redirect: "error",
});
if (response.ok) {
  const published = await response.json();
  assert.equal(published.dist?.integrity, pack.integrity, "Published version differs from this release artifact; refusing to skip");
  console.log(`Verified identical published artifact: ${pack.name}@${pack.version}`);
} else {
  assert.equal(response.status, 404, `Registry lookup failed: HTTP ${response.status}`);
  const tag = process.env.NPM_TAG ?? "latest";
  assert(["latest", "next"].includes(tag), "Unsupported release dist-tag");
  execFileSync("npm", ["publish", pack.filename, "--access", "public", "--provenance", "--tag", tag], { stdio: "inherit" });
}
