import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { buildSkillsCatalog, compilePrompt } from "../dist/compiler.js";
import { patchAdapterSources, prepareAdapter, installAdapter, restoreAdapter, readReceipt, adapterStatus } from "../dist/adapter.js";
import { assertSupportedVersion } from "../dist/compatibility.js";
import { legacy, modern, adapterFixture, splitAdapterFixture } from "./fixtures/adapter-contexts.mjs";
import { syncPrompt, restorePrompt, sha256 } from "../dist/manager.js";
import { readFrozenPolicy } from "../dist/runtime.js";

const runtimePath = fileURLToPath(new URL("../dist/runtime.js", import.meta.url));

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

for (const [layout, assembly] of [["2026.9.2", legacy], ["2026.9.4", modern], ["2026.9.8", null]]) {
test(`${layout}: only target policy/context change; cron/default and extra context survive`, () => {
  const sources = assembly === null ? splitAdapterFixture() : [adapterFixture(assembly)];
  const patched = patchAdapterSources(sources, "/agent", "main", "/plugin/runtime.js");
  assert.throws(() => patchAdapterSources(patched, "/agent", "main", "/plugin/runtime.js"), /shape/);
  assert.throws(() => patchAdapterSources([""], "/agent", "main", "/plugin/runtime.js"), /shape/);
  assert.throws(() => patchAdapterSources(sources.map(source => source.replace("options.memoryCollaborationInstructions", "options.newContext")), "/agent", "main", "/plugin/runtime.js"), /context assembly/);
  let policy = "frozen policy";
  const contexts = patched.map(source => {
    const context = vm.createContext({
      unblockPromptCreateRequire: () => () => ({ readFrozenPolicy: () => policy }),
      resolveCodexThreadApprovalsReviewer: () => "user",
      codexThreadSandboxOrPermissions: () => ({}),
      buildCodexRuntimeThreadConfigForRun: (_params, config) => config,
      resolveDirectOnlyToolNamespaces: () => [],
    });
    vm.runInContext(source.replace(/^import .*;\n/mu, "").replace("import.meta.url", '"file:///adapter.js"'), context);
    return context;
  });
  const context = contexts.find(context => context.buildTurnScopedCollaborationInstructions);
  const developer = contexts.find(context => context.buildDeveloperInstructions);
  const params = { agentId: "main", config: { plugins: { entries: { "unblock-codex-prompt": { enabled: true, config: { frozenContext: true } } } } }, extraSystemPrompt: "ROUTING" };
  const options = { turnScopedDeveloperInstructions: "SOUL", memoryCollaborationInstructions: "MEMORY", skillsCollaborationInstructions: "SKILLS", skillsInstructions: "SKILLS" };
  const nativeContext = layout === "2026.9.8" ? "SOUL\n\nSKILLS\n\nMEMORY" : "SOUL\n\nMEMORY\n\nSKILLS";
  assert.equal(developer.buildDeveloperInstructions(params), "frozen policy\n\nROUTING");
  assert.equal(developer.buildDeveloperInstructions({ ...params, gitCoauthorPrompt: "COAUTHOR" }), "frozen policy\n\nCOAUTHOR\n\nROUTING");
  assert.equal(context.buildTurnScopedCollaborationInstructions(params, options), "DEFAULT");
  assert.equal(context.buildTurnScopedCollaborationInstructions({ ...params, trigger: "cron" }, options), "CRON");
  assert.equal(developer.buildDeveloperInstructions({ ...params, agentId: "other" }), "native policy");
  if (layout !== "2026.9.2") {
    assert.equal(context.buildCodexParentLocalInstructions(params, options), null);
    assert.equal(context.buildCodexParentLocalInstructions({ ...params, trigger: "cron" }, options), "CRON");
    assert.equal(context.buildCodexParentLocalInstructions({ ...params, agentId: "other" }, options), nativeContext);
  }
  const threadOptions = { ...options, appServer: { start: {} }, cwd: "/work", config: { keep: true } };
  if (layout === "2026.9.8") {
    assert.equal(developer.buildCodexThreadConfiguration(params, threadOptions).developerInstructions, "frozen policy\n\nROUTING");
    assert.equal(developer.buildCodexThreadConfiguration(params, { ...threadOptions, developerInstructions: "HOOK_POLICY" }).developerInstructions, "HOOK_POLICY");
    assert.equal(developer.buildCodexThreadConfiguration({ ...params, agentId: "other" }, threadOptions).developerInstructions, "native policy\n\nSKILLS");
    assert.equal(threadOptions.skillsInstructions, "SKILLS");
    assert.equal(developer.buildCodexThreadConfiguration(params, threadOptions).cwd, "/work");
  }
  for (const plugins of [{ enabled: false }, { allow: [] }, { entries: {} }]) {
    const disabled = { ...params, config: { plugins: { ...params.config.plugins, ...plugins } } };
    assert.equal(context.buildTurnScopedCollaborationInstructions(disabled, options), "DEFAULT\n\n" + nativeContext);
    if (layout === "2026.9.8") assert.equal(developer.buildCodexThreadConfiguration(disabled, threadOptions).developerInstructions, "native policy\n\nSKILLS");
  }
  policy = null;
  assert.equal(developer.buildDeveloperInstructions(params), "native policy");
  assert.equal(context.buildTurnScopedCollaborationInstructions(params, options), "DEFAULT\n\n" + nativeContext);
  if (layout === "2026.9.8") assert.equal(developer.buildCodexThreadConfiguration(params, threadOptions).developerInstructions, "native policy\n\nSKILLS");
});
}

