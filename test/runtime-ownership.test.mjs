import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import plugin from "../dist/index.js";
import { codexAdapterOwnership } from "../dist/adapter.js";
import { claudeAdapterOwnership, installClaudeAdapter, prepareClaudeAdapter } from "../dist/claude-adapter.js";
import { compilePrompt } from "../dist/compiler.js";
import { readEnrollment, restorePrompt, sha256, syncPrompt } from "../dist/manager.js";
import { refreshCatalog } from "../dist/catalog.js";
import { refreshCodexSkills } from "../dist/skills.js";
import { readPromptPointer, setPromptPointer } from "../dist/toml.js";

const { Command } = createRequire(import.meta.resolve("openclaw/plugin-sdk/plugin-entry"))("commander");
const entryPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const runtimePath = fileURLToPath(new URL("../dist/runtime.js", import.meta.url));
const claudeFixture = JSON.parse(await readFile(new URL("./fixtures/claude-assembly.json", import.meta.url), "utf8"));
const codexFixture = JSON.parse(await readFile(new URL("./fixtures/adapter-refreshable.json", import.meta.url), "utf8"));
const codexBundle = (name, source) => source + (name.startsWith("thread-requests-") ? "\nexport { buildDeveloperInstructions };\n" : "");

async function readTree(dir) {
  return Object.fromEntries(await Promise.all((await readdir(dir)).sort().map(async name => [name, await readFile(join(dir, name), "utf8")])));
}

async function fakeCore(root) {
  const f = claudeFixture.functions;
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "openclaw", version: "2026.10.6" }));
  await writeFile(join(root, "dist", "helpers-test.mjs"), `import { t as buildConfiguredAgentSystemPrompt } from "./system-prompt-config-test.mjs";\n${f.buildCliAgentSystemPrompt}\nexport { buildCliAgentSystemPrompt as t };\n`);
  await writeFile(join(root, "dist", "system-prompt-config-test.mjs"), `import { n as buildAgentSystemPrompt } from "./system-prompt-test.mjs";\n${f.buildConfiguredAgentSystemPrompt}\nexport { buildConfiguredAgentSystemPrompt as t };\n`);
  await writeFile(join(root, "dist", "system-prompt-test.mjs"), `${f.buildAgentSystemPrompt}\nexport { buildAgentSystemPrompt as n };\n`);
  return root;
}

async function fakeCodex(dir) {
  await mkdir(join(dir, "dist"), { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "@openclaw/codex", version: "2026.10.8" }));
  for (const [name, source] of Object.entries(codexFixture.bundles)) await writeFile(join(dir, "dist", name), codexBundle(name, source));
  return dir;
}

const resolverFor = id => ({ runtime: { modelConfig: { resolveModelRuntimePolicy: () => ({ policy: { id } }) } } });

async function setup(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "runtime-ownership-"));
  const agentDir = join(root, "agent");
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "SOUL.md"), "SOUL");
  t.mock.method(console, "log", () => {});
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response("FLEET", { headers: { "content-type": "text/plain", "x-prompt-revision": sha256("FLEET") } });
  const config = ({ grant = false, appServer } = {}) => ({
    agents: { list: [{ id: "main", agentDir, workspace, model: "anthropic/claude-opus-5" }] },
    plugins: { entries: {
      ...appServer ? { codex: { config: { appServer } } } : {},
      "unblock-codex-prompt": { enabled: true, ...grant ? { hooks: { allowConversationAccess: true } } : {},
        config: { frozenContext: true, promptUrl: "https://example.test/prompt" } },
    } },
  });
  const run = async (cfg, api, ...args) => {
    let registerCli;
    plugin.register({ source: entryPath, config: cfg, registerService() {}, on() {}, registerCli: handler => { registerCli = handler; }, ...api });
    const program = new Command();
    program.exitOverride();
    registerCli({ program, config: cfg });
    await program.parseAsync(["node", "fixture", "codex-prompt", ...args]);
  };
  // A packaged entry without its runtime module: a sync that reaches the Claude adapter stops there,
  // so these CLI tests never patch the development OpenClaw dependency.
  const detached = { source: join(root, "detached", "index.js") };
  return { root, agentDir, workspace, config, run, detached };
}

async function enrollClaude(agentDir, workspace, core) {
  const compiled = await compilePrompt(null, workspace, { text: "FLEET", url: "https://example.test/prompt?runtime=claude", revision: sha256("FLEET"), checkedAt: 0 });
  await syncPrompt({ agentDir, ...compiled }, { runtimes: ["claude-cli"] });
  await installClaudeAdapter(agentDir, await prepareClaudeAdapter(agentDir, "main", runtimePath, core));
}

