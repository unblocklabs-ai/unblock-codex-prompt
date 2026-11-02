import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import plugin from "../dist/index.js";
import { compilePrompt } from "../dist/compiler.js";
import { readEnrollment, refreshSharedPrompt, restorePrompt, sha256, syncPrompt } from "../dist/manager.js";
import { checkClaudeAdoption, readClaudeManagedPrompt, readFrozenPolicy } from "../dist/runtime.js";
import { configuredModelRefs, detectConfiguredRuntimes } from "../dist/runtimes.js";
import { readPromptPointer } from "../dist/toml.js";

const { Command } = createRequire(import.meta.resolve("openclaw/plugin-sdk/plugin-entry"))("commander");
const remote = text => ({ prompt: text, source: { url: "https://example.test/prompt", revision: sha256(text) } });

const claudePolicy = text => ({ text, url: "https://example.test/prompt?runtime=claude", revision: sha256(text), checkedAt: 0 });

/** Claude-only by default; pass a Codex policy to compile the Codex layout (with Claude too when `claude` is set). */
async function compiled(workspace, { claude = "FLEET POLICY", codex } = {}) {
  const result = await compilePrompt(codex ?? null, workspace, claude === null ? undefined : claudePolicy(claude));
  if (codex !== undefined) result.bundle.remotePrompt = { ...remote(codex).source, checkedAt: 0 };
  return result;
}

