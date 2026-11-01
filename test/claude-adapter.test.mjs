import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { applyClaudeRestore, claudeAdapterStatus, installClaudeAdapter, planClaudeRestore, prepareClaudeAdapter } from "../dist/claude-adapter.js";
import { compilePrompt } from "../dist/compiler.js";
import { sha256, syncPrompt } from "../dist/manager.js";
import * as runtime from "../dist/runtime.js";

const fixture = JSON.parse(await readFile(new URL("./fixtures/claude-assembly.json", import.meta.url), "utf8"));
const runtimePath = fileURLToPath(new URL("../dist/runtime.js", import.meta.url));
const restoreClaudeAdapter = async agentDir => applyClaudeRestore(await planClaudeRestore(agentDir));
const chunks = {
  "helpers-test.mjs": `import { t as buildConfiguredAgentSystemPrompt } from "./system-prompt-config-test.mjs";\n${fixture.functions.buildCliAgentSystemPrompt}\nexport { buildCliAgentSystemPrompt as t };\n`,
  "system-prompt-config-test.mjs": `import { n as buildAgentSystemPrompt } from "./system-prompt-test.mjs";\n${fixture.functions.buildConfiguredAgentSystemPrompt}\nexport { buildConfiguredAgentSystemPrompt as t };\n`,
  "system-prompt-test.mjs": `${fixture.functions.buildAgentSystemPrompt}\nexport { buildAgentSystemPrompt as n };\n`,
  "unrelated-test.mjs": "export const unrelated = true;\n",
};

async function fakeCore(version = "2026.10.6", files = chunks) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "openclaw-core-"));
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "openclaw", version }));
  for (const [name, source] of Object.entries(files)) await writeFile(join(root, "dist", name), source);
  return root;
}

async function enrolledAgent(runtimes = ["claude-cli"]) {
  const agentDir = await mkdtemp(join(await realpath(tmpdir()), "claude-agent-"));
  const claudePolicy = { text: "FLEET POLICY", url: "https://example.test/prompt?runtime=claude", revision: sha256("FLEET POLICY"), checkedAt: 0 };
  // Both runtimes compile the Codex layout; Claude-only holds just the agent context.
  const compiled = await compilePrompt(runtimes.includes("codex") ? "CODEX POLICY" : null, agentDir, claudePolicy);
  if (runtimes.includes("codex")) compiled.bundle.remotePrompt = { url: "https://example.test/prompt", revision: sha256("CODEX POLICY") };
  await syncPrompt({ agentDir, ...compiled }, { runtimes });
  return agentDir;
}

async function readDist(root) {
  return Object.fromEntries(await Promise.all((await readdir(join(root, "dist"))).map(async name => [name, await readFile(join(root, "dist", name), "utf8")])));
}

test("Claude bridge patches only the reviewed assembly chain, reuses its receipt and restores exact bytes", async () => {
  const root = await fakeCore();
  const agentDir = await enrolledAgent();
  const plan = await prepareClaudeAdapter(agentDir, "main", runtimePath, root);
  assert.deepEqual(plan.files.map(file => file.path.split("/").pop()).sort(), ["helpers-test.mjs", "system-prompt-test.mjs"]);
  await installClaudeAdapter(agentDir, plan);
  const status = await claudeAdapterStatus(agentDir);
  assert.equal(status.state, "patched");
  assert.match(status.coreIntegrity, /restore before updating OpenClaw/);
  const patched = await readDist(root);
  assert.equal(patched["system-prompt-config-test.mjs"], chunks["system-prompt-config-test.mjs"]);
  assert.equal(patched["unrelated-test.mjs"], chunks["unrelated-test.mjs"]);
  // Re-sync recomputes from the backup, never by patching a patched chunk.
  const again = await prepareClaudeAdapter(agentDir, "main", runtimePath, root);
  assert.deepEqual(again.files.map(file => file.patched), plan.files.map(file => file.patched));
  await installClaudeAdapter(agentDir, again);
  assert.deepEqual(await readDist(root), patched);

  const restored = await restoreClaudeAdapter(agentDir);
  assert.deepEqual(restored.superseded, []);
  assert.deepEqual(await readDist(root), chunks);
  assert.equal((await claudeAdapterStatus(agentDir)).state, "original");
});