test("restore removes Claude: an interrupted restore refuses implicit removal; a completed one lets Codex-only sync proceed without Claude", async t => {
  const { root, agentDir, workspace, config, run } = await setup(t);
  const core = await fakeCore(join(root, "core"));
  const coreOriginal = await readTree(join(core, "dist"));
  const codexDir = await fakeCodex(join(root, "codex"));
  await enrollClaude(agentDir, workspace, core);

  // Interrupted restore: enrollment paused, core still holds the adapter.
  await restorePrompt({ agentDir, prompt: "" });
  assert.equal(await claudeAdapterOwnership(agentDir), "patched");
  const codexOnly = config();
  await assert.rejects(run(codexOnly, resolverFor("codex"), "sync", "--codex-plugin-dir", codexDir), /still holds the Claude CLI adapter[^]*restore to finish/);
  assert.deepEqual((await readEnrollment(agentDir)).runtimes, ["claude-cli"]);
  await assert.rejects(readFile(join(agentDir, "codex-home", "config.toml")), /ENOENT/);

  await run(codexOnly, {}, "restore");
  assert.deepEqual(await readTree(join(core, "dist")), coreOriginal);
  assert.equal(await claudeAdapterOwnership(agentDir), "restored");

  // The retained Claude receipt is rollback evidence: no grant demanded, Claude not re-enrolled.
  await run(codexOnly, resolverFor("codex"), "sync", "--codex-plugin-dir", codexDir);
  assert.deepEqual(await readEnrollment(agentDir), { active: true, previousPointer: null, runtimes: ["codex"] });
  assert.deepEqual(await readTree(join(core, "dist")), coreOriginal);
  assert.equal(await codexAdapterOwnership(agentDir), "patched");

  // After a clean restore, moving to another Codex package is not a dead end.
  await run(codexOnly, {}, "restore");
  assert.equal(await codexAdapterOwnership(agentDir), "restored");
  const movedDir = await fakeCodex(join(root, "codex-moved"));
  await run(codexOnly, resolverFor("codex"), "sync", "--codex-plugin-dir", movedDir);
  for (const [name, source] of Object.entries(codexFixture.bundles)) assert.equal(await readFile(join(codexDir, "dist", name), "utf8"), codexBundle(name, source));
  assert.notEqual(await readFile(join(movedDir, "dist", "thread-requests-reviewed.mjs"), "utf8"), codexBundle("thread-requests-reviewed.mjs", codexFixture.bundles["thread-requests-reviewed.mjs"]));
  assert.equal(await codexAdapterOwnership(agentDir), "patched");
});

test("restore removes Codex: a restored Codex receipt and unsupported Codex settings do not hold a Claude-only sync", async t => {
  const { root, agentDir, config, run, detached } = await setup(t);
  const codexDir = await fakeCodex(join(root, "codex"));
  await run(config(), resolverFor("codex"), "sync", "--codex-plugin-dir", codexDir);
  await run(config(), {}, "restore");
  assert.equal(await codexAdapterOwnership(agentDir), "restored");

  // The operator moves Codex to a user-scoped home and the agent to Claude CLI. Selecting Codex
  // would fail its settings check; the sync instead reaches the Claude adapter (stopped here).
  const claudeOnly = config({ grant: true, appServer: { homeScope: "user" } });
  await assert.rejects(run(claudeOnly, { ...resolverFor("claude-cli"), ...detached }, "sync"), /Missing durable plugin runtime/);
  assert.deepEqual(await readEnrollment(agentDir), { active: false, previousPointer: null, runtimes: ["codex"] });
  // Codex settings are still enforced when Codex is selected.
  await assert.rejects(run(claudeOnly, resolverFor("codex"), "sync", "--codex-plugin-dir", codexDir), /agent-scoped local stdio/);
  assert.equal(await codexAdapterOwnership(agentDir), "restored");
});