test("Claude-only enrollment writes no Codex configuration and refreshes/restores without a pointer", async () => {
  const agentDir = await mkdtemp(join(await realpath(tmpdir()), "claude-only-"));
  await writeFile(join(agentDir, "SOUL.md"), "SOUL A");
  const result = await syncPrompt({ agentDir, ...await compiled(agentDir) }, { runtimes: ["claude-cli"] });
  assert.deepEqual(result.runtimes, ["claude-cli"]);
  assert.equal(result.configChanged, false);
  const home = join(agentDir, "codex-home");
  assert.equal((await readdir(home)).includes("config.toml"), false);
  assert.deepEqual(JSON.parse(await readFile(join(home, ".unblock-codex-prompt.json"), "utf8")), { schema: 2, active: true, previousPointer: null, runtimes: ["claude-cli"] });
  assert.throws(() => readFrozenPolicy(agentDir), /Codex bridge installed without Codex enrollment/);
  const managed = readClaudeManagedPrompt(agentDir);
  assert.match(managed.prompt, /^FLEET POLICY\n\n## Memory reference\n/);
  // Identity files are live in the host's project context, never in the managed snapshot.
  assert.doesNotMatch(managed.prompt, /skills catalog|SOUL A/i);

  const refreshed = await refreshSharedPrompt(agentDir, { claude: async () => ({ prompt: "FLEET POLICY B", source: { url: "https://example.test/prompt?runtime=claude", revision: sha256("FLEET POLICY B") } }) });
  assert.equal(refreshed.nextClaudeProcess, true);
  assert.equal("newSessionRequired" in refreshed, false);
  assert.match(readClaudeManagedPrompt(agentDir).prompt, /^FLEET POLICY B\n\n## Memory reference\n/);

  await restorePrompt({ agentDir, prompt: "" });
  assert.equal(readClaudeManagedPrompt(agentDir), null);
  assert.equal((await readdir(home)).includes("config.toml"), false);
});

test("adding Codex to a Claude enrollment captures its pointer; Codex-only state keeps the legacy schema", async () => {
  const agentDir = await mkdtemp(join(await realpath(tmpdir()), "mixed-"));
  const home = join(agentDir, "codex-home");
  await syncPrompt({ agentDir, ...await compiled(agentDir) }, { runtimes: ["claude-cli"] });
  await writeFile(join(home, "config.toml"), 'model_instructions_file = "/custom.md"\n');
  // Adding Codex compiles the Codex layout (with the Claude policy kept in the bundle).
  const both = await compiled(agentDir, { codex: "CODEX POLICY" });
  await assert.rejects(syncPrompt({ agentDir, ...both }, { runtimes: ["codex"] }), /--adopt/);
  await syncPrompt({ agentDir, ...both }, { runtimes: ["codex"], adopt: true });
  assert.deepEqual(await readEnrollment(agentDir), { active: true, previousPointer: "/custom.md", runtimes: ["codex", "claude-cli"] });
  assert.equal(readPromptPointer(await readFile(join(home, "config.toml"), "utf8")), join(home, "unblock-codex-prompt.md"));
  assert.equal(readFrozenPolicy(agentDir), "");
  await restorePrompt({ agentDir, prompt: "" });
  assert.equal(readPromptPointer(await readFile(join(home, "config.toml"), "utf8")), "/custom.md");

  const codexOnly = await mkdtemp(join(await realpath(tmpdir()), "codex-only-"));
  await syncPrompt({ agentDir: codexOnly, ...await compiled(codexOnly, { claude: null, codex: "FLEET POLICY" }) });
  assert.deepEqual(JSON.parse(await readFile(join(codexOnly, "codex-home", ".unblock-codex-prompt.json"), "utf8")), { schema: 1, active: true, previousPointer: null });
  assert.throws(() => readClaudeManagedPrompt(codexOnly), /without Claude CLI enrollment/);
});

test("sync-time detection resolves effective models like OpenClaw and uses its configured-policy resolver", () => {
  const defaults = { model: { primary: "openai/gpt-6", fallbacks: ["openai/gpt-5"] }, models: { "anthropic/claude-haiku-5": {} } };
  const config = { agents: { defaults, list: [{ id: "main", model: "claude-cli/claude-sonnet-5" }, { id: "plain" },
    { id: "own", model: { primary: "anthropic/claude-opus-5", fallbacks: ["google/gemini-3"] }, models: { "openai/gpt-5.5": {} } }, { id: "primary-only", model: { primary: "anthropic/claude-opus-5" } }] } };
  // An agent model replaces the default primary and, unless it lists its own, the default fallbacks.
  // Only the agent's own allowed-model map counts; the Gateway-wide default map does not.
  assert.deepEqual(configuredModelRefs(config, "main"), ["claude-cli/claude-sonnet-5"]);
  assert.deepEqual(configuredModelRefs(config, "plain"), ["openai/gpt-6", "openai/gpt-5"]);
  assert.deepEqual(configuredModelRefs(config, "own"), ["anthropic/claude-opus-5", "google/gemini-3", "openai/gpt-5.5"]);
  assert.deepEqual(configuredModelRefs(config, "primary-only"), ["anthropic/claude-opus-5"]);
  const calls = [];
  const resolve = params => { calls.push(params); return { policy: { id: params.provider === "anthropic" ? "claude-cli" : params.provider === "openai" ? "codex" : undefined } }; };
  // A Claude agent on a Gateway whose default is a Codex model is not enrolled for Codex.
  assert.deepEqual([...detectConfiguredRuntimes(config, "main", resolve).runtimes], ["claude-cli"]);
  assert.deepEqual([...detectConfiguredRuntimes(config, "plain", resolve).runtimes], ["codex"]);
  assert.deepEqual([...detectConfiguredRuntimes(config, "own", resolve).runtimes].sort(), ["claude-cli", "codex"]);
  assert.equal(calls.every(call => call.config === config), true);
  assert.deepEqual([...detectConfiguredRuntimes(config, "main", undefined).runtimes], ["claude-cli"]);
  assert.equal(detectConfiguredRuntimes(config, "own", () => { throw new Error("resolver failure"); }).runtimes.size, 0);
});

test("CLI sync requires a detected runtime and the conversation-access grant before writing state", async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "claude-cli-sync-"));
  const agentDir = join(root, "agent");
  await mkdir(join(root, "workspace"));
  const run = async (config, api = {}) => {
    let registerCli;
    plugin.register({ source: fileURLToPath(new URL("../dist/index.js", import.meta.url)), config, registerService() {}, on() {}, registerCli: handler => { registerCli = handler; }, ...api });
    const program = new Command();
    program.exitOverride();
    registerCli({ program, config });
    await program.parseAsync(["node", "fixture", "codex-prompt", "sync"]);
  };
  const entry = { enabled: true, config: { frozenContext: true, promptUrl: "https://example.test/prompt" } };
  const base = { agents: { list: [{ id: "main", agentDir, workspace: join(root, "workspace"), model: "anthropic/claude-opus-5" }] } };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("must not fetch before validation"); };
  t.after(() => { globalThis.fetch = originalFetch; });
  await assert.rejects(run({ ...base, plugins: { entries: { "unblock-codex-prompt": entry } } }), /No managed runtime detected/);
  const resolver = { runtime: { modelConfig: { resolveModelRuntimePolicy: () => ({ policy: { id: "claude-cli" } }) } } };
  await assert.rejects(run({ ...base, plugins: { entries: { "unblock-codex-prompt": entry } } }, resolver), /hooks.allowConversationAccess: true/);
  await assert.rejects(readdir(agentDir), /ENOENT/);
});

