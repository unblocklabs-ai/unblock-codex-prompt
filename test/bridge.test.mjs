import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { buildSkillsCatalog, compilePrompt } from "../dist/compiler.js";
import { patchAdapterSource, prepareAdapter, installAdapter, restoreAdapter, readReceipt } from "../dist/adapter.js";
import { assertSupportedVersion } from "../dist/compatibility.js";
import { legacy, modern, adapterFixture } from "./fixtures/adapter-contexts.mjs";
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

for (const [layout, assembly] of [["2026.9.2", legacy], ["2026.9.4", modern]]) {
test(`${layout}: only target policy/context change; cron/default and extra context survive`, () => {
  const source = adapterFixture(assembly);
  const patched = patchAdapterSource(source, "/agent", "main", "/plugin/runtime.js");
  assert.throws(() => patchAdapterSource(patched, "/agent", "main", "/plugin/runtime.js"), /shape/);
  assert.throws(() => patchAdapterSource("", "/agent", "main", "/plugin/runtime.js"), /shape/);
  assert.throws(() => patchAdapterSource(source.replace("options.memoryCollaborationInstructions", "options.newContext"), "/agent", "main", "/plugin/runtime.js"), /context assembly/);
  let policy = "frozen policy";
  const context = vm.createContext({ unblockPromptCreateRequire: () => () => ({ readFrozenPolicy: () => policy }) });
  vm.runInContext(patched.replace(/^import .*;\n/mu, "").replace("import.meta.url", '"file:///adapter.js"'), context);
  const params = { agentId: "main", config: { plugins: { entries: { "unblock-codex-prompt": { enabled: true, config: { frozenContext: true } } } } }, extraSystemPrompt: "ROUTING" };
  const options = { turnScopedDeveloperInstructions: "SOUL", memoryCollaborationInstructions: "MEMORY", skillsCollaborationInstructions: "SKILLS" };
  assert.equal(context.buildDeveloperInstructions(params), "frozen policy\n\nROUTING");
  assert.equal(context.buildDeveloperInstructions({ ...params, gitCoauthorPrompt: "COAUTHOR" }), "frozen policy\n\nCOAUTHOR\n\nROUTING");
  assert.equal(context.buildTurnScopedCollaborationInstructions(params, options), "DEFAULT");
  assert.equal(context.buildTurnScopedCollaborationInstructions({ ...params, trigger: "cron" }, options), "CRON");
  assert.equal(context.buildDeveloperInstructions({ ...params, agentId: "other" }), "native policy");
  if (layout === "2026.9.4") {
    assert.equal(context.buildCodexParentLocalInstructions(params, options), null);
    assert.equal(context.buildCodexParentLocalInstructions({ ...params, trigger: "cron" }, options), "CRON");
    assert.equal(context.buildCodexParentLocalInstructions({ ...params, agentId: "other" }, options), "SOUL\n\nMEMORY\n\nSKILLS");
  }
  for (const plugins of [{ enabled: false }, { allow: [] }, { entries: {} }]) {
    assert.equal(context.buildTurnScopedCollaborationInstructions({ ...params, config: { plugins: { ...params.config.plugins, ...plugins } } }, options), "DEFAULT\n\nSOUL\n\nMEMORY\n\nSKILLS");
  }
  policy = null;
  assert.equal(context.buildDeveloperInstructions(params), "native policy");
  assert.equal(context.buildTurnScopedCollaborationInstructions(params, options), "DEFAULT\n\nSOUL\n\nMEMORY\n\nSKILLS");
});
}

test("version floor permits newer stable builds, not old or prerelease builds", () => {
  for (const version of ["2026.9.2", "2026.9.2-1", "2026.9.4", "2026.10.1", "2027.1.1"]) assert.doesNotThrow(() => assertSupportedVersion(version, "OpenClaw"));
  for (const version of ["2026.5.27", "2026.9.1", "2025.12.99", "2026.9.4-beta.1", null, "garbage"]) assert.throws(() => assertSupportedVersion(version, "OpenClaw"), />=2026.9.2/);
});

test("renamed bundles retain exact backups, idempotence and foreign-edit/path protection", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "adapter-compat-"));
  const agentDir = join(root, "agent");
  const packageDir = join(root, "codex");
  await mkdir(join(agentDir, "codex-home"), { recursive: true });
  await mkdir(join(packageDir, "dist"), { recursive: true });
  await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: "@openclaw/codex", version: "2026.9.4" }));
  const path = join(packageDir, "dist", "thread-lifecycle-new-hash.mjs");
  const original = adapterFixture(modern);
  await writeFile(path, original);
  const plan = await prepareAdapter(agentDir, "main", packageDir);
  await installAdapter(agentDir, plan);
  assert.equal((await installAdapter(agentDir, await prepareAdapter(agentDir, "main"))).adapterChanged, false);
  await writeFile(path, plan.patched + "// foreign change");
  await assert.rejects(prepareAdapter(agentDir, "main"), /another writer/);
  await assert.rejects(restoreAdapter(agentDir), /Foreign adapter edit/);
  await writeFile(path, plan.patched);
  await restoreAdapter(agentDir);
  assert.equal(await readFile(path, "utf8"), original);
  const receiptPath = join(agentDir, "codex-home", ".unblock-codex-prompt-adapter.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  await writeFile(receiptPath, JSON.stringify({ ...receipt, path: join(root, "thread-lifecycle-escape.js") }));
  await assert.rejects(readReceipt(agentDir), /Invalid adapter receipt/);
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