test("Codex settings are validated by sync, reported by status, and never block a first Claude enrollment or restore", async t => {
  const { root, agentDir, config, run, detached } = await setup(t);
  const userScoped = { appServer: { homeScope: "user" } };
  const logs = [];
  t.mock.method(console, "log", value => logs.push(value));
  // Fresh Claude-only target on a Gateway whose Codex is user-scoped.
  await run(config(userScoped), {}, "status");
  assert.equal(JSON.parse(logs.at(-1)).enrolled, false);
  await assert.rejects(run(config({ ...userScoped, grant: true }), { ...resolverFor("claude-cli"), ...detached }, "sync"), /Missing durable plugin runtime/);
  await assert.rejects(run(config(userScoped), resolverFor("codex"), "sync", "--codex-plugin-dir", join(root, "codex")), /agent-scoped local stdio/);
  await assert.rejects(readdir(agentDir), /ENOENT/);

  // Codex enrolled while supported, then the operator switches Codex to a user-scoped home.
  const codexDir = await fakeCodex(join(root, "codex"));
  await run(config(), resolverFor("codex"), "sync", "--codex-plugin-dir", codexDir);
  await run(config(userScoped), {}, "status");
  const status = JSON.parse(logs.at(-1));
  assert.equal(status.ready, false);
  assert.match(status.codexConfigError, /agent-scoped local stdio/);
  let service;
  plugin.register({ config: config(userScoped), registerService: value => { service = value; }, registerCli() {}, on() {} });
  const serviceLogs = [];
  await service.start({ config: config(userScoped), logger: { info: value => serviceLogs.push(value), error: value => serviceLogs.push(value) } });
  await service.stop();
  assert.match(serviceLogs.join("\n"), /Codex management is not effective: Only agent-scoped local stdio/);

  // Restore undoes owned changes without requiring the current settings to be supported...
  const pointerPath = join(agentDir, "codex-home", "config.toml");
  await run(config(userScoped), {}, "restore");
  assert.equal(readPromptPointer(await readFile(pointerPath, "utf8")), null);
  for (const [name, source] of Object.entries(codexFixture.bundles)) assert.equal(await readFile(join(codexDir, "dist", name), "utf8"), codexBundle(name, source));

  // ...and still refuses foreign edits.
  await run(config(), resolverFor("codex"), "sync");
  const patchedPath = join(codexDir, "dist", "thread-requests-reviewed.mjs");
  await writeFile(patchedPath, (await readFile(patchedPath, "utf8")) + "\n// someone else\n");
  await assert.rejects(run(config(userScoped), {}, "restore"), /Foreign adapter edit/);
});

async function updateCodex(dir, version = "2026.10.9") {
  // An updater replaces the package: new bundle names, old patched files gone.
  for (const name of await readdir(join(dir, "dist"))) if (name.endsWith(".mjs")) await rm(join(dir, "dist", name));
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "@openclaw/codex", version }));
  for (const [name, source] of Object.entries(codexFixture.bundles)) await writeFile(join(dir, "dist", name.replace("-reviewed", "-next")), codexBundle(name, source));
}

test("a receipt retained after a Codex restore never blocks a later restore; a Codex update supersedes it", async t => {
  const { root, agentDir, workspace, config, run } = await setup(t);
  const codexDir = await fakeCodex(join(root, "codex"));
  await run(config(), resolverFor("codex"), "sync", "--codex-plugin-dir", codexDir);
  await run(config(), {}, "restore");
  await updateCodex(codexDir);
  assert.equal(await codexAdapterOwnership(agentDir), "superseded");
  // The agent moves to Claude; restore must still be able to undo Claude management.
  const core = await fakeCore(join(root, "core"));
  const coreOriginal = await readTree(join(core, "dist"));
  await enrollClaude(agentDir, workspace, core);
  await run(config(), {}, "restore");
  assert.equal((await readEnrollment(agentDir)).active, false);
  assert.deepEqual(await readTree(join(core, "dist")), coreOriginal);
  // And Codex can be enrolled again against the updated package.
  await run(config(), resolverFor("codex"), "sync", "--codex-plugin-dir", codexDir);
  assert.equal(await codexAdapterOwnership(agentDir), "patched");
  await run(config(), {}, "restore");
  assert.equal(await codexAdapterOwnership(agentDir), "restored");
});

/** A managed skills block and an active model catalog in this agent's Codex config. */
async function seedCodexSettings(agentDir) {
  const plugin = join(agentDir, "codex-home", "plugins", "cache", "openai-curated-remote", "pages", "0.1.18");
  await mkdir(join(plugin, ".codex-plugin"), { recursive: true });
  await writeFile(join(plugin, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "pages", skills: "./skills/" }));
  await mkdir(join(plugin, "skills", "write-page"), { recursive: true });
  await writeFile(join(plugin, "skills", "write-page", "SKILL.md"), '---\nname: write-page\ndescription: "fixture"\n---\n\nBody.\n');
  assert.deepEqual((await refreshCodexSkills(agentDir, ["pages"])).disabled, ["pages:write-page"]);
  const catalog = { models: [{ slug: "fixture", base_instructions: "keep", supported_reasoning_levels: [], model_messages: null }] };
  assert.equal((await refreshCatalog(agentDir, { fetchCatalog: async () => catalog, now: 1000 })).restartRequired, true);
}