test("Claude bridge refuses unreviewed functions, duplicate definitions and foreign edits", async () => {
  const agentDir = await enrolledAgent();
  const changed = await fakeCore("2026.10.6", { ...chunks, "system-prompt-test.mjs": chunks["system-prompt-test.mjs"].replace("## Execution Bias", "## Execution Bias!") });
  await assert.rejects(prepareClaudeAdapter(agentDir, "main", runtimePath, changed), /Unsupported OpenClaw Claude assembly: buildAgentSystemPrompt; review/);
  const duplicate = await fakeCore("2026.10.6", { ...chunks, "helpers-copy.mjs": chunks["helpers-test.mjs"] });
  await assert.rejects(prepareClaudeAdapter(agentDir, "main", runtimePath, duplicate), /layout: buildCliAgentSystemPrompt/);

  const root = await fakeCore();
  await installClaudeAdapter(agentDir, await prepareClaudeAdapter(agentDir, "main", runtimePath, root));
  const helper = join(root, "dist", "helpers-test.mjs");
  await writeFile(helper, (await readFile(helper, "utf8")) + "\n// someone else\n");
  assert.equal((await claudeAdapterStatus(agentDir)).state, "changed");
  await assert.rejects(prepareClaudeAdapter(agentDir, "main", runtimePath, root), /changed by another writer/);
  await assert.rejects(restoreClaudeAdapter(agentDir), /Foreign OpenClaw core edit/);
});

test("after an OpenClaw update the replaced chunks belong to the updater; restore skips them and re-sync starts fresh", async () => {
  const root = await fakeCore();
  const agentDir = await enrolledAgent();
  await installClaudeAdapter(agentDir, await prepareClaudeAdapter(agentDir, "main", runtimePath, root));
  // Simulate an update: new version, reinstalled originals under new chunk names.
  for (const name of Object.keys(chunks)) await writeFile(join(root, "dist", name), "export {};\n");
  const renamed = Object.fromEntries(Object.entries(chunks).map(([name, source]) => [name.replace("-test", "-next"), source.replaceAll("-test.mjs", "-next.mjs")]));
  for (const [name, source] of Object.entries(renamed)) await writeFile(join(root, "dist", name), source);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "openclaw", version: "2026.10.9" }));
  assert.equal((await claudeAdapterStatus(agentDir)).state, "changed");
  // No recorded chunk holds this adapter's bytes any more: restore plans nothing.
  const restored = await restoreClaudeAdapter(agentDir);
  assert.deepEqual(restored, { ownership: "superseded", files: [], superseded: [], restartRequired: false });
  assert.equal(await readFile(join(root, "dist", "helpers-test.mjs"), "utf8"), "export {};\n");
  const plan = await prepareClaudeAdapter(agentDir, "main", runtimePath, root);
  assert.deepEqual(plan.files.map(file => file.path.split("/").pop()).sort(), ["helpers-next.mjs", "system-prompt-next.mjs"]);
  await installClaudeAdapter(agentDir, plan);
  assert.equal((await claudeAdapterStatus(agentDir)).state, "patched");
});

