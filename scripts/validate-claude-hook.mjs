// Checks, against real installed OpenClaw packages, that this plugin's before_prompt_build hook
// replaces the Claude CLI system prompt.
//
//   npm run build
//   node scripts/validate-claude-hook.mjs [/path/to/node_modules/openclaw ...]
//
// Default: the development dependency. Each OpenClaw package is exercised in its own process.
//
// What it runs (real OpenClaw code, loaded from that package's dist):
// - the plugin registry's typed-hook registrar, with this plugin's own register(): the hook is
//   registered with `hooks.allowConversationAccess: true`, and OpenClaw refuses it without that
//   grant or with `allowPromptInjection: false`;
// - the hook runner and resolvePromptBuildHookResult, with the CLI runner's hook context shape;
// - prepareCliTurnPromptContext: the hook's systemPrompt replaces OpenClaw's built prompt, and
//   turn context stays in the user prompt;
// - finalizeCliSystemPrompt where it exists (2026.10.9): only the model identity line is added.
// What it asserts on source (the CLI runner chunk, not executed): the hook context carries
// `modelProviderId: params.provider`, `agentId: sessionAgentId` and `workspaceDir`; the hook result
// is passed to prepareCliTurnPromptContext; afterwards systemPrompt is only finalized; side
// questions and control operations skip the hook.
// What it does not prove: a Claude CLI process receiving the prompt, the rest of the CLI runner's
// preparation, or that no higher-priority plugin returns a systemPrompt first (the first wins).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const self = fileURLToPath(import.meta.url);
const packages = process.argv.slice(2);

if (process.env.UNBLOCK_VALIDATE_CHILD !== "1") {
  const targets = packages.length ? packages : [await (await import(new URL("../dist/compiler.js", import.meta.url).href)).openclawRoot()];
  for (const target of targets) {
    // A private state directory, so nothing reads or writes the operator's OpenClaw state.
    const state = await mkdtemp(join(await realpath(tmpdir()), "openclaw-state-"));
    execFileSync(process.execPath, [self, target], { stdio: "inherit", env: { ...process.env, UNBLOCK_VALIDATE_CHILD: "1", OPENCLAW_STATE_DIR: state } });
  }
  process.exit(0);
}

const root = resolve(packages[0]);
const dist = join(root, "dist");
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const chunks = (await readdir(dist)).filter(name => name.endsWith(".mjs"));
const sources = new Map(await Promise.all(chunks.map(async name => [name, await readFile(join(dist, name), "utf8")])));

/** The chunk that defines and exports `name`, if exactly one does. */
function chunkOf(name) {
  const hits = [...sources].filter(([, source]) => source.includes(`function ${name}(`) && new RegExp(`export \\{[^}]*\\b${name} as \\w+`, "u").test(source));
  return hits.length === 1 ? hits[0] : undefined;
}
async function load(name, required = true) {
  const hit = chunkOf(name);
  if (!hit) { if (required) throw new Error(`OpenClaw ${version}: cannot locate ${name}`); return undefined; }
  const alias = new RegExp(`export \\{[^}]*\\b${name} as (\\w+)`, "u").exec(hit[1])[1];
  return (await import(pathToFileURL(join(dist, hit[0])).href))[alias];
}

const createPluginRegistry = await load("createPluginRegistry");
const createHookRunner = await load("createHookRunner");
const resolvePromptBuildHookResult = await load("resolvePromptBuildHookResult");
const prepareCliTurnPromptContext = await load("prepareCliTurnPromptContext");
const finalizeCliSystemPrompt = await load("finalizeCliSystemPrompt", false);

const plugin = (await import(new URL("../dist/index.js", import.meta.url).href)).default;
const { compilePrompt } = await import(new URL("../dist/compiler.js", import.meta.url).href);
const { sha256, syncPrompt } = await import(new URL("../dist/manager.js", import.meta.url).href);

