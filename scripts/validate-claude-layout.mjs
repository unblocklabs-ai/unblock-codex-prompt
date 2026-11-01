#!/usr/bin/env node
// Layout review for a disposable OpenClaw install: patches its core Claude CLI assembly,
// renders real prompts, then restores and re-checks the vendor content inventory.
// Usage: node scripts/validate-claude-layout.mjs /path/to/disposable/node_modules/openclaw
// Never point this at the Gateway's live installation.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = await realpath(process.argv[2] ?? "");
const plugin = fileURLToPath(new URL("../dist/", import.meta.url));
const { compilePrompt } = await import(join(plugin, "compiler.js"));
const { syncPrompt, restorePrompt } = await import(join(plugin, "manager.js"));
const { prepareClaudeAdapter, installClaudeAdapter, planClaudeRestore, applyClaudeRestore, claudeAdapterStatus } = await import(join(plugin, "claude-adapter.js"));
const { checkClaudeAdoption, readClaudeManagedPrompt } = await import(join(plugin, "runtime.js"));
const sha256 = text => createHash("sha256").update(text).digest("hex");
const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;

const work = await mkdtemp(join(await realpath(tmpdir()), "claude-layout-"));
const agentDir = join(work, "agent");
const workspace = join(work, "workspace");
await mkdir(workspace, { recursive: true });
// Disk copies differ from the host-loaded context files: only the live ones may appear.
for (const [name, text] of Object.entries({ "SOUL.md": "DISK SOUL", "IDENTITY.md": "DISK IDENTITY", "USER.md": "DISK SHARED USER" })) await writeFile(join(workspace, name), text);
// Distinct per-runtime policies in one both-runtime enrollment: Claude must render only its own.
const compiled = await compilePrompt("CODEX POLICY BASE", workspace,
  { text: "CLAUDE POLICY BASE", url: "https://example.test/prompt?runtime=claude", revision: sha256("CLAUDE POLICY BASE"), checkedAt: 0 });
compiled.bundle.remotePrompt = { url: "https://example.test/prompt", revision: sha256("CODEX POLICY BASE"), checkedAt: 0 };
await syncPrompt({ agentDir, ...compiled }, { runtimes: ["codex", "claude-cli"] });

const runtimePath = join(plugin, "runtime.js");
const plan = await prepareClaudeAdapter(agentDir, "main", runtimePath, root);
await installClaudeAdapter(agentDir, plan);
assert.equal((await claudeAdapterStatus(agentDir)).state, "patched");
const helperFile = plan.files.find(file => file.patched.includes("function buildCliAgentSystemPrompt("));
const helpers = helperFile.path;
const exported = /\bbuildCliAgentSystemPrompt as ([\w$]+)\b/u.exec(helperFile.patched)[1];

// A fresh process loads the patched chunks, as a restarted Gateway would.
const render = (overrides) => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
  const build = (await import(${JSON.stringify(helpers)}))[${JSON.stringify(exported)}];
  const config = { agents: { list: [{ id: "main", agentDir: ${JSON.stringify(agentDir)}, workspace: ${JSON.stringify(workspace)} }] },
    plugins: { entries: { "unblock-codex-prompt": { enabled: true, config: { frozenContext: true, promptUrl: "https://example.test/prompt" } } } } };
  const params = { config, agentId: "main", workspaceDir: ${JSON.stringify(workspace)}, modelDisplay: "claude-cli/claude-opus-5",
    tools: [{ name: "message" }, { name: "exec" }, { name: "sessions_spawn" }], skillsPrompt: "", ownerNumbers: ["+15550100"],
    runtimeChannel: "slack", runtimeChatType: "channel", sourceReplyDeliveryMode: "message_tool_only",
    extraSystemPrompt: "UNKNOWN EXTRA CONTEXT\\nIncognito: do not persist.",
    contextFiles: [
      { path: ${JSON.stringify(join(workspace, "AGENTS.md"))}, content: "LIVE AGENTS" },
      { path: ${JSON.stringify(join(workspace, "TOOLS.md"))}, content: "LIVE TOOLS" },
      { path: ${JSON.stringify(join(workspace, "SOUL.md"))}, content: "LIVE SOUL" },
      { path: ${JSON.stringify(join(workspace, "IDENTITY.md"))}, content: "LIVE IDENTITY" },
      { path: ${JSON.stringify(join(workspace, "USER.md"))}, content: "LIVE SHARED USER" },
      { path: ${JSON.stringify(join(workspace, "users/profile-1/USER.md"))}, content: "LIVE PERSONAL USER", personalUser: true },
      { path: ${JSON.stringify(join(workspace, "MEMORY.md"))}, content: "LIVE MEMORY BODY" },
    ], ...${JSON.stringify(overrides)} };
  process.stdout.write(JSON.stringify(build(params)));
