import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, realpath, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../dist/config.js";
import { fetchPrompt, REMOTE_POLICY } from "../dist/remote.js";
import { compilePrompt } from "../dist/compiler.js";
import { sha256, syncPrompt, refreshSharedPrompt, restorePrompt } from "../dist/manager.js";
import { readFrozenPolicy } from "../dist/runtime.js";

const url = "https://fleet-prompt.unblocklabs.ai/prompt?channel=dev";
const text = "# Fleet operating instructions\n\nExact approved policy.\n";
function response(body = text, headers = {}) {
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8", "x-prompt-revision": sha256(body), ...headers } });
}

test("remote config requires the bridge and credential-free HTTPS", () => {
  assert.equal(parseConfig({ frozenContext: true, promptUrl: url }).promptUrl, url);
  assert.throws(() => parseConfig({ promptUrl: url }), /frozenContext/);
  for (const promptUrl of [7, "http://localhost/prompt", "https://user:secret@example.com/prompt", `${url}#fragment`]) {
    assert.throws(() => parseConfig({ frozenContext: true, promptUrl }));
  }
});

async function enrolledRemote() {
  const agentDir = await mkdtemp(join(await realpath(tmpdir()), "shared-refresh-"));
  await writeFile(join(agentDir, "SOUL.md"), "Frozen soul");
  const compiled = await compilePrompt(text, REMOTE_POLICY, agentDir, { prompt: "Frozen skills", count: 1 });
  compiled.bundle.remotePrompt = { url, revision: sha256(text) };
  await syncPrompt({ agentDir, ...compiled });
  const home = join(agentDir, "codex-home");
  return { agentDir, compiled, path: join(home, "unblock-codex-prompt.md"), bundlePath: join(home, ".unblock-codex-prompt-bundle.json") };
}

test("shared refresh changes only the prefix, preserves frozen context, and leaves unchanged prompt bytes/inode alone", async () => {
  const f = await enrolledRemote();
  await writeFile(join(f.agentDir, "SOUL.md"), "New soul must not leak into refresh");
  const updated = "<primary_instructions>\nNew shared policy 🦀\n</primary_instructions>\n";
  const fetchBase = () => fetchPrompt(url, async () => response(updated));
  assert.equal((await refreshSharedPrompt(f.agentDir, fetchBase, 1000)).changed, true);
  const prompt = await readFile(f.path, "utf8");
  assert.equal(prompt, updated.trim() + f.compiled.prompt.slice(f.compiled.bundle.basePromptLength));
  const bundle = JSON.parse(await readFile(f.bundlePath, "utf8"));
  assert.deepEqual(bundle.sources, f.compiled.bundle.sources);
  assert.equal(bundle.skillCount, 1);
  assert.equal(bundle.remotePrompt.checkedAt, 1000);
  assert.equal(readFrozenPolicy(f.agentDir), REMOTE_POLICY);
  const before = await stat(f.path);
  assert.equal((await refreshSharedPrompt(f.agentDir, fetchBase, 2000)).changed, false);
  assert.equal((await stat(f.path)).ino, before.ino);
  assert.equal((await stat(f.path)).mtimeMs, before.mtimeMs);
});

test("failed validation retains prompt and receipt; restored and foreign state never fetch", async () => {
  const f = await enrolledRemote();
  const before = await readFile(f.bundlePath, "utf8");
  await assert.rejects(refreshSharedPrompt(f.agentDir, () => fetchPrompt(url, async () => response("bad", { "x-prompt-revision": "wrong" }))), /revision/);
  assert.equal(await readFile(f.path, "utf8"), f.compiled.prompt);
  assert.equal(await readFile(f.bundlePath, "utf8"), before);
  await writeFile(f.path, "foreign edit");
  const never = () => { assert.fail("must not fetch"); };
  await assert.rejects(refreshSharedPrompt(f.agentDir, never), /snapshot/);
  await restorePrompt({ agentDir: f.agentDir, prompt: "" });
  assert.equal((await refreshSharedPrompt(f.agentDir, never)).skipped, true);
});