// An enrolled Claude-only agent with workspace files.
const work = await mkdtemp(join(await realpath(tmpdir()), "claude-hook-"));
const agentDir = join(work, "agent");
const workspace = join(work, "workspace");
await mkdir(workspace, { recursive: true });
await writeFile(join(workspace, "AGENTS.md"), "AGENTS BODY\n");
await writeFile(join(workspace, "SOUL.md"), "SOUL BODY\n");
await writeFile(join(workspace, "MEMORY.md"), "MEMORY BODY\n");
const policy = "CLAUDE FLEET POLICY";
const compiled = await compilePrompt(null, workspace, { text: policy, url: "https://example.test/prompt?runtime=claude", revision: sha256(policy), checkedAt: 0 });
await syncPrompt({ agentDir, ...compiled }, { runtimes: ["claude-cli"] });
const expectedPrefix = [policy, compiled.bundle.agentContext, "## Local media context"].join("\n\n");
const expectedFiles = [`## ${join(workspace, "AGENTS.md")}\nAGENTS BODY`, `## ${join(workspace, "SOUL.md")}\nSOUL BODY`].join("\n\n");

const config = hooks => ({
  agents: { list: [{ id: "main", agentDir, workspace }, { id: "other", agentDir: join(work, "other"), workspace }] },
  plugins: { entries: { "unblock-codex-prompt": { enabled: true, ...hooks ? { hooks } : {},
    config: { frozenContext: true, promptUrl: "https://example.test/prompt" } } } },
});

/** This plugin registered through OpenClaw's own typed-hook registrar, as its plugin loader wires `api.on`. */
function registerPlugin(hooks) {
  const registry = createPluginRegistry({ runtime: { config: { current: () => config(hooks) } }, coreGatewayMethodNames: [] });
  const record = { id: "unblock-codex-prompt", origin: "global", source: join(work, "index.js"), hookCount: 0 };
  const logs = [];
  const log = value => logs.push(String(value));
  plugin.register({ id: record.id, source: record.source, config: config(hooks), logger: { info: log, warn: log, error: log },
    registerService() {}, registerCli() {}, on: (name, handler, opts) => registry.registerTypedHook(record, name, handler, opts, hooks) });
  return { registry: registry.registry, logs };
}

// The registration gate.
for (const hooks of [undefined, { allowConversationAccess: true, allowPromptInjection: false }]) {
  assert.equal(registerPlugin(hooks).registry.typedHooks.length, 0, `${version}: no hook without the grant (${JSON.stringify(hooks)})`);
}
const gate = createPluginRegistry({ runtime: { config: { current: () => ({}) } }, coreGatewayMethodNames: [] });
const record = { id: "unblock-codex-prompt", origin: "global", source: join(work, "index.js"), hookCount: 0 };
gate.registerTypedHook(record, "before_prompt_build", () => undefined, undefined, undefined);
gate.registerTypedHook(record, "before_prompt_build", () => undefined, undefined, { allowConversationAccess: true, allowPromptInjection: false });
assert.equal(gate.registry.typedHooks.length, 0);
assert.match(gate.registry.diagnostics.map(entry => entry.message).join("\n"), /must set plugins\.entries\.unblock-codex-prompt\.hooks\.allowConversationAccess=true[^]*allowPromptInjection=false/u);

const { registry, logs } = registerPlugin({ allowConversationAccess: true });
assert.deepEqual(registry.typedHooks.map(hook => hook.hookName), ["before_prompt_build"]);
const runner = createHookRunner(registry);

// The CLI runner's promptBuildHookContext shape.
const hookResult = (overrides = {}) => resolvePromptBuildHookResult({ config: config({ allowConversationAccess: true }), prompt: "USER TURN", messages: [], hookRunner: runner,
  hookCtx: { runId: `run-${Math.random()}`, agentId: "main", sessionKey: `agent:${overrides.agentId ?? "main"}:main`, sessionId: "session", workspaceDir: workspace,
    modelProviderId: "claude-cli", modelId: "claude-opus-5", trigger: "user", ...overrides } });