test("restore refuses a foreign Codex edit, or a foreign prompt pointer, before changing anything", async t => {
  const { root, agentDir, workspace, config, run } = await setup(t);
  const codexDir = await fakeCodex(join(root, "codex"));
  await run(config(), resolverFor("codex"), "sync", "--codex-plugin-dir", codexDir);
  const core = await fakeCore(join(root, "core"));
  await enrollClaude(agentDir, workspace, core);
  await seedCodexSettings(agentDir);
  const home = join(agentDir, "codex-home");
  const configPath = join(home, "config.toml");
  const catalogFiles = [".unblock-codex-catalog.json", "unblock-codex-models.json"];
  const patchedCore = await readTree(join(core, "dist"));
  const patchedCodex = await readTree(join(codexDir, "dist"));
  const catalog = Object.fromEntries(await Promise.all(catalogFiles.map(async name => [name, await readFile(join(home, name), "utf8")])));
  assert.equal(JSON.parse(catalog[".unblock-codex-catalog.json"]).active, true);
  const expectUnchanged = async (configText) => {
    assert.deepEqual(await readEnrollment(agentDir), { active: true, previousPointer: null, runtimes: ["codex", "claude-cli"] });
    assert.deepEqual(await readTree(join(core, "dist")), patchedCore);
    assert.equal(await readFile(configPath, "utf8"), configText);
    for (const name of catalogFiles) assert.equal(await readFile(join(home, name), "utf8"), catalog[name]);
  };
  const managedConfig = await readFile(configPath, "utf8");
  assert.match(managedConfig, /pages:write-page/);
  // Same package version, different bytes: not an update, so restore refuses.
  const edited = join(codexDir, "dist", "thread-requests-reviewed.mjs");
  await writeFile(edited, patchedCodex["thread-requests-reviewed.mjs"] + "\n// someone else\n");
  await assert.rejects(run(config(), {}, "restore"), /Foreign adapter edit/);
  await expectUnchanged(managedConfig);
  await writeFile(edited, patchedCodex["thread-requests-reviewed.mjs"]);
  // A foreign pointer is refused before either bridge, the skills block or the catalog changes.
  const foreignConfig = setPromptPointer(managedConfig, "/someone/else.md");
  await writeFile(configPath, foreignConfig);
  await assert.rejects(run(config(), {}, "restore"), /changed by another writer/);
  await expectUnchanged(foreignConfig);
  assert.deepEqual(await readTree(join(codexDir, "dist")), patchedCodex);

  // With the pointer back, restore removes every owned component.
  await writeFile(configPath, managedConfig);
  await run(config(), {}, "restore");
  assert.equal((await readEnrollment(agentDir)).active, false);
  assert.doesNotMatch(await readFile(configPath, "utf8"), /pages:write-page/);
  assert.equal(JSON.parse(await readFile(join(home, ".unblock-codex-catalog.json"), "utf8")).active, false);
  assert.equal(await codexAdapterOwnership(agentDir), "restored");
  assert.equal(await claudeAdapterOwnership(agentDir), "restored");
});

test("a retained Claude receipt does not block a Codex-only restore after a same-version core edit", async t => {
  const { root, agentDir, workspace, config, run } = await setup(t);
  const core = await fakeCore(join(root, "core"));
  await enrollClaude(agentDir, workspace, core);
  await run(config(), {}, "restore");
  assert.equal(await claudeAdapterOwnership(agentDir), "restored");
  const codexDir = await fakeCodex(join(root, "codex"));
  await run(config(), resolverFor("codex"), "sync", "--codex-plugin-dir", codexDir);
  assert.deepEqual(await readEnrollment(agentDir), { active: true, previousPointer: null, runtimes: ["codex"] });
  // Someone edits a restored core chunk without changing the OpenClaw version.
  const chunk = join(core, "dist", "helpers-test.mjs");
  const edited = (await readFile(chunk, "utf8")) + "\n// someone else\n";
  await writeFile(chunk, edited);
  assert.equal(await claudeAdapterOwnership(agentDir), "changed");
  await run(config(), {}, "restore");
  assert.equal((await readEnrollment(agentDir)).active, false);
  assert.equal(await codexAdapterOwnership(agentDir), "restored");
  assert.equal(await readFile(chunk, "utf8"), edited);
});

