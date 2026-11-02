import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../dist/index.js";
import { fetchAndCompile } from "../dist/compiler.js";
import { refreshSharedPrompt, restorePrompt, sha256, syncPrompt } from "../dist/manager.js";
import { policyFetchers } from "../dist/remote.js";
import { refreshFailure } from "../dist/refresh-error.js";
import { readClaudeManagedContext, readCodexBaseInstructions, readFrozenPolicy } from "../dist/runtime.js";

/** The managed part of the Claude prompt: policy, then the memory reference (workspace files follow in the hook). */
function readClaudeManagedPrompt(agentDir) {
  const managed = readClaudeManagedContext(agentDir);
  return managed && `${managed.policy}\n\n${managed.agentContext}`;
}

const { Command } = createRequire(import.meta.resolve("openclaw/plugin-sdk/plugin-entry"))("commander");
const url = "https://fleet-prompt.example.test/prompt?channel=prod";

/** A stand-in for the fleet-prompt Worker. `legacy` models the deployed Worker: unknown parameters are HTTP 400. */
function worker({ legacy = false, confirmRuntime = true } = {}) {
  const served = { codex: "CODEX POLICY A", claude: "CLAUDE POLICY A" };
  const calls = [];
  const request = async target => {
    const requested = new URL(String(target));
    calls.push(requested);
    const runtime = requested.searchParams.get("runtime");
    if (legacy && runtime) return new Response("unknown parameter", { status: 400, headers: { "content-type": "text/plain" } });
    const body = served[runtime ?? "codex"];
    return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8", "x-prompt-revision": sha256(body),
      ...!legacy && (confirmRuntime || !runtime) ? { "x-prompt-runtime": runtime ?? "codex" } : {} } });
  };
  return { served, calls, request, fetchers: policyFetchers(url, request) };
}

const dir = async name => mkdtemp(join(await realpath(tmpdir()), `${name}-`));
const files = agentDir => {
  const home = join(agentDir, "codex-home");
  return { home, prompt: join(home, "unblock-codex-prompt.md"), bundle: join(home, ".unblock-codex-prompt-bundle.json") };
};
const bundleOf = async agentDir => JSON.parse(await readFile(files(agentDir).bundle, "utf8"));

async function sync(agentDir, w, { codex, claude, adopt = false }) {
  const { compiled } = await fetchAndCompile({ codex, claude, promptUrl: url, workspaceDir: agentDir, request: w.request, now: 100 });
  return syncPrompt({ agentDir, ...compiled }, { runtimes: [...codex ? ["codex"] : [], ...claude ? ["claude-cli"] : []], adopt });
}