test("final-adoption gate passes managed prompts, reports unmanaged runs and blocks broken management", async () => {
  const agentDir = await mkdtemp(join(await realpath(tmpdir()), "claude-gate-"));
  const config = { agents: { list: [{ id: "main", agentDir, workspace: agentDir }] }, plugins: { entries: { "unblock-codex-prompt": {
    enabled: true, hooks: { allowConversationAccess: true }, config: { frozenContext: true, promptUrl: "https://example.test/prompt" } } } } };
  const hooks = {};
  const logs = [];
  plugin.register({ config, registerService() {}, registerCli() {}, logger: { warn: value => logs.push(value), error: value => logs.push(value) },
    on: (name, handler) => { hooks[name] = handler; } });
  assert.deepEqual(Object.keys(hooks).sort(), ["before_agent_run", "before_prompt_build"]);
  let run = 0;
  // The CLI runner's before_agent_run context carries no provider; preparation marks the run.
  const gate = (event, prepared = { agentId: "main", modelProviderId: "claude-cli" }) => {
    const runId = `run-${++run}`;
    assert.equal(hooks.before_prompt_build({ prompt: "", messages: [] }, { ...prepared, runId }), undefined);
    return hooks.before_agent_run(event, { agentId: prepared.agentId, runId });
  };
  assert.equal(gate({ systemPrompt: "anything" }, { agentId: "main", modelProviderId: "openai" }), undefined);
  assert.equal(gate({ systemPrompt: "anything" }, { agentId: "other", modelProviderId: "claude-cli" }), undefined);
  assert.equal(hooks.before_agent_run({ systemPrompt: "anything" }, { agentId: "main", runId: "never-prepared" }), undefined);
  assert.equal(gate({ systemPrompt: "You are a personal assistant running inside OpenClaw." }), undefined);
  assert.match(logs.at(-1), /not managed; run openclaw codex-prompt sync/);

  await syncPrompt({ agentDir, ...await compiled(agentDir) }, { runtimes: ["claude-cli"] });
  const managed = readClaudeManagedPrompt(agentDir).prompt;
  assert.equal(gate({ systemPrompt: `${managed}\n\n## Runtime\nfacts` }), undefined);
  assert.match(gate({ systemPrompt: "You are a personal assistant running inside OpenClaw.\n" + managed }).reason, /patch is missing or inactive/);
  assert.match(gate({ systemPrompt: managed.replace("FLEET POLICY", "FLEET P0LICY") }).reason, /replaced or altered after assembly/);
  assert.equal(gate({}).outcome, "block");
  await writeFile(join(agentDir, "codex-home", "unblock-codex-prompt.md"), "tampered");
  assert.equal(checkClaudeAdoption(agentDir, managed).outcome, "block");
  assert.doesNotMatch(logs.join("\n"), /FLEET POLICY/);

  for (const grant of [{}, { allowConversationAccess: true, allowPromptInjection: false }]) {
    const ungranted = [];
    plugin.register({ config: { ...config, plugins: { entries: { "unblock-codex-prompt": { ...config.plugins.entries["unblock-codex-prompt"], hooks: grant } } } },
      registerService() {}, registerCli() {}, on: name => ungranted.push(name) });
    assert.deepEqual(ungranted, []);
  }
});

test("a Claude attempt that fails before execution cannot gate a non-Claude fallback sharing its runId", async () => {
  const agentDir = await mkdtemp(join(await realpath(tmpdir()), "claude-fallback-"));
  const config = { agents: { list: [{ id: "main", agentDir, workspace: agentDir }] }, plugins: { entries: { "unblock-codex-prompt": {
    enabled: true, hooks: { allowConversationAccess: true }, config: { frozenContext: true, promptUrl: "https://example.test/prompt" } } } } };
  const hooks = {};
  plugin.register({ config, registerService() {}, registerCli() {}, logger: { warn() {}, error() {} }, on: (name, handler) => { hooks[name] = handler; } });
  await syncPrompt({ agentDir, ...await compiled(agentDir) }, { runtimes: ["claude-cli"] });
  const generic = { systemPrompt: "You are a personal assistant running inside OpenClaw." };
  const prepare = (runId, modelProviderId, agentId = "main") => hooks.before_prompt_build({ prompt: "", messages: [] }, { agentId, runId, modelProviderId });
  // CLI runner contexts carry no provider; embedded and worker contexts name theirs.
  const execute = (runId, event, modelProviderId) => hooks.before_agent_run(event, { agentId: "main", runId, ...modelProviderId ? { modelProviderId } : {} });

  // Claude preparation fails (e.g. auth); the embedded fallback prepares and runs under the same runId.
  prepare("run-a", "claude-cli");
  prepare("run-a", "openai");
  assert.equal(execute("run-a", generic, "openai"), undefined);
  // A fallback that skips prompt-build (exact-prompt or worker paths) is identified by its provider.
  prepare("run-b", "claude-cli");
  assert.equal(execute("run-b", {}, "openai"), undefined);
  assert.equal(execute("run-b", generic), undefined, "the mark was cleared, not left for a later run");
  // A non-target agent's preparation also clears the mark.
  prepare("run-c", "claude-cli");
  prepare("run-c", "claude-cli", "other");
  assert.equal(execute("run-c", generic), undefined);
  // Claude after a non-Claude attempt, or with an explicit claude-cli provider, is still gated.
  prepare("run-d", "openai");
  prepare("run-d", "claude-cli");
  assert.equal(execute("run-d", generic).outcome, "block");
  prepare("run-e", "claude-cli");
  assert.equal(execute("run-e", generic, "claude-cli").outcome, "block");
});