test("a restored enrollment is saved in a schema older plugins read, keeps its runtimes, and starts without false alarms", async t => {
  const { root, agentDir, workspace, config, run } = await setup(t);
  const core = await fakeCore(join(root, "core"));
  await enrollClaude(agentDir, workspace, core);
  await run(config(), {}, "restore");
  const state = JSON.parse(await readFile(join(agentDir, "codex-home", ".unblock-codex-prompt.json"), "utf8"));
  assert.deepEqual(state, { schema: 1, active: false, previousPointer: null, runtimes: ["claude-cli"] });
  assert.deepEqual(await readEnrollment(agentDir), { active: false, previousPointer: null, runtimes: ["claude-cli"] });
  // Active Claude enrollment stays schema 2, so an older plugin refuses it rather than mismanaging it.
  await enrollClaude(agentDir, workspace, core);
  assert.equal(JSON.parse(await readFile(join(agentDir, "codex-home", ".unblock-codex-prompt.json"), "utf8")).schema, 2);
  // The grant was removed after enrollment: the gate is not registered, so nothing is blocked.
  const startErrors = async cfg => {
    let started;
    plugin.register({ config: cfg, registerService: value => { started = value; }, registerCli() {}, on() {} });
    const errors = [];
    await started.start({ config: cfg, logger: { info() {}, error: value => errors.push(value) } });
    await started.stop();
    return errors;
  };
  const ungranted = await startErrors(config());
  assert.equal(ungranted.length, 1);
  assert.match(ungranted[0], /final-adoption gate is not registered[^]*runs are not checked/);
  assert.doesNotMatch(ungranted[0], /blocked/);
  await run(config(), {}, "restore");
  let service;
  plugin.register({ config: config({ grant: true }), registerService: value => { service = value; }, registerCli() {}, on() {} });
  const errors = [];
  await service.start({ config: config({ grant: true }), logger: { info() {}, error: value => errors.push(value) } });
  await service.stop();
  assert.deepEqual(errors, []);
});

/** plugin 0.3.x's enrollment check (manager parseEnrollment; runtime readFrozenPolicy checks the same fields). */
function parseEnrollment03(source) {
  const value = JSON.parse(source);
  if (!value || typeof value !== "object" || !("schema" in value) || value.schema !== 1 ||
      !("active" in value) || typeof value.active !== "boolean" || !("previousPointer" in value) ||
      (value.previousPointer !== null && typeof value.previousPointer !== "string")) {
    throw new Error("Invalid prompt enrollment state");
  }
  return { schema: 1, active: value.active, previousPointer: value.previousPointer };
}

test("an active Codex and Claude enrollment is schema 1, which 0.3.x reads as Codex; active Claude-only stays schema 2", async t => {
  const { root, workspace } = await setup(t);
  const compiled = await compilePrompt("FLEET", workspace,
    { text: "FLEET", url: "https://example.test/prompt?runtime=claude", revision: sha256("FLEET"), checkedAt: 0 });
  compiled.bundle.remotePrompt = { url: "https://example.test/prompt", revision: sha256("FLEET") };
  const statePath = agentDir => join(agentDir, "codex-home", ".unblock-codex-prompt.json");

  const both = join(root, "both");
  await syncPrompt({ agentDir: both, ...compiled }, { runtimes: ["codex", "claude-cli"] });
  const state = await readFile(statePath(both), "utf8");
  assert.deepEqual(JSON.parse(state), { schema: 1, active: true, previousPointer: null, runtimes: ["codex", "claude-cli"] });
  assert.deepEqual(parseEnrollment03(state), { schema: 1, active: true, previousPointer: null });
  assert.deepEqual(await readEnrollment(both), { active: true, previousPointer: null, runtimes: ["codex", "claude-cli"] });

  const claudeOnly = join(root, "claude-only");
  await syncPrompt({ agentDir: claudeOnly, ...compiled }, { runtimes: ["claude-cli"] });
  const claudeState = await readFile(statePath(claudeOnly), "utf8");
  assert.deepEqual(JSON.parse(claudeState), { schema: 2, active: true, previousPointer: null, runtimes: ["claude-cli"] });
  assert.throws(() => parseEnrollment03(claudeState), /Invalid prompt enrollment state/);
  // Once paused, it is schema 1 again, so 0.3.x can read it after a rollback.
  await restorePrompt({ agentDir: claudeOnly, prompt: "" });
  assert.deepEqual(parseEnrollment03(await readFile(statePath(claudeOnly), "utf8")), { schema: 1, active: false, previousPointer: null });
});