const managed = await hookResult();
assert.ok(managed.systemPrompt.startsWith(expectedPrefix), `${version}: policy, memory and local media context`);
assert.ok(managed.systemPrompt.includes(`Generated-media staging directory: ${join(workspace, "media")}\n`), `${version}: run-scoped media directory`);
assert.ok(managed.systemPrompt.endsWith(expectedFiles), `${version}: live workspace files`);
const expected = managed.systemPrompt;
for (const overrides of [{ modelProviderId: "anthropic" }, { modelProviderId: "codex" }, { agentId: "other" }]) {
  assert.equal((await hookResult(overrides)).systemPrompt, undefined, `${version}: unmanaged ${JSON.stringify(overrides)}`);
}

const turn = await prepareCliTurnPromptContext({ prompt: "USER TURN", systemPrompt: "You are a personal assistant running inside OpenClaw.\nOPENCLAW PROMPT",
  privateContext: false, hookResult: managed, prependContext: [managed.prependContext], capabilityToolNames: new Set(), sessionKey: "agent:main:main",
  agentId: "main", backend: {}, isNewSession: true, nativeDelegationTools: [], context: ["RUNTIME FACTS", managed.appendContext] });
assert.equal(turn.systemPrompt, expected, `${version}: prepareCliTurnPromptContext keeps OpenClaw's prompt`);
assert.match(turn.prompt, /^USER TURN\n\nRUNTIME FACTS/u, `${version}: turn context stays in the user prompt`);

let finalized = "not in this version (inline in the CLI runner)";
if (finalizeCliSystemPrompt) {
  const final = finalizeCliSystemPrompt(turn.systemPrompt, "claude-cli/claude-opus-5", undefined);
  assert.ok(final.startsWith(expected), `${version}: finalize keeps the managed prompt first`);
  assert.doesNotMatch(final, /personal assistant running inside OpenClaw|OPENCLAW PROMPT/u);
  assert.match(final.slice(expected.length), /Current model identity: claude-cli\/claude-opus-5\./u);
  finalized = "managed prompt plus OpenClaw's cache boundary and model identity line";
}

// Source assertions on the CLI runner.
const runners = [...sources].filter(([, source]) => source.includes("prepareCliTurnPromptContext({") && source.includes("const promptBuildHookContext = {"));
assert.equal(runners.length, 1, `${version}: one CLI runner chunk`);
const source = runners[0][1];
const context = source.slice(source.indexOf("const promptBuildHookContext = {"), source.indexOf("};", source.indexOf("const promptBuildHookContext = {")));
for (const field of ["agentId: sessionAgentId", "workspaceDir,", "modelProviderId: params.provider"]) assert.ok(context.includes(field), `${version}: hook context ${field}`);
assert.match(source, /const skipsTurnPreparation = isSideQuestion \|\| isControlOperation;/u);
assert.match(source, /hookCtx: promptBuildHookContext,/u);
const call = source.indexOf("prepareCliTurnPromptContext({");
assert.match(source.slice(call, source.indexOf("}));", call)), /\n\t+hookResult: promptBuildHookResult,\n/u, `${version}: hook result reaches the turn context`);
const later = [...source.slice(call).matchAll(/[^.\w]systemPrompt = ([^\n]+)/gu)].map(match => match[1]);
assert.equal(later.length, 1, `${version}: one later systemPrompt assignment`);
assert.match(later[0], /^skipsTurnPreparation \? systemPrompt(?:WithReplacements)? : (?:finalizeCliSystemPrompt\(systemPrompt,|appendModelIdentitySystemPrompt\(\{)/u, `${version}: only finalization follows`);

assert.doesNotMatch(logs.join("\n"), new RegExp(policy, "u"), "prompt text is never logged");
console.log(`OpenClaw ${version} (${root}): before_prompt_build systemPrompt replaces the Claude CLI system prompt; finalize: ${finalized}`);