test("Codex-only sync and refresh never send runtime= and work against a Worker that rejects it", async () => {
  const w = worker({ legacy: true });
  const agentDir = await dir("codex-policy");
  await sync(agentDir, w, { codex: true, claude: false });
  await refreshSharedPrompt(agentDir, w.fetchers);
  assert.equal(w.calls.length, 2);
  for (const call of w.calls) assert.equal(call.href, url, "the configured URL is requested exactly as written");
  assert.equal(readFrozenPolicy(agentDir), "");
  assert.match(readCodexBaseInstructions(agentDir), /^CODEX POLICY A\n\n## Memory reference\n[^]*conversations\.\n$/);
  assert.doesNotMatch(readCodexBaseInstructions(agentDir), /skills catalog/i);
  const bundle = await bundleOf(agentDir);
  assert.equal("claudePolicy" in bundle || "agentContext" in bundle, false);
  assert.equal(bundle.policy, "");
  assert.equal(bundle.remotePrompt.url, url);
});

test("Claude-only sync never requests the Codex artifact; the prompt file is the agent context", async () => {
  const w = worker();
  const agentDir = await dir("claude-policy");
  await sync(agentDir, w, { codex: false, claude: true });
  assert.deepEqual(w.calls.map(call => call.search), ["?channel=prod&runtime=claude"]);
  const bundle = await bundleOf(agentDir);
  const file = await readFile(files(agentDir).prompt, "utf8");
  // Claude-only choice: the prompt file holds exactly the shared agent context (no policy),
  // so its hash still anchors the bundle and refresh has no Codex prefix to replace.
  assert.equal(file, bundle.agentContext);
  assert.match(file, /^## Memory reference\n/);
  assert.doesNotMatch(file, /CLAUDE POLICY|CODEX POLICY|skills catalog/);
  assert.deepEqual([bundle.policy, "sources" in bundle, "skillCount" in bundle, "remotePrompt" in bundle, "basePromptLength" in bundle], ["", false, false, false, false]);
  assert.deepEqual(bundle.claudePolicy, { text: "CLAUDE POLICY A", url: `${url}&runtime=claude`, revision: sha256("CLAUDE POLICY A"), checkedAt: 100 });
  assert.deepEqual(readClaudeManagedContext(agentDir), { policy: "CLAUDE POLICY A", agentContext: bundle.agentContext });
  assert.throws(() => readFrozenPolicy(agentDir), /without Codex enrollment/);

  w.calls.length = 0;
  w.served.claude = "CLAUDE POLICY B";
  const refreshed = await refreshSharedPrompt(agentDir, w.fetchers, 200);
  assert.deepEqual(w.calls.map(call => call.search), ["?channel=prod&runtime=claude"]);
  assert.deepEqual([refreshed.changed, refreshed.nextClaudeProcess, "nextCodexTurn" in refreshed, "revision" in refreshed], [true, true, false, false]);
  assert.equal(await readFile(files(agentDir).prompt, "utf8"), file, "the Claude-only prompt file is untouched");
  assert.match(readClaudeManagedPrompt(agentDir), /^CLAUDE POLICY B\n\n## Memory reference\n/);
});

test("a both-runtime sync makes exactly two fetches: Codex without runtime, Claude with runtime=claude, channel preserved", async () => {
  const w = worker();
  const agentDir = await dir("both-policy");
  const { remote, claudePolicy } = await fetchAndCompile({ codex: true, claude: true, promptUrl: url, workspaceDir: agentDir, request: w.request, now: 5 });
  assert.equal(w.calls.length, 2);
  const [codexCall] = w.calls.filter(call => !call.searchParams.has("runtime"));
  const [claudeCall] = w.calls.filter(call => call.searchParams.has("runtime"));
  assert.equal(codexCall.href, url);
  assert.deepEqual([...claudeCall.searchParams], [["channel", "prod"], ["runtime", "claude"]]);
  assert.deepEqual([remote.url, claudePolicy], [url, { url: claudeCall.href, revision: sha256("CLAUDE POLICY A"), checkedAt: 5 }]);
  await sync(agentDir, w, { codex: true, claude: true });
  const bundle = await bundleOf(agentDir);
  assert.equal(bundle.claudePolicy.text, "CLAUDE POLICY A");
  assert.equal(bundle.remotePrompt.revision, sha256("CODEX POLICY A"));
  // Each runtime sees only its own policy; neither file carries a skills catalog.
  const managed = readClaudeManagedPrompt(agentDir);
  assert.equal(managed.split("CLAUDE POLICY A").length, 2);
  assert.doesNotMatch(managed, /CODEX POLICY|skills catalog/i);
  const codexPrompt = readCodexBaseInstructions(agentDir);
  assert.doesNotMatch(codexPrompt, /CLAUDE POLICY/);
  assert.match(codexPrompt, /^CODEX POLICY A\n\n/);
  assert.doesNotMatch(codexPrompt, /skills catalog/i);
});

async function bothEnrolled() {
  const w = worker();
  const agentDir = await dir("both-refresh");
  await sync(agentDir, w, { codex: true, claude: true });
  return { w, agentDir, ...files(agentDir) };
}

test("a changed Claude revision changes only the Claude prompt: the Codex file keeps its bytes, inode and mtime", async () => {
  const { w, agentDir, prompt } = await bothEnrolled();
  const before = { bytes: await readFile(prompt, "utf8"), stat: await stat(prompt), managed: readClaudeManagedPrompt(agentDir), codex: readCodexBaseInstructions(agentDir) };
  w.served.claude = "CLAUDE POLICY B";
  const refreshed = await refreshSharedPrompt(agentDir, w.fetchers, 300);
  assert.deepEqual([refreshed.changed, refreshed.nextClaudeProcess, refreshed.nextCodexTurn], [true, true, false]);
  assert.equal(refreshed.claudeRevision, sha256("CLAUDE POLICY B"));
  assert.equal(refreshed.revision, sha256("CODEX POLICY A"));
  const after = await stat(prompt);
  assert.equal(await readFile(prompt, "utf8"), before.bytes);
  assert.deepEqual([after.ino, after.mtimeMs], [before.stat.ino, before.stat.mtimeMs]);
  assert.equal(readCodexBaseInstructions(agentDir), before.codex);
  assert.equal(readClaudeManagedPrompt(agentDir), before.managed.replace("CLAUDE POLICY A", "CLAUDE POLICY B"));
  const bundle = await bundleOf(agentDir);
  assert.equal(bundle.claudePolicy.checkedAt, 300);
  assert.equal(bundle.remotePrompt.checkedAt, 300);
  assert.equal(bundle.promptSha256, sha256(before.bytes));
  // Nothing changed: the Claude prompt is stable and neither runtime is flagged.
  const again = await refreshSharedPrompt(agentDir, w.fetchers, 400);
  assert.deepEqual([again.changed, again.nextClaudeProcess, again.nextCodexTurn], [false, false, false]);
});

test("a changed Codex revision changes only the Codex policy prefix; the Claude prompt is identical", async () => {
  const { w, agentDir, prompt } = await bothEnrolled();
  const before = { bytes: await readFile(prompt, "utf8"), managed: readClaudeManagedPrompt(agentDir), claude: (await bundleOf(agentDir)).claudePolicy };
  w.served.codex = "CODEX POLICY B";
  const refreshed = await refreshSharedPrompt(agentDir, w.fetchers, 300);
  assert.deepEqual([refreshed.changed, refreshed.nextCodexTurn, refreshed.nextClaudeProcess], [true, true, false]);
  const bytes = await readFile(prompt, "utf8");
  assert.equal(bytes, before.bytes.replace("CODEX POLICY A", "CODEX POLICY B"));
  assert.equal(readCodexBaseInstructions(agentDir), bytes);
  assert.deepEqual(readClaudeManagedPrompt(agentDir), before.managed);
  assert.deepEqual((await bundleOf(agentDir)).claudePolicy, { ...before.claude, checkedAt: 300 });
});

test("a failed fetch of either runtime writes nothing, and a Worker without runtime support names the deploy", async () => {
  const { w, agentDir, prompt, bundle } = await bothEnrolled();
  const snapshot = async () => [await readFile(prompt, "utf8"), await readFile(bundle, "utf8"), (await stat(prompt)).ino];
  const before = await snapshot();
  w.served.codex = "CODEX POLICY B";
  w.served.claude = "CLAUDE POLICY B";
  const legacy = worker({ legacy: true });
  legacy.served.codex = "CODEX POLICY B";
  const failures = [
    [legacy.request, /HTTP 400 for runtime=claude; deploy the fleet-prompt Worker with runtime support first/],
    [worker({ confirmRuntime: false }).request, /did not confirm runtime=claude; deploy the fleet-prompt Worker/],
    [async target => { if (new URL(String(target)).searchParams.has("runtime")) throw new Error("offline"); return w.request(target); }, /offline/],
    [async target => new URL(String(target)).searchParams.has("runtime") ? new Response("down", { status: 503, headers: { "content-type": "text/plain" } }) : w.request(target), /HTTP 503/],
  ];
  for (const [request, error] of failures) {
    // Codex is fetched successfully (and would have changed) but Claude fails: nothing may be written.
    await assert.rejects(refreshSharedPrompt(agentDir, policyFetchers(url, request), 999), error);
    assert.deepEqual(await snapshot(), before);
    await assert.rejects(sync(await dir("failed-sync"), { request }, { codex: true, claude: true }), error);
  }
  const fresh = await dir("failed-sync-nothing");
  await assert.rejects(sync(fresh, { request: legacy.request }, { codex: false, claude: true }), /deploy the fleet-prompt Worker/);
  await assert.rejects(readdir(join(fresh, "codex-home")), /ENOENT/);
  // The safe daily-refresh diagnostic keeps the actionable cause and nothing else.
  const diagnostic = await refreshSharedPrompt(agentDir, policyFetchers(url, legacy.request)).catch(error => refreshFailure("shared prompt", error).message);
  assert.equal(diagnostic, "shared prompt: Prompt endpoint returned HTTP 400 for runtime=claude; deploy the fleet-prompt Worker with runtime support first");
});

test("a Claude-enrolled bundle without a valid Claude policy is an invalid state, never an upstream render", async () => {
  const w = worker();
  const agentDir = await dir("missing-claude");
  await sync(agentDir, w, { codex: false, claude: true });
  const f = files(agentDir);
  const good = await readFile(f.bundle, "utf8");
  for (const mutate of [bundle => { delete bundle.claudePolicy; }, bundle => { bundle.claudePolicy.text = " "; }, bundle => { bundle.claudePolicy.revision = 7; },
    bundle => { delete bundle.claudePolicy.checkedAt; }, bundle => { delete bundle.agentContext; }, bundle => { bundle.agentContext = 4; }]) {
    const bundle = JSON.parse(good);
    mutate(bundle);
    await writeFile(f.bundle, JSON.stringify(bundle));
    assert.throws(() => readClaudeManagedPrompt(agentDir), /run codex-prompt sync/);
    await assert.rejects(refreshSharedPrompt(agentDir, { claude: () => assert.fail("must not fetch") }), /run codex-prompt sync/);
  }
  await writeFile(f.bundle, good);
  assert.ok(readClaudeManagedPrompt(agentDir));
});

test("the bundle is the trust root: editing claudePolicy changes the managed prompt; an unverified prompt file fails closed", async () => {
  const w = worker();
  const agentDir = await dir("tamper-claude");
  await sync(agentDir, w, { codex: false, claude: true });
  const f = files(agentDir);
  const bundle = await bundleOf(agentDir);
  // An edit to the receipt is indistinguishable from a sync: whoever can write the bundle owns the policy.
  await writeFile(f.bundle, JSON.stringify({ ...bundle, claudePolicy: { ...bundle.claudePolicy, text: "TAMPERED POLICY" } }));
  assert.equal(readClaudeManagedPrompt(agentDir).startsWith("TAMPERED POLICY\n\n## Memory reference\n"), true);
  // The prompt file is verified against the bundle's hash; a bundle written without re-hashing it fails closed.
  await writeFile(f.bundle, JSON.stringify({ ...bundle, promptSha256: sha256("other") }));
  assert.throws(() => readClaudeManagedContext(agentDir), /changed outside sync/);
  await writeFile(f.bundle, JSON.stringify(bundle));
  await writeFile(f.prompt, "tampered");
  assert.throws(() => readClaudeManagedContext(agentDir), /changed outside sync/);
  await writeFile(join(f.home, ".unblock-codex-prompt.json"), "{");
  assert.throws(() => readClaudeManagedContext(agentDir), /Invalid frozen bridge enrollment/);
});

test("status reports each runtime's policy revision and never policy text", async t => {
  const w = worker();
  const agentDir = await dir("status-policy");
  await sync(agentDir, w, { codex: true, claude: true });
  const output = [];
  t.mock.method(console, "log", value => output.push(value));
  const config = { agents: { list: [{ id: "main", agentDir, workspace: agentDir }] }, plugins: { entries: { "unblock-codex-prompt": {
    enabled: true, hooks: { allowConversationAccess: true }, config: { frozenContext: true, promptUrl: url } } } } };
  let registerCli;
  plugin.register({ config, registerService() {}, on() {}, registerCli: handler => { registerCli = handler; } });
  const program = new Command();
  registerCli({ program, config });
  await program.parseAsync(["node", "fixture", "codex-prompt", "status"]);
  const status = JSON.parse(output.at(-1));
  assert.deepEqual(status.remotePrompt, { url, revision: sha256("CODEX POLICY A"), checkedAt: 100 });
  assert.deepEqual(status.claudePolicy, { url: `${url}&runtime=claude`, revision: sha256("CLAUDE POLICY A"), checkedAt: 100 });
  assert.doesNotMatch(output.at(-1), /CLAUDE POLICY A|CODEX POLICY A|## Memory reference/);

  await restorePrompt({ agentDir, prompt: "" });
  output.length = 0;
  const codexOnly = await dir("status-codex");
  await sync(codexOnly, w, { codex: true, claude: false });
  const other = { ...config, agents: { list: [{ id: "main", agentDir: codexOnly, workspace: codexOnly }] } };
  const second = new Command();
  registerCli({ program: second, config: other });
  await second.parseAsync(["node", "fixture", "codex-prompt", "status"]);
  assert.equal("claudePolicy" in JSON.parse(output.at(-1)), false);
});
