import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { adapterStatus, applyAdapterRestore, codexAdapterOwnership, installAdapter, planAdapterRestore, prepareAdapter } from "../dist/adapter.js";
import { applyClaudeRestore, claudeAdapterOwnership, claudeAdapterStatus, installClaudeAdapter, planClaudeRestore, prepareClaudeAdapter } from "../dist/claude-adapter.js";

// The same ownership and restore scenarios against both adapters: one shared rule set.
const runtimePath = fileURLToPath(new URL("../dist/runtime.js", import.meta.url));
const codexBundles = JSON.parse(await readFile(new URL("./fixtures/adapter-refreshable.json", import.meta.url), "utf8")).bundles;
const claudeFunctions = JSON.parse(await readFile(new URL("./fixtures/claude-assembly.json", import.meta.url), "utf8")).functions;

function claudeChunks(tag) {
  const f = claudeFunctions;
  return {
    [`helpers-${tag}.mjs`]: `import { t as buildConfiguredAgentSystemPrompt } from "./system-prompt-config-${tag}.mjs";\n${f.buildCliAgentSystemPrompt}\nexport { buildCliAgentSystemPrompt as t };\n`,
    [`system-prompt-config-${tag}.mjs`]: `import { n as buildAgentSystemPrompt } from "./system-prompt-${tag}.mjs";\n${f.buildConfiguredAgentSystemPrompt}\nexport { buildConfiguredAgentSystemPrompt as t };\n`,
    [`system-prompt-${tag}.mjs`]: `${f.buildAgentSystemPrompt}\nexport { buildAgentSystemPrompt as n };\n`,
    [`unrelated-${tag}.mjs`]: "export const unrelated = true;\n",
  };
}

async function writeTree(dist, files) {
  await mkdir(dist, { recursive: true });
  for (const [name, source] of Object.entries(files)) await writeFile(join(dist, name), source);
}
async function readTree(dist) {
  return Object.fromEntries(await Promise.all((await readdir(dist)).sort().map(async name => [name, await readFile(join(dist, name), "utf8")])));
}

/** Per adapter: its install, identity and lifecycle entry points. Everything else is shared. */
const adapters = {
  codex: {
    version: "2026.10.8", updatedVersion: "2026.10.9",
    async create(root, { version = this.version, tag = "reviewed" } = {}) {
      await mkdir(join(root, "dist"), { recursive: true });
      await writeFile(join(root, "package.json"), JSON.stringify({ name: "@openclaw/codex", version }));
      await writeTree(join(root, "dist"), Object.fromEntries(Object.entries(codexBundles).map(([name, source]) => [name.replace("-reviewed", `-${tag}`), source])));
    },
    setVersion: (root, version) => writeFile(join(root, "package.json"), JSON.stringify({ name: "@openclaw/codex", version })),
    prepare: (agentDir, root) => prepareAdapter(agentDir, "main", root, runtimePath),
    install: installAdapter,
    ownership: codexAdapterOwnership,
    state: async agentDir => (await adapterStatus(agentDir)).state,
    plan: planAdapterRestore,
    apply: applyAdapterRestore,
    backupPath: (agentDir, path) => join(agentDir, "codex-home", ".unblock-codex-prompt-adapter-original-" + basename(path)),
  },
  claude: {
    version: "2026.10.6", updatedVersion: "2026.10.9",
    async create(root, { version = this.version, tag = "test" } = {}) {
      await mkdir(join(root, "dist"), { recursive: true });
      await writeFile(join(root, "package.json"), JSON.stringify({ name: "openclaw", version }));
      await writeTree(join(root, "dist"), claudeChunks(tag));
    },
    setVersion: (root, version) => writeFile(join(root, "package.json"), JSON.stringify({ name: "openclaw", version })),
    prepare: (agentDir, root) => prepareClaudeAdapter(agentDir, "main", runtimePath, root),
    install: installClaudeAdapter,
    ownership: claudeAdapterOwnership,
    state: async agentDir => (await claudeAdapterStatus(agentDir)).state,
    plan: planClaudeRestore,
    apply: applyClaudeRestore,
    backupPath: (agentDir, path) => join(agentDir, "codex-home", ".unblock-claude-prompt-adapter-original-" + basename(path)),
  },
};

async function installed(adapter) {
  const work = await mkdtemp(join(await realpath(tmpdir()), "patched-files-"));
  const agentDir = join(work, "agent");
  await mkdir(join(agentDir, "codex-home"), { recursive: true });
  const root = join(work, "install");
  await adapter.create(root);
  const original = await readTree(join(root, "dist"));
  const plan = await adapter.prepare(agentDir, root);
  await adapter.install(agentDir, plan);
  return { work, agentDir, root, original, plan };
}

