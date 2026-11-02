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
import { readClaudeManagedContext, readFrozenPolicy } from "../dist/runtime.js";
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
  const managed = readClaudeManagedContext(agentDir);
  assert.equal(managed.policy, "FLEET POLICY");
  assert.match(managed.agentContext, /^## Memory reference\n/);
  // Workspace files are read by the prompt hook on every turn, never stored with the policy.
  assert.doesNotMatch(JSON.stringify(managed), /skills catalog|SOUL A/i);

  const refreshed = await refreshSharedPrompt(agentDir, { claude: async () => ({ prompt: "FLEET POLICY B", source: { url: "https://example.test/prompt?runtime=claude", revision: sha256("FLEET POLICY B") } }) });
  assert.equal(refreshed.nextClaudeProcess, true);
  assert.equal("newSessionRequired" in refreshed, false);
  assert.equal(readClaudeManagedContext(agentDir).policy, "FLEET POLICY B");

  await restorePrompt({ agentDir, prompt: "" });
  assert.equal(readClaudeManagedContext(agentDir), null);
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
  assert.equal(readClaudeManagedContext(codexOnly), null);
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

test("CLI sync requires a detected runtime and a registrable prompt hook before writing state", async t => {
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
  // OpenClaw registers before_prompt_build for a non-bundled plugin only with conversation access.
  await assert.rejects(run({ ...base, plugins: { entries: { "unblock-codex-prompt": entry } } }, resolver),
    /Claude CLI management needs its prompt hook: OpenClaw registers [^]*hooks\.allowConversationAccess: true/);
  // And it blocks prompt-injection hooks when injection is disabled.
  await assert.rejects(run({ ...base, plugins: { entries: { "unblock-codex-prompt": { ...entry, hooks: { allowConversationAccess: true, allowPromptInjection: false } } } } }, resolver),
    /hooks\.allowPromptInjection is false, which blocks the before_prompt_build hook[^]*remove it or set it to true/);
  await assert.rejects(readdir(agentDir), /ENOENT/);
});