test("patched CLI assembly manages only the enrolled agent on claude-cli and fails closed on tampering", async () => {
  const root = await fakeCore();
  const agentDir = await enrolledAgent();
  const plan = await prepareClaudeAdapter(agentDir, "main", runtimePath, root);
  const helper = plan.files.find(file => file.path.endsWith("helpers-test.mjs")).patched;
  const captured = [];
  let loaded = runtime;
  const context = vm.createContext({
    unblockClaudeCreateRequire: () => () => loaded,
    buildConfiguredAgentSystemPrompt: params => { captured.push(params); return "RENDERED"; },
    resolveDefaultModelForAgent: () => ({ provider: "anthropic", model: "claude-opus-5" }),
    buildSystemPromptParams: () => ({ runtimeInfo: {}, userTimezone: "UTC", userDate: "2026-11-01" }),
    resolveRuntimeOsLabel: () => "macOS", detectRuntimeShell: () => "zsh", os: { arch: () => "arm64" }, process: { version: "v22" },
    isAcpRuntimeSpawnAvailable: () => false, listRegisteredPluginAgentPromptGuidance: () => [],
  });
  vm.runInContext(helper.replace(/^import .*;\n/gmu, "").replace(/^export .*;\n/gmu, "").replace("import.meta.url", '"file:///helpers.mjs"'), context);
  const config = { plugins: { entries: { "unblock-codex-prompt": { enabled: true, config: { frozenContext: true } } } } };
  const build = overrides => { captured.length = 0; context.buildCliAgentSystemPrompt({ config, agentId: "main", workspaceDir: "/w", modelDisplay: "claude-cli/claude-opus-5", tools: [], ...overrides }); return captured[0]; };

  const managed = build({}).unblockManagedClaude;
  assert.match(managed.prompt, /^FLEET POLICY/);
  assert.doesNotMatch(managed.prompt, /CODEX POLICY|skills catalog/i);
  assert.equal(managed.sha256, sha256(managed.prompt));
  for (const overrides of [{ agentId: "other" }, { modelDisplay: "gemini-cli/gemini-3" }, { modelDisplay: "anthropic/claude-opus-5" },
    { config: { plugins: { entries: { "unblock-codex-prompt": { enabled: false, config: { frozenContext: true } } } } } }]) {
    assert.equal("unblockManagedClaude" in build(overrides), false);
  }
  await writeFile(join(agentDir, "codex-home", "unblock-codex-prompt.md"), "EDITED OUTSIDE SYNC");
  assert.throws(() => build({}), /Frozen prompt changed outside sync/);
  // After a plugin rollback without restore the older runtime lacks the export: render upstream.
  const { readClaudeManagedPrompt: _missing, ...olderRuntime } = runtime;
  loaded = olderRuntime;
  assert.equal("unblockManagedClaude" in build({}), false);
});

test("ownership reflects disk: partial restore is still owned; a clean restore allows another OpenClaw root; updates supersede", async () => {
  const { claudeAdapterOwnership } = await import("../dist/claude-adapter.js");
  const { restorePrompt } = await import("../dist/manager.js");
  const agentDir = await enrolledAgent();
  assert.equal(await claudeAdapterOwnership(agentDir), "none");
  const first = await fakeCore();
  const plan = await prepareClaudeAdapter(agentDir, "main", runtimePath, first);
  await installClaudeAdapter(agentDir, plan);
  assert.equal(await claudeAdapterOwnership(agentDir), "patched");

  // Partial restore: one chunk back to original, one still patched.
  await writeFile(plan.files[0].path, plan.files[0].original);
  assert.equal((await claudeAdapterStatus(agentDir)).state, "partial");
  assert.equal(await claudeAdapterOwnership(agentDir), "patched");
  const second = await fakeCore();
  await assert.rejects(prepareClaudeAdapter(agentDir, "main", runtimePath, second), /Restore the previous Claude adapter before changing OpenClaw installations/);

  await restorePrompt({ agentDir, prompt: "" });
  await restoreClaudeAdapter(agentDir);
  assert.equal(await claudeAdapterOwnership(agentDir), "restored");
  // Same chunk basenames, so the retained backups are replaced rather than treated as foreign.
  await installClaudeAdapter(agentDir, await prepareClaudeAdapter(agentDir, "main", runtimePath, second));
  assert.equal((await claudeAdapterStatus(agentDir)).openclawRoot, second);
  assert.deepEqual(await readDist(first), chunks);
  await restoreClaudeAdapter(agentDir);
  assert.deepEqual(await readDist(second), chunks);

  // An update replacing patched chunks leaves no plugin bytes behind: superseded, not owned.
  await installClaudeAdapter(agentDir, await prepareClaudeAdapter(agentDir, "main", runtimePath, second));
  for (const name of Object.keys(chunks)) await writeFile(join(second, "dist", name), "export {};\n");
  await writeFile(join(second, "package.json"), JSON.stringify({ name: "openclaw", version: "2026.10.9" }));
  assert.equal(await claudeAdapterOwnership(agentDir), "superseded");
  await writeFile(join(second, "package.json"), JSON.stringify({ name: "openclaw", version: "2026.10.6" }));
  assert.equal(await claudeAdapterOwnership(agentDir), "changed");
});