/** Normalized, adapter-independent observations. */
async function observe(adapter, agentDir) {
  return { ownership: await adapter.ownership(agentDir), state: await adapter.state(agentDir) };
}
async function refusal(promise) {
  try { await promise; return null; } catch (error) {
    const message = error.message;
    return /foreign .*edit/iu.test(message) ? "foreign edit" : /another writer/u.test(message) ? "changed by another writer"
      : /foreign .*backup/iu.test(message) ? "foreign backup" : `unexpected: ${message}`;
  }
}

const scenarios = {
  async "clean restore"(adapter) {
    const { agentDir, root, original, plan } = await installed(adapter);
    const before = await observe(adapter, agentDir);
    const restore = await adapter.plan(agentDir);
    const planned = restore.files.length === plan.files.length && !restore.superseded.length;
    await adapter.apply(restore);
    return { before, planned, restored: await observe(adapter, agentDir), original: JSON.stringify(await readTree(join(root, "dist"))) === JSON.stringify(original),
      again: (await adapter.plan(agentDir)).files.length };
  },

  async "partial restore"(adapter) {
    const { agentDir, root, original, plan } = await installed(adapter);
    await writeFile(plan.files[0].path, plan.files[0].original);
    const before = await observe(adapter, agentDir);
    const restore = await adapter.plan(agentDir);
    const planned = restore.files.length === plan.files.length - 1 && !restore.files.some(file => file.path === plan.files[0].path);
    await adapter.apply(restore);
    return { before, planned, restored: await observe(adapter, agentDir), original: JSON.stringify(await readTree(join(root, "dist"))) === JSON.stringify(original) };
  },

  async "update renames or removes the patched files"(adapter) {
    const { agentDir, root } = await installed(adapter);
    for (const name of await readdir(join(root, "dist"))) await rm(join(root, "dist", name));
    await adapter.create(root, { tag: "next" });
    const updated = await readTree(join(root, "dist"));
    const before = await observe(adapter, agentDir);
    const restore = await adapter.plan(agentDir);
    await adapter.apply(restore);
    const untouched = JSON.stringify(await readTree(join(root, "dist"))) === JSON.stringify(updated);
    // The receipt is cleared: a new sync proceeds against the update's files.
    const plan = await adapter.prepare(agentDir, root);
    await adapter.install(agentDir, plan);
    return { before, planned: restore.files.length + restore.superseded.length, untouched, resynced: await observe(adapter, agentDir),
      newNames: plan.files.every(file => basename(file.path).includes("-next")) };
  },

  async "update changes the version and replaces the files"(adapter) {
    const { agentDir, root, plan } = await installed(adapter);
    for (const file of plan.files) await writeFile(file.path, file.original + "\n// updated\n");
    await adapter.setVersion(root, adapter.updatedVersion);
    const updated = await readTree(join(root, "dist"));
    const before = await observe(adapter, agentDir);
    const restore = await adapter.plan(agentDir);
    await adapter.apply(restore);
    const untouched = JSON.stringify(await readTree(join(root, "dist"))) === JSON.stringify(updated);
    // Same file names: the cleared receipt's backups are replaced, not refused as foreign.
    const next = await adapter.prepare(agentDir, root);
    await adapter.install(agentDir, next);
    const resynced = await observe(adapter, agentDir);
    await adapter.apply(await adapter.plan(agentDir));
    return { before, planned: restore.files.length + restore.superseded.length, untouched, resynced,
      restoredToUpdate: JSON.stringify(await readTree(join(root, "dist"))) === JSON.stringify(updated) };
  },

  async "update changes the version and replaces some files"(adapter) {
    const { agentDir, root, original, plan } = await installed(adapter);
    const [replaced] = plan.files;
    await writeFile(replaced.path, replaced.original + "\n// updated\n");
    await adapter.setVersion(root, adapter.updatedVersion);
    const before = await observe(adapter, agentDir);
    const restore = await adapter.plan(agentDir);
    const planned = restore.files.length === plan.files.length - 1 && restore.superseded.length === 1 && restore.superseded[0] === replaced.path;
    await adapter.apply(restore);
    const dist = await readTree(join(root, "dist"));
    return { before, planned, after: await observe(adapter, agentDir),
      othersOriginal: Object.entries(original).every(([name, source]) => name === basename(replaced.path) || dist[name] === source),
      replacedKept: dist[basename(replaced.path)] === replaced.original + "\n// updated\n" };
  },

  async "same-version foreign edit is refused"(adapter) {
    const { agentDir, root, plan } = await installed(adapter);
    await writeFile(plan.files[0].path, plan.files[0].patched + "\n// someone else\n");
    const edited = await readTree(join(root, "dist"));
    const before = await observe(adapter, agentDir);
    return { before, restore: await refusal(adapter.plan(agentDir)), sync: await refusal(adapter.prepare(agentDir, root)),
      unchanged: JSON.stringify(await readTree(join(root, "dist"))) === JSON.stringify(edited) };
  },

  async "foreign backup is refused"(adapter) {
    const work = await mkdtemp(join(await realpath(tmpdir()), "patched-files-"));
    const agentDir = join(work, "agent");
    await mkdir(join(agentDir, "codex-home"), { recursive: true });
    const root = join(work, "install");
    await adapter.create(root);
    const original = await readTree(join(root, "dist"));
    const plan = await adapter.prepare(agentDir, root);
    await writeFile(adapter.backupPath(agentDir, plan.files[0].path), "someone else's backup");
    return { install: await refusal(adapter.install(agentDir, plan)), after: await observe(adapter, agentDir),
      unchanged: JSON.stringify(await readTree(join(root, "dist"))) === JSON.stringify(original) };
  },
};

