import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../dist/index.js";
import { bootstrapMaxChars, includeBootstrap } from "../dist/claude-prompt.js";
import { compilePrompt } from "../dist/compiler.js";
import { restorePrompt, sha256, syncPrompt } from "../dist/manager.js";

const POLICY = "FLEET POLICY";
const claudePolicy = { text: POLICY, url: "https://example.test/prompt?runtime=claude", revision: sha256(POLICY), checkedAt: 0 };

/** The target agent `main` with its workspace, the plugin registered with the hook grant, and a call into its hook. */
async function setup({ hooks = { allowConversationAccess: true }, agent = {}, defaults } = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "claude-prompt-"));
  const agentDir = join(root, "agent");
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const config = {
    agents: { ...defaults ? { defaults } : {}, list: [{ id: "main", agentDir, workspace, ...agent }, { id: "other", agentDir: join(root, "other"), workspace }] },
    plugins: { entries: { "unblock-codex-prompt": { enabled: true, hooks, config: { frozenContext: true, promptUrl: "https://example.test/prompt" } } } },
  };
  const handlers = {};
  const logs = [];
  plugin.register({ config, registerService() {}, registerCli() {}, logger: { info() {}, warn: value => logs.push(`warn ${value}`), error: value => logs.push(`error ${value}`) },
    on: (name, handler) => { handlers[name] = handler; } });
  const call = (ctx = {}) => handlers.before_prompt_build({ prompt: "USER TURN", messages: [] },
    { runId: "run", agentId: "main", sessionKey: "agent:main:main", sessionId: "session", workspaceDir: workspace, modelProviderId: "claude-cli", modelId: "claude-opus-5", trigger: "user", ...ctx });
  const enroll = async (runtimes = ["claude-cli"]) => {
    const compiled = await compilePrompt(runtimes.includes("codex") ? "CODEX POLICY" : null, workspace, claudePolicy);
    if (runtimes.includes("codex")) compiled.bundle.remotePrompt = { url: "https://example.test/prompt", revision: sha256("CODEX POLICY") };
    await syncPrompt({ agentDir, ...compiled }, { runtimes });
    return compiled.bundle.agentContext;
  };
  const write = (name, text) => writeFile(join(workspace, name), text);
  return { root, agentDir, workspace, config, handlers, logs, call, enroll, write };
}

