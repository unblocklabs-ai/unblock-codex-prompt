import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, realpath, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../dist/config.js";
import { fetchPrompt } from "../dist/remote.js";
import { compilePrompt } from "../dist/compiler.js";
import { sha256, syncPrompt, refreshSharedPrompt, restorePrompt } from "../dist/manager.js";
import { readCodexBaseInstructions, readFrozenPolicy } from "../dist/runtime.js";

const url = "https://fleet-prompt.unblocklabs.ai/prompt?channel=dev";
const text = "# Fleet operating instructions\n\nExact approved policy.\n";
function response(body = text, headers = {}) {
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8", "x-prompt-revision": sha256(body), ...headers } });
}

test("remote config requires the bridge and credential-free HTTPS", () => {
  const config = { frozenContext: true, promptUrl: url };
  assert.deepEqual(parseConfig(config), { agentId: "main", ...config, suppressExplicitDelegationPrompt: false, disabledCodexSkills: ["pages", "work-pets"] });
  assert.deepEqual(parseConfig({ ...config, agentName: "Bill" }), parseConfig(config));
  assert.throws(() => parseConfig({ frozenContext: true }), /promptUrl/);
  assert.throws(() => parseConfig({ promptUrl: url }), /frozenContext/);
  assert.throws(() => parseConfig({ ...config, frozenContext: false }), /frozenContext/);
  for (const invalid of [{ ...config, agentId: "../main" }, { ...config, extra: true }]) assert.throws(() => parseConfig(invalid));
  for (const promptUrl of [7, "http://localhost/prompt", "https://user:secret@example.com/prompt", `${url}#fragment`]) {
    assert.throws(() => parseConfig({ frozenContext: true, promptUrl }));
  }
});

async function enrolledRemote() {
  const agentDir = await mkdtemp(join(await realpath(tmpdir()), "shared-refresh-"));
  await writeFile(join(agentDir, "SOUL.md"), "Frozen soul");
  const compiled = await compilePrompt(text, agentDir);
  compiled.bundle.remotePrompt = { url, revision: sha256(text) };
  await syncPrompt({ agentDir, ...compiled });
  const home = join(agentDir, "codex-home");
  return { agentDir, compiled, path: join(home, "unblock-codex-prompt.md"), bundlePath: join(home, ".unblock-codex-prompt-bundle.json") };
}

test("shared refresh changes only the policy prefix and leaves unchanged prompt bytes/inode alone", async () => {
  const f = await enrolledRemote();
  assert.ok(f.compiled.prompt.startsWith(text.trim() + "\n\n## Memory reference\n"));
  await writeFile(join(f.agentDir, "SOUL.md"), "New soul must not leak into refresh");
  const updated = "<primary_instructions>\nNew shared policy 🦀\n</primary_instructions>\n";
  const fetchBase = { codex: () => fetchPrompt(url, async () => response(updated)) };
  const refreshed = await refreshSharedPrompt(f.agentDir, fetchBase, 1000);
  assert.deepEqual([refreshed.changed, refreshed.nextCodexTurn, "newSessionRequired" in refreshed], [true, true, false]);
  const prompt = await readFile(f.path, "utf8");
  assert.equal(prompt, updated.trim() + f.compiled.prompt.slice(f.compiled.bundle.basePromptLength));
  assert.equal(readCodexBaseInstructions(f.agentDir), prompt);
  const bundle = JSON.parse(await readFile(f.bundlePath, "utf8"));
  assert.equal(bundle.remotePrompt.checkedAt, 1000);
  assert.equal(readFrozenPolicy(f.agentDir), "");
  const before = await stat(f.path);
  assert.equal((await refreshSharedPrompt(f.agentDir, fetchBase, 2000)).changed, false);
  assert.equal((await stat(f.path)).ino, before.ino);
  assert.equal((await stat(f.path)).mtimeMs, before.mtimeMs);
});

test("refresh keeps an older snapshot's frozen skills catalog tail byte-for-byte until the next sync", async () => {
  const catalogTail = "\n\n## Frozen OpenClaw skills catalog\nThis is the approved agent-workspace catalog at sync time, not a promise that credentials or tools remain available.\n\n<available_skills><skill>legacy</skill></available_skills>\n";
  // 0.3 (frozen identity sections) and pre-live-catalog 0.4 (live identity) snapshots both end in the catalog.
  const tails = ["\n\n## Frozen agent context\nThis context is a local snapshot.\n\n### SOUL.md\nOld soul\n\n## Frozen memory reference\nRead MEMORY.md." + catalogTail,
    "\n\n## Agent context\nThe runtime supplies this agent's identity and workspace files live.\n\n## Memory reference\nRead MEMORY.md." + catalogTail];
  for (const tail of tails) {
    const agentDir = await mkdtemp(join(await realpath(tmpdir()), "legacy-catalog-"));
    const prompt = text.trim() + tail;
    const bundle = { schema: 1, policy: "", sources: [{ name: "OpenClaw skills catalog", sha256: sha256("<available_skills><skill>legacy</skill></available_skills>") }],
      skillCount: 1, basePromptLength: text.trim().length, remotePrompt: { url, revision: sha256(text), checkedAt: 0 } };
    await syncPrompt({ agentDir, prompt, bundle });
    const updated = "New shared policy";
    const refreshed = await refreshSharedPrompt(agentDir, { codex: () => fetchPrompt(url, async () => response(updated)) }, 1000);
    assert.equal(refreshed.changed, true);
    const home = join(agentDir, "codex-home");
    const after = await readFile(join(home, "unblock-codex-prompt.md"), "utf8");
    assert.equal(after, updated + tail);
    assert.ok(after.endsWith(catalogTail));
    assert.equal(readCodexBaseInstructions(agentDir), after);
    // Unknown legacy fields carry forward untouched; only the prefix receipt changes.
    const stored = JSON.parse(await readFile(join(home, ".unblock-codex-prompt-bundle.json"), "utf8"));
    assert.deepEqual([stored.sources, stored.skillCount, stored.basePromptLength], [bundle.sources, 1, updated.length]);
  }
});