const expected = {
  "clean restore": { before: { ownership: "patched", state: "patched" }, planned: true, restored: { ownership: "restored", state: "original" }, original: true, again: 0 },
  "partial restore": { before: { ownership: "patched", state: "partial" }, planned: true, restored: { ownership: "restored", state: "original" }, original: true },
  "update renames or removes the patched files": { before: { ownership: "superseded", state: "missing" }, planned: 0, untouched: true,
    resynced: { ownership: "patched", state: "patched" }, newNames: true },
  "update changes the version and replaces the files": { before: { ownership: "superseded", state: "changed" }, planned: 0, untouched: true,
    resynced: { ownership: "patched", state: "patched" }, restoredToUpdate: true },
  "update changes the version and replaces some files": { before: { ownership: "patched", state: "changed" }, planned: true,
    after: { ownership: "superseded", state: "changed" }, othersOriginal: true, replacedKept: true },
  "same-version foreign edit is refused": { before: { ownership: "patched", state: "changed" }, restore: "foreign edit", sync: "changed by another writer", unchanged: true },
  "foreign backup is refused": { install: "foreign backup", after: { ownership: "none", state: "absent" }, unchanged: true },
};

for (const [name, scenario] of Object.entries(scenarios)) {
  test(`both adapters, same outcome: ${name}`, async () => {
    const codex = await scenario(adapters.codex);
    const claude = await scenario(adapters.claude);
    assert.deepEqual(codex, claude);
    assert.deepEqual(codex, expected[name]);
  });
}

test("a 0.3 Codex receipt without a version lets a sync proceed once an update renamed its files; same-name changes stay refused", async () => {
  const codex = adapters.codex;
  const receiptPath = agentDir => join(agentDir, "codex-home", ".unblock-codex-prompt-adapter.json");
  const asLegacy = async agentDir => {
    const { packageVersion: _version, ...receipt } = JSON.parse(await readFile(receiptPath(agentDir), "utf8"));
    await writeFile(receiptPath(agentDir), JSON.stringify(receipt, null, 2) + "\n");
  };
  // 0.3 patched Codex 2026.9.x; the required update to 2026.10.5+ renames every hashed bundle.
  const renamed = await installed(codex);
  await asLegacy(renamed.agentDir);
  for (const name of await readdir(join(renamed.root, "dist"))) await rm(join(renamed.root, "dist", name));
  await codex.create(renamed.root, { version: "2026.10.9", tag: "next" });
  assert.equal(await codexAdapterOwnership(renamed.agentDir), "superseded");
  await codex.install(renamed.agentDir, await codex.prepare(renamed.agentDir, renamed.root));
  assert.deepEqual(await observe(codex, renamed.agentDir), { ownership: "patched", state: "patched" });
  assert.equal(JSON.parse(await readFile(receiptPath(renamed.agentDir), "utf8")).packageVersion, "2026.10.9");

  // Without a recorded version, different bytes under the same name are not provably the updater's.
  const sameName = await installed(codex);
  await asLegacy(sameName.agentDir);
  for (const file of sameName.plan.files) await writeFile(file.path, file.original + "\n// updated\n");
  await codex.setVersion(sameName.root, "2026.10.9");
  assert.equal(await codexAdapterOwnership(sameName.agentDir), "changed");
  await assert.rejects(codex.prepare(sameName.agentDir, sameName.root), /another writer/);
});

test("deleting the old OpenClaw root lets a Claude sync against a new root proceed", async () => {
  const claude = adapters.claude;
  const { work, agentDir, root } = await installed(claude);
  // A Node upgrade reinstalled OpenClaw elsewhere and the old directory was removed unrestored.
  await rm(root, { recursive: true });
  assert.equal(await claudeAdapterOwnership(agentDir), "superseded");
  assert.deepEqual(await claude.plan(agentDir), { ownership: "superseded", files: [], superseded: [] });
  const moved = join(work, "moved");
  await claude.create(moved);
  const original = await readTree(join(moved, "dist"));
  // Same chunk names: the old receipt's backups are replaced, not refused as foreign.
  await claude.install(agentDir, await claude.prepare(agentDir, moved));
  assert.equal((await claudeAdapterStatus(agentDir)).openclawRoot, moved);
  assert.deepEqual(await observe(claude, agentDir), { ownership: "patched", state: "patched" });
  await claude.apply(await claude.plan(agentDir));
  assert.deepEqual(await readTree(join(moved, "dist")), original);
});