`], { encoding: "utf8" }));

const managed = render({});
if (process.env.PRINT_PROMPT) console.error(managed);
for (const expected of ["CLAUDE POLICY BASE", "LIVE SOUL", "LIVE IDENTITY", "LIVE SHARED USER", "LIVE AGENTS", "LIVE TOOLS", "LIVE PERSONAL USER", "## Memory reference",
  "UNKNOWN EXTRA CONTEXT", "Incognito: do not persist.", "## Messaging", "## Assistant Output Directives", "## Authorized Senders", "## Runtime"]) {
  assert.ok(managed.includes(expected), "managed prompt lacks " + expected);
}
for (const absent of ["You are a personal assistant running inside OpenClaw.", "CODEX POLICY BASE", "skills catalog", "DISK SOUL", "DISK IDENTITY", "DISK SHARED USER",
  "LIVE MEMORY BODY", "## Execution Bias", "## Care", "## OpenClaw Control", "## Tool Call Style", "## Silent Replies"]) {
  assert.ok(!managed.includes(absent), "managed prompt still contains " + absent);
}
assert.equal(managed.split("CLAUDE POLICY BASE").length, 2, "Claude policy appears once");
const liveSkills = render({ skillsPrompt: "<available_skills>LIVE SESSION SKILL</available_skills>" });
assert.ok(liveSkills.includes("LIVE SESSION SKILL"), "live session skills survive when no native mount exists");
// The final-adoption gate must accept what the real assembly renders, across delivery shapes.
for (const [name, prompt] of Object.entries({ managed, liveSkills,
  automatic: render({ sourceReplyDeliveryMode: "automatic" }), webchat: render({ runtimeChannel: "webchat", runtimeChatType: "direct" }),
  noMessageTool: render({ tools: [{ name: "exec" }] }), noExtra: render({ extraSystemPrompt: "" }) })) {
  assert.deepEqual(checkClaudeAdoption(agentDir, prompt), { outcome: "pass" }, "gate accepts the real " + name + " render");
}
for (const overrides of [{ modelDisplay: "gemini-cli/gemini-3" }, { agentId: "other" }]) {
  const upstream = render(overrides);
  assert.ok(upstream.includes("You are a personal assistant running inside OpenClaw.") && !upstream.includes("CLAUDE POLICY BASE"), "unmanaged route stays upstream");
}

// Plugin-registered CLI-backend guidance comes from the host's plugin registry, which a bare
// process cannot populate, so render the patched buildAgentSystemPrompt itself with the params
// the patched CLI helper forwards: a guidance sentinel must survive management, exactly once.
const renderFile = plan.files.find(file => file.patched.includes("function buildAgentSystemPrompt("));
const renderExport = /\bbuildAgentSystemPrompt as ([\w$]+)\b/u.exec(renderFile.patched)[1];
const managedPrompt = readClaudeManagedPrompt(agentDir);
const renderDirect = (managedClaude) => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
  const build = (await import(${JSON.stringify(renderFile.path)}))[${JSON.stringify(renderExport)}];
  const params = { ...${JSON.stringify(managedClaude ? { unblockManagedClaude: managedClaude } : {})}, promptSurface: "cli_backend", workspaceDir: ${JSON.stringify(workspace)},
    runtimeCwd: ${JSON.stringify(workspace)}, reasoningTagHint: false, acpEnabled: false, toolNames: ["message", "exec"], messageTool: { name: "message" },
    nativeCommandGuidanceLines: ["NATIVE CLI GUIDANCE SENTINEL: use /fixture-command for fixture work.", "NATIVE CLI GUIDANCE SENTINEL: use /fixture-command for fixture work."],
    runtimeInfo: { host: "openclaw", os: "macOS", arch: "arm64", node: process.version, model: "claude-cli/claude-opus-5", channel: "slack", chatType: "channel" },
    contextFiles: [{ path: ${JSON.stringify(join(workspace, "SOUL.md"))}, content: "LIVE SOUL" }], skillsPrompt: "", userTimezone: "UTC", userDate: "2026-11-01" };
  process.stdout.write(JSON.stringify(build(params)));
`], { encoding: "utf8" }));
const guided = renderDirect(managedPrompt);
assert.ok(guided.includes("CLAUDE POLICY BASE") && !guided.includes("You are a personal assistant running inside OpenClaw."), "direct render is managed");
assert.equal(guided.split("NATIVE CLI GUIDANCE SENTINEL").length, 2, "managed prompt keeps plugin-registered CLI-backend guidance, deduplicated as upstream does");
const upstreamGuided = renderDirect(null);
assert.equal(upstreamGuided.split("NATIVE CLI GUIDANCE SENTINEL").length, 2, "the sentinel is the real upstream guidance parameter");
assert.deepEqual(checkClaudeAdoption(agentDir, guided), { outcome: "pass" }, "gate accepts the guided render");

await restorePrompt({ agentDir, prompt: "" });
assert.ok(render({}).includes("You are a personal assistant running inside OpenClaw."), "restored enrollment renders upstream");
await applyClaudeRestore(await planClaudeRestore(agentDir));
const inventory = JSON.parse(await readFile(join(root, "dist/postinstall-content-inventory.json"), "utf8"));
for (const file of plan.files) {
  const entry = inventory.find(item => item.path === "dist/" + file.path.split("/").pop());
  assert.equal(sha256(await readFile(file.path, "utf8")), entry.sha256, "restored bytes match the vendor inventory");
}
console.log(JSON.stringify({ openclaw: version, patchedFiles: plan.files.map(file => file.path.split("/").pop()), managedChars: managed.length, result: "pass" }, null, 2));