test("version floor permits newer stable builds, not old or prerelease builds", () => {
  for (const version of ["2026.9.2", "2026.9.2-1", "2026.9.4", "2026.10.1", "2027.1.1"]) assert.doesNotThrow(() => assertSupportedVersion(version, "OpenClaw"));
  for (const version of ["2026.5.27", "2026.9.1", "2025.12.99", "2026.9.4-beta.1", null, "garbage"]) assert.throws(() => assertSupportedVersion(version, "OpenClaw"), />=2026.9.2/);
});

test("2026.9.8 split bundles install together and restore exact originals", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "adapter-split-"));
  const agentDir = join(root, "agent");
  const packageDir = join(root, "codex");
  await mkdir(join(agentDir, "codex-home"), { recursive: true });
  await mkdir(join(packageDir, "dist", ".setup"), { recursive: true });
  await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: "@openclaw/codex", version: "2026.9.8" }));
  const originals = splitAdapterFixture();
  const paths = ["thread-lifecycle-new.mjs", "thread-requests-new.mjs"].map(name => join(packageDir, "dist", ".setup", name));
  for (const [i, path] of paths.entries()) await writeFile(path, originals[i]);
  const plan = await prepareAdapter(agentDir, "main", packageDir, runtimePath);
  await installAdapter(agentDir, plan);
  assert.equal((await adapterStatus(agentDir)).installed, true);
  assert.equal((await installAdapter(agentDir, await prepareAdapter(agentDir, "main", undefined, runtimePath))).adapterChanged, false);
  await writeFile(paths[1], plan.files[1].patched + "// foreign change");
  await assert.rejects(restoreAdapter(agentDir), /Foreign adapter edit/);
  assert.equal(await readFile(paths[0], "utf8"), plan.files[0].patched);
  await writeFile(paths[1], plan.files[1].patched);
  const changedRuntime = join(root, "runtime.js");
  await writeFile(changedRuntime, await readFile(runtimePath, "utf8"));
  const upgrade = await prepareAdapter(agentDir, "main", packageDir, changedRuntime);
  await installAdapter(agentDir, upgrade);
  // Simulate interruption after receipt publication and only one upgraded bundle.
  await writeFile(paths[1], plan.files[1].patched);
  assert.equal((await adapterStatus(agentDir)).installed, false);
  await installAdapter(agentDir, await prepareAdapter(agentDir, "main", undefined, changedRuntime));
  assert.equal((await adapterStatus(agentDir)).installed, true);
  await restoreAdapter(agentDir);
  assert.deepEqual(await Promise.all(paths.map(path => readFile(path, "utf8"))), originals);
});

test("0.2.0 single-file receipts restore and migrate away from expired runtime paths", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "adapter-receipt-v1-"));
  const agentDir = join(root, "agent");
  const home = join(agentDir, "codex-home");
  const packageDir = join(root, "codex");
  await mkdir(home, { recursive: true });
  await mkdir(join(packageDir, "dist"), { recursive: true });
  await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: "@openclaw/codex", version: "2026.9.4" }));
  const path = join(packageDir, "dist", "thread-lifecycle-old.js");
  const original = adapterFixture(modern);
  const [oldPatch] = patchAdapterSources([original], agentDir, "main", "/expired/runtime.js");
  await writeFile(path, oldPatch);
  await writeFile(join(home, ".unblock-codex-prompt-adapter-original.js"), original);
  const receiptPath = join(home, ".unblock-codex-prompt-adapter.json");
  await writeFile(receiptPath, JSON.stringify({
    schema: 1, packageDir, path, originalSha256: sha256(original), patchedSha256: sha256(oldPatch),
  }));
  await restoreAdapter(agentDir);
  assert.equal(await readFile(path, "utf8"), original);
  await writeFile(path, oldPatch);
  const plan = await prepareAdapter(agentDir, "main", undefined, runtimePath);
  await installAdapter(agentDir, plan);
  assert.equal((await readReceipt(agentDir)).schema, 2);
  // The receipt owns both sides of an interrupted old-to-new source swap.
  await writeFile(path, oldPatch);
  await restoreAdapter(agentDir);
  assert.equal(await readFile(path, "utf8"), original);
  await installAdapter(agentDir, await prepareAdapter(agentDir, "main", undefined, runtimePath));
  assert.equal((await adapterStatus(agentDir)).installed, true);
  await restoreAdapter(agentDir);
  assert.equal(await readFile(path, "utf8"), original);
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
  const plan = await prepareAdapter(agentDir, "main", packageDir, runtimePath);
  await installAdapter(agentDir, plan);
  assert.equal((await installAdapter(agentDir, await prepareAdapter(agentDir, "main", undefined, runtimePath))).adapterChanged, false);
  await writeFile(path, plan.files[0].patched + "// foreign change");
  await assert.rejects(prepareAdapter(agentDir, "main", undefined, runtimePath), /another writer/);
  await assert.rejects(restoreAdapter(agentDir), /Foreign adapter edit/);
  await writeFile(path, plan.files[0].patched);
  await restoreAdapter(agentDir);
  assert.equal(await readFile(path, "utf8"), original);
  const receiptPath = join(agentDir, "codex-home", ".unblock-codex-prompt-adapter.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  await writeFile(receiptPath, JSON.stringify({ ...receipt, files: [{ ...receipt.files[0], path: join(root, "thread-lifecycle-escape.js") }] }));
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