test("legacy snapshot migrates without rereading context; ambiguous legacy boundary is refused", async () => {
  const f = await enrolledRemote();
  const bundle = JSON.parse(await readFile(f.bundlePath, "utf8"));
  delete bundle.basePromptLength;
  await writeFile(f.bundlePath, JSON.stringify(bundle));
  await refreshSharedPrompt(f.agentDir, () => fetchPrompt(url, async () => response("New base\n")));
  assert.equal(await readFile(f.path, "utf8"), "New base" + f.compiled.prompt.slice(f.compiled.bundle.basePromptLength));
  const prompt = await readFile(f.path, "utf8") + "\n\n## Frozen agent context\nambiguous";
  const legacy = JSON.parse(await readFile(f.bundlePath, "utf8"));
  delete legacy.basePromptLength;
  legacy.promptSha256 = sha256(prompt);
  await writeFile(f.path, prompt);
  await writeFile(f.bundlePath, JSON.stringify(legacy));
  await assert.rejects(refreshSharedPrompt(f.agentDir, () => { assert.fail("must not fetch"); }), /ambiguous/);
});

test("receipt publication failure rolls back the prompt while preserving the concurrent receipt edit", async () => {
  const f = await enrolledRemote();
  await assert.rejects(refreshSharedPrompt(f.agentDir, async () => {
    await writeFile(f.bundlePath, "concurrent receipt edit");
    return fetchPrompt(url, async () => response("New base\n"));
  }), /Concurrent edit/);
  assert.equal(await readFile(f.path, "utf8"), f.compiled.prompt);
  assert.equal(await readFile(f.bundlePath, "utf8"), "concurrent receipt edit");
});

test("fetch preserves exact text and validates the bounded, unauthenticated response", async () => {
  const remote = await fetchPrompt(url, async (target, options) => {
    assert.equal(String(target), url);
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
    assert(options.signal instanceof AbortSignal);
    assert(!("Authorization" in options.headers));
    return response();
  });
  assert.deepEqual(remote, { prompt: text, source: { url, revision: sha256(text) } });
  for (const [reply, error] of [
    [new Response("Unavailable", { status: 503 }), /HTTP 503/],
    [response("<html>login</html>", { "content-type": "text/html" }), /plain text/],
    [response(""), /empty/],
    [response("bad\0text"), /NUL/],
    [response(text, { "x-prompt-revision": "wrong" }), /revision/],
    [response("x".repeat(256 * 1024 + 1)), /256 KiB/],
  ]) await assert.rejects(fetchPrompt(url, async () => reply), error);
});

test("remote snapshot is cached locally; failed fetch cannot replace it with a bundled policy", async () => {
  const agentDir = await mkdtemp(join(await realpath(tmpdir()), "remote-prompt-"));
  const home = join(agentDir, "codex-home");
  await mkdir(home);
  const remote = await fetchPrompt(url, async () => response());
  const compiled = await compilePrompt(remote.prompt, REMOTE_POLICY, agentDir, { prompt: "", count: 0 });
  compiled.bundle.remotePrompt = remote.source;
  await syncPrompt({ agentDir, ...compiled });
  const path = join(home, "unblock-codex-prompt.md");
  const before = await readFile(path, "utf8");
  assert(before.startsWith(text.trim()));
  assert.equal(readFrozenPolicy(agentDir), REMOTE_POLICY);
  assert.deepEqual(JSON.parse(await readFile(join(home, ".unblock-codex-prompt-bundle.json"), "utf8")).remotePrompt, remote.source);
  await assert.rejects(fetchPrompt(url, async () => { throw new Error("offline"); }), /offline/);
  assert.equal(await readFile(path, "utf8"), before);
  assert.equal(readFrozenPolicy(agentDir), REMOTE_POLICY);
  assert.equal((await syncPrompt({ agentDir, ...compiled })).changed, false);
});