test("the hook carries policy, memory, media staging context and the live workspace files", async () => {
  const { workspace, logs, call, enroll, write } = await setup();
  const memory = await enroll();
  await write("AGENTS.md", "AGENTS BODY\n");
  await write("SOUL.md", "\n\nSOUL BODY\n  indented\n\n");
  await write("IDENTITY.md", "");
  await write("USER.md", "  \n\t\n");
  await write("TOOLS.md", "TOOLS BODY");
  await write("HEARTBEAT.md", "HEARTBEAT BODY");
  await write("BOOTSTRAP.md", "BOOTSTRAP BODY");
  await write("MEMORY.md", "MEMORY BODY");
  await write("README.md", "NOT A BOOTSTRAP FILE");
  const result = await call();
  assert.ok(result.systemPrompt.startsWith(`${POLICY}\n\n${memory}\n\n## Local media context\n`));
  assert.ok(result.systemPrompt.includes(`Generated-media staging directory: ${join(workspace, "media")}\n`));
  assert.match(result.systemPrompt, /Arbitrary \/tmp directories are not automatically allowed/u);
  assert.match(result.systemPrompt, /do not grant filesystem access or bypass media checks/u);
  assert.ok(result.systemPrompt.endsWith([`## ${join(workspace, "AGENTS.md")}\nAGENTS BODY`, `## ${join(workspace, "SOUL.md")}\nSOUL BODY\n  indented`,
    `## ${join(workspace, "BOOTSTRAP.md")}\nBOOTSTRAP BODY`].join("\n\n")));
  assert.match(memory, /^## Memory reference\n/u);
  // OpenClaw's bootstrap set only: no MEMORY body, and no legacy TOOLS.md or HEARTBEAT.md.
  assert.doesNotMatch(result.systemPrompt, /MEMORY BODY|NOT A BOOTSTRAP FILE|TOOLS BODY|HEARTBEAT BODY/u);
  assert.deepEqual(logs, []);
});

test("workspace files are read on every call: an edit, a new file and a removal apply to the next call", async () => {
  const { workspace, call, enroll, write } = await setup();
  await enroll();
  await write("SOUL.md", "SOUL A");
  assert.match((await call()).systemPrompt, /\nSOUL A$/u);
  await write("SOUL.md", "SOUL B");
  await write("USER.md", "USER B");
  const next = (await call()).systemPrompt;
  assert.match(next, new RegExp(`\\n## ${join(workspace, "SOUL.md")}\\nSOUL B\\n\\n## ${join(workspace, "USER.md")}\\nUSER B$`, "u"));
  assert.doesNotMatch(next, /SOUL A/u);
  await rm(join(workspace, "SOUL.md"));
  assert.doesNotMatch((await call()).systemPrompt, /SOUL/u);
});

test("other agents, other providers, and unenrolled, Codex-only, paused or disabled management get nothing", async () => {
  const { agentDir, config, logs, call, enroll, write } = await setup();
  await write("SOUL.md", "SOUL");
  assert.equal(await call(), undefined, "never enrolled");
  await enroll(["codex"]);
  assert.equal(await call(), undefined, "Codex only");
  await enroll(["claude-cli"]);
  assert.ok((await call()).systemPrompt);
  for (const ctx of [{ agentId: "other", sessionKey: "agent:other:main" }, { modelProviderId: "anthropic" }, { modelProviderId: "codex" }, { modelProviderId: undefined }]) {
    assert.equal(await call(ctx), undefined, JSON.stringify(ctx));
  }
  // OpenClaw compares CLI backend ids case-insensitively.
  assert.ok((await call({ modelProviderId: "Claude-CLI" })).systemPrompt);
  config.plugins.entries["unblock-codex-prompt"].enabled = false;
  assert.equal(await call(), undefined, "plugin entry disabled");
  config.plugins.entries["unblock-codex-prompt"].enabled = true;
  config.plugins.allow = ["something-else"];
  assert.equal(await call(), undefined, "plugin not allowed");
  delete config.plugins.allow;
  await restorePrompt({ agentDir, prompt: "" });
  assert.equal(await call(), undefined, "paused by restore");
  assert.deepEqual(logs, []);
});

test("invalid or tampered enrolled state is logged without prompt text and leaves OpenClaw's prompt", async () => {
  const { agentDir, logs, call, enroll, write } = await setup();
  await enroll();
  await write("SOUL.md", "SOUL SECRET");
  const home = join(agentDir, "codex-home");
  const tamper = [
    [() => writeFile(join(home, "unblock-codex-prompt.md"), "EDITED OUTSIDE SYNC"), /Frozen prompt changed outside sync/u],
    [() => writeFile(join(home, ".unblock-codex-prompt-bundle.json"), "{}"), /Frozen bundle missing or invalid/u],
    [() => writeFile(join(home, ".unblock-codex-prompt.json"), "not json"), /Invalid frozen bridge enrollment/u],
  ];
  for (const [mutate, reason] of tamper) {
    await enroll();
    assert.ok((await call()).systemPrompt);
    logs.length = 0;
    await mutate();
    assert.equal(await call(), undefined);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^error unblock-codex-prompt: Claude CLI run for agent main uses OpenClaw's prompt: /u);
    assert.match(logs[0], reason);
    assert.doesNotMatch(logs[0], /FLEET POLICY|SOUL SECRET|Memory reference/u);
    await rm(home, { recursive: true });
  }
});

test("each file is capped at OpenClaw's configured or default bootstrap limit, USER.md at 4000", async () => {
  assert.equal(bootstrapMaxChars({}, "main"), 20_000);
  assert.equal(bootstrapMaxChars({ agents: { defaults: { bootstrapMaxChars: 50.9 } } }, "main"), 50);
  assert.equal(bootstrapMaxChars({ agents: { defaults: { bootstrapMaxChars: 50 }, list: [{ id: "main", bootstrapMaxChars: 7 }] } }, "main"), 7);
  assert.equal(bootstrapMaxChars({ agents: { defaults: { bootstrapMaxChars: 50 }, entries: { main: { bootstrapMaxChars: 9 } } } }, "main"), 9);
  for (const invalid of [0, -1, Infinity, "100", null]) assert.equal(bootstrapMaxChars({ agents: { defaults: { bootstrapMaxChars: invalid } } }, "main"), 20_000);

  const defaults = await setup();
  await defaults.enroll();
  await defaults.write("AGENTS.md", "a".repeat(20_010));
  await defaults.write("USER.md", "u".repeat(4_010));
  const prompt = (await defaults.call()).systemPrompt;
  assert.match(prompt, new RegExp(`AGENTS\\.md\\n${"a".repeat(20_000)}\\n\\n## `, "u"));
  assert.match(prompt, new RegExp(`USER\\.md\\n${"u".repeat(4_000)}$`, "u"));

  const configured = await setup({ defaults: { bootstrapMaxChars: 50 }, agent: { bootstrapMaxChars: 6 } });
  await configured.enroll();
  await configured.write("SOUL.md", "123456789");
  await configured.write("USER.md", "abcdefghij");
  assert.match((await configured.call()).systemPrompt, /SOUL\.md\n123456\n\n## [^\n]*USER\.md\nabcdef$/u);
});

test("the run's workspace is used, falling back to the configured one; symlinks are followed only within it", async () => {
  const { root, workspace, logs, call, enroll, write } = await setup();
  await enroll();
  await write("SOUL.md", "CONFIGURED SOUL");
  assert.match((await call({ workspaceDir: undefined })).systemPrompt, /CONFIGURED SOUL$/u);
  const run = join(root, "run-workspace");
  await mkdir(run);
  await writeFile(join(run, "SOUL.md"), "RUN SOUL");
  const runPrompt = (await call({ workspaceDir: run })).systemPrompt;
  assert.match(runPrompt, new RegExp(`## ${join(run, "SOUL.md")}\\nRUN SOUL$`, "u"));
  assert.ok(runPrompt.includes(`Generated-media staging directory: ${join(run, "media")}\n`));
  assert.ok(!runPrompt.includes(`Generated-media staging directory: ${join(workspace, "media")}\n`));
  const missingPrompt = (await call({ workspaceDir: join(root, "missing") })).systemPrompt;
  assert.match(missingPrompt, /## Memory reference\n/u);
  assert.doesNotMatch(missingPrompt, /CONFIGURED SOUL/u);

  await mkdir(join(workspace, "shared"));
  await writeFile(join(workspace, "shared", "identity.md"), "LINKED IDENTITY");
  await symlink(join(workspace, "shared", "identity.md"), join(workspace, "IDENTITY.md"));
  await writeFile(join(root, "outside.md"), "OUTSIDE");
  await symlink(join(root, "outside.md"), join(workspace, "AGENTS.md"));
  for (let i = 0; i < 2; i++) {
    const prompt = (await call()).systemPrompt;
    assert.match(prompt, new RegExp(`## ${join(workspace, "IDENTITY.md")}\\nLINKED IDENTITY`, "u"));
    assert.doesNotMatch(prompt, /OUTSIDE|AGENTS\.md/u);
  }
  assert.deepEqual(logs, [`warn unblock-codex-prompt: ${join(workspace, "AGENTS.md")} is left out of the Claude CLI prompt: outside the workspace`]);
});

test("the hook is registered only when OpenClaw would allow it", async () => {
  for (const hooks of [{}, { allowConversationAccess: false }, { allowConversationAccess: true, allowPromptInjection: false }]) {
    assert.deepEqual(Object.keys((await setup({ hooks })).handlers), [], JSON.stringify(hooks));
  }
  for (const hooks of [{ allowConversationAccess: true }, { allowConversationAccess: true, allowPromptInjection: true }]) {
    assert.deepEqual(Object.keys((await setup({ hooks })).handlers), ["before_prompt_build"], JSON.stringify(hooks));
  }
});

test("BOOTSTRAP.md reaches only primary user or manual runs, and the total budget caps all files", async () => {
  const { workspace, call, enroll, write } = await setup({ defaults: { bootstrapTotalMaxChars: 30 } });
  await enroll();
  await write("BOOTSTRAP.md", "FIRST RUN");
  assert.match((await call()).systemPrompt, /FIRST RUN/u);
  assert.match((await call({ trigger: "manual" })).systemPrompt, /FIRST RUN/u);
  for (const ctx of [{ trigger: "heartbeat" }, { trigger: "cron" }, { sessionKey: "agent:main:subagent:abc" }]) {
    assert.doesNotMatch((await call(ctx)).systemPrompt, /FIRST RUN|BOOTSTRAP\.md/u, JSON.stringify(ctx));
  }
  assert.equal(includeBootstrap({}), true);
  await write("AGENTS.md", "A".repeat(25));
  await write("SOUL.md", "S".repeat(25));
  const prompt = (await call({ trigger: "cron" })).systemPrompt;
  assert.match(prompt, new RegExp(`## ${join(workspace, "AGENTS.md")}\\nA{25}\\n\\n## ${join(workspace, "SOUL.md")}\\nS{5}$`, "u"));
});

test("the hook runs ahead of other plugins' prompt hooks", async () => {
  const { config } = await setup();
  const registrations = [];
  plugin.register({ config, registerService() {}, registerCli() {}, logger: { info() {}, warn() {}, error() {} },
    on: (name, _handler, opts) => registrations.push([name, opts?.priority]) });
  assert.deepEqual(registrations, [["before_prompt_build", 1000]]);
});
