import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { buildSkillsCatalog, compilePrompt } from "../dist/compiler.js";
import { patchAdapterSource } from "../dist/adapter.js";
import { syncPrompt, restorePrompt } from "../dist/manager.js";
import { readFrozenPolicy } from "../dist/runtime.js";

test("frozen documents/catalog refresh only on explicit sync; native files are excluded", async () => {
  const agentDir = await mkdtemp(join(await realpath(tmpdir()), "frozen-bridge-"));
  await mkdir(join(agentDir, "codex-home"));
  await writeFile(join(agentDir, "SOUL.md"), "Soul A");
  await writeFile(join(agentDir, "AGENTS.md"), "NATIVE_ONLY");
  await writeFile(join(agentDir, "MEMORY.md"), "PRIVATE_MEMORY_BODY");
  const catalog = { prompt: "<available_skills><skill>approved</skill></available_skills>", count: 1 };
  const a = await compilePrompt("base", "policy", agentDir, catalog);
  assert(!a.prompt.includes("NATIVE_ONLY"));
  assert(!a.prompt.includes("PRIVATE_MEMORY_BODY"));
  assert.match(a.prompt, /Soul A/);
  await syncPrompt({ agentDir, ...a });
  assert.equal(readFrozenPolicy(agentDir), "policy");
  await writeFile(join(agentDir, "SOUL.md"), "Soul B");
  assert.match(await readFile(join(agentDir, "codex-home", "unblock-codex-prompt.md"), "utf8"), /Soul A/);
  assert.equal(readFrozenPolicy(agentDir), "policy");
  const b = await compilePrompt("base", "policy", agentDir, catalog);
  await syncPrompt({ agentDir, ...b });
  assert.match(await readFile(join(agentDir, "codex-home", "unblock-codex-prompt.md"), "utf8"), /Soul B/);
  await writeFile(join(agentDir, "codex-home", "unblock-codex-prompt.md"), "foreign edit");
  assert.throws(() => readFrozenPolicy(agentDir), /outside sync/);
  await restorePrompt({ agentDir, ...b });
  assert.equal(readFrozenPolicy(agentDir), null);
});

test("adapter changes only target policy and three context contributions; preserves cron/default and extra context", () => {
  const source = `
function buildDeveloperInstructions(params, options = {}) { return "native policy"; }
function buildTurnScopedCollaborationInstructions(params, options = {}) {
 const context = [options.turnScopedDeveloperInstructions, options.memoryCollaborationInstructions, options.skillsCollaborationInstructions].join("|");
 return (params.trigger === "cron" ? buildCronCollaborationInstructions() : buildDefaultCollaborationInstructions()) + context;
}
function buildCronCollaborationInstructions() { return "CRON"; }
function buildDefaultCollaborationInstructions() { return "DEFAULT"; }
`;
  const patched = patchAdapterSource(source, "/agent", "main", "/plugin/runtime.js");
  assert.throws(() => patchAdapterSource(patched, "/agent", "main", "/plugin/runtime.js"), /shape/);
  assert.throws(() => patchAdapterSource("different version", "/agent", "main", "/plugin/runtime.js"), /shape/);
  let policy = "frozen policy";
  const context = vm.createContext({ unblockPromptCreateRequire: () => () => ({ readFrozenPolicy: () => policy }) });
  vm.runInContext(patched.replace(/^import .*;\n/mu, "").replace("import.meta.url", '"file:///adapter.js"'), context);
  const params = { agentId: "main", config: { plugins: { entries: { "unblock-codex-prompt": { enabled: true, config: { frozenContext: true } } } } }, extraSystemPrompt: "ROUTING" };
  const options = { turnScopedDeveloperInstructions: "SOUL", memoryCollaborationInstructions: "MEMORY", skillsCollaborationInstructions: "SKILLS" };
  assert.equal(context.buildDeveloperInstructions(params), "frozen policy\n\nROUTING");
  assert.equal(context.buildTurnScopedCollaborationInstructions(params, options), "DEFAULT");
  assert.equal(context.buildTurnScopedCollaborationInstructions({ ...params, trigger: "cron" }, options), "CRON");
  assert.equal(context.buildDeveloperInstructions({ ...params, agentId: "other" }), "native policy");
  for (const plugins of [{ enabled: false }, { allow: [] }, { entries: {} }]) {
    assert.equal(context.buildTurnScopedCollaborationInstructions({ ...params, config: { plugins: { ...params.config.plugins, ...plugins } } }, options), "DEFAULTSOUL|MEMORY|SKILLS");
  }
  policy = null;
  assert.equal(context.buildDeveloperInstructions(params), "native policy");
  assert.equal(context.buildTurnScopedCollaborationInstructions(params, options), "DEFAULTSOUL|MEMORY|SKILLS");
});

test("snapshot uses OpenClaw eligibility, agent allowlist and model visibility", async () => {
  const workspace = await mkdtemp(join(await realpath(tmpdir()), "frozen-skills-"));
  for (const [name, extra] of [["bridge-visible", ""], ["bridge-hidden", "disable-model-invocation: true\n"], ["bridge-disabled", ""], ["bridge-excluded", ""]]) {
    await mkdir(join(workspace, "skills", name), { recursive: true });
    await writeFile(join(workspace, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: Fixture only\n${extra}---\nTest body\n`);
  }
  const config = { plugins: { enabled: false }, agents: { list: [{ id: "main", workspace, skills: ["bridge-visible", "bridge-hidden", "bridge-disabled"] }] }, skills: { entries: { "bridge-disabled": { enabled: false } } } };
  const catalog = await buildSkillsCatalog(config, "main", workspace);
  assert.equal(catalog.count, 1);
  assert.match(catalog.prompt, /bridge-visible/);
  for (const omitted of ["bridge-hidden", "bridge-disabled", "bridge-excluded"]) assert(!catalog.prompt.includes(omitted));
});