test("failed validation retains prompt and receipt; restored and foreign state never fetch", async () => {
  const f = await enrolledRemote();
  const before = await readFile(f.bundlePath, "utf8");
  await assert.rejects(refreshSharedPrompt(f.agentDir, { codex: () => fetchPrompt(url, async () => response("bad", { "x-prompt-revision": "wrong" })) }), /revision/);
  assert.equal(await readFile(f.path, "utf8"), f.compiled.prompt);
  assert.equal(await readFile(f.bundlePath, "utf8"), before);
  await writeFile(f.path, "foreign edit");
  const never = { codex: () => { assert.fail("must not fetch"); }, claude: () => { assert.fail("must not fetch"); } };
  await assert.rejects(refreshSharedPrompt(f.agentDir, never), /snapshot/);
  await restorePrompt({ agentDir: f.agentDir, prompt: "" });
  assert.equal((await refreshSharedPrompt(f.agentDir, never)).skipped, true);
});

test("0.3 and 0.4-branch snapshots refresh by their older boundary headings; unknown boundaries and missing prefix lengths are refused", async () => {
  // 0.3.x snapshots start their context with `## Frozen agent context`, 0.4 branch builds with
  // `## Agent context`; every remote snapshot records its prefix length.
  for (const legacy of ["\n\n## Frozen agent context\nOld context.", "\n\n## Agent context\nOld context."]) {
    const f = await enrolledRemote();
    const original = f.compiled.prompt.slice(0, f.compiled.bundle.basePromptLength) + legacy + f.compiled.prompt.slice(f.compiled.bundle.basePromptLength);
    const bundle = JSON.parse(await readFile(f.bundlePath, "utf8"));
    bundle.promptSha256 = sha256(original);
    await writeFile(f.path, original);
    await writeFile(f.bundlePath, JSON.stringify(bundle));
    await refreshSharedPrompt(f.agentDir, { codex: () => fetchPrompt(url, async () => response("New base\n")) });
    assert.equal(await readFile(f.path, "utf8"), "New base" + original.slice(f.compiled.bundle.basePromptLength));
    const prompt = await readFile(f.path, "utf8");
    const missing = JSON.parse(await readFile(f.bundlePath, "utf8"));
    delete missing.basePromptLength;
    await writeFile(f.bundlePath, JSON.stringify(missing));
    await assert.rejects(refreshSharedPrompt(f.agentDir, { codex: () => { assert.fail("must not fetch"); } }), /ambiguous/);
    assert.equal(await readFile(f.path, "utf8"), prompt);
  }
  const f = await enrolledRemote();
  const unknown = f.compiled.prompt.replace("\n\n## Memory reference\n", "\n\n## Something else\n");
  const bundle = JSON.parse(await readFile(f.bundlePath, "utf8"));
  bundle.promptSha256 = sha256(unknown);
  await writeFile(f.path, unknown);
  await writeFile(f.bundlePath, JSON.stringify(bundle));
  await assert.rejects(refreshSharedPrompt(f.agentDir, { codex: () => { assert.fail("must not fetch"); } }), /ambiguous/);
  assert.equal(await readFile(f.path, "utf8"), unknown);
});

test("receipt publication failure rolls back the prompt while preserving the concurrent receipt edit", async () => {
  const f = await enrolledRemote();
  await assert.rejects(refreshSharedPrompt(f.agentDir, { codex: async () => {
    await writeFile(f.bundlePath, "concurrent receipt edit");
    return fetchPrompt(url, async () => response("New base\n"));
  } }), /Concurrent edit/);
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
  const compiled = await compilePrompt(remote.prompt, agentDir);
  compiled.bundle.remotePrompt = remote.source;
  await syncPrompt({ agentDir, ...compiled });
  const path = join(home, "unblock-codex-prompt.md");
  const before = await readFile(path, "utf8");
  assert(before.startsWith(text.trim()));
  assert.equal(readFrozenPolicy(agentDir), "");
  assert.deepEqual(JSON.parse(await readFile(join(home, ".unblock-codex-prompt-bundle.json"), "utf8")).remotePrompt, remote.source);
  await assert.rejects(fetchPrompt(url, async () => { throw new Error("offline"); }), /offline/);
  assert.equal(await readFile(path, "utf8"), before);
  assert.equal(readFrozenPolicy(agentDir), "");
  assert.equal((await syncPrompt({ agentDir, ...compiled })).changed, false);
});
