import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compilePrompt } from "../dist/compiler.js";
import { patchAdapterSources, prepareAdapter, installAdapter, planAdapterRestore, applyAdapterRestore, codexAdapterOwnership, readReceipt, adapterStatus } from "../dist/adapter.js";
import { assertSupportedVersion } from "../dist/compatibility.js";
import { legacy, modern, adapterFixture, splitAdapterFixture } from "./fixtures/adapter-contexts.mjs";
import { syncPrompt, restorePrompt, sha256 } from "../dist/manager.js";
import { readCodexBaseInstructions, readFrozenPolicy } from "../dist/runtime.js";

const runtimePath = fileURLToPath(new URL("../dist/runtime.js", import.meta.url));
const restoreAdapter = async agentDir => applyAdapterRestore(await planAdapterRestore(agentDir));
const refreshable = JSON.parse(await readFile(new URL("./fixtures/adapter-refreshable.json", import.meta.url), "utf8")).bundles;

async function codexPackage(root, version = "2026.10.8") {
  const packageDir = join(root, "codex");
  await mkdir(join(packageDir, "dist"), { recursive: true });
  await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: "@openclaw/codex", version }));
  const paths = [];
  for (const [name, source] of Object.entries(refreshable)) {
    await writeFile(join(packageDir, "dist", name), source);
    paths.push(join(packageDir, "dist", name));
  }
  return { packageDir, paths, originals: Object.values(refreshable) };
}

test("identity, workspace files and skills are never snapshotted; the base file holds only policy and the memory reference", async () => {
  const agentDir = await mkdtemp(join(await realpath(tmpdir()), "frozen-bridge-"));
  await mkdir(join(agentDir, "codex-home"));
  for (const [name, text] of [["SOUL.md", "SOUL_BODY"], ["IDENTITY.md", "IDENTITY_BODY"], ["USER.md", "USER_BODY"], ["AGENTS.md", "AGENTS_BODY"], ["MEMORY.md", "PRIVATE_MEMORY_BODY"]]) {
    await writeFile(join(agentDir, name), text);
  }
  await mkdir(join(agentDir, "skills", "approved"), { recursive: true });
  await writeFile(join(agentDir, "skills", "approved", "SKILL.md"), "---\nname: approved\ndescription: Fixture only\n---\nSKILL_BODY\n");
  const a = await compilePrompt("base", agentDir);
  for (const body of ["SOUL_BODY", "IDENTITY_BODY", "USER_BODY", "AGENTS_BODY", "PRIVATE_MEMORY_BODY", "approved", "SKILL_BODY"]) assert(!a.prompt.includes(body), body);
  assert.match(a.prompt, /^base\n\n## Memory reference\nWhen prior context matters, use the available memory tools[^]*MEMORY\.md\. Read it only when[^]*conversations\.\n$/);
  // The agent context is functional only: no delivery-status or lifecycle claims.
  assert.doesNotMatch(a.prompt, /## Agent context|\blive\b|snapshot|not included|currently/i);
  assert.doesNotMatch(a.prompt, /skills catalog|available_skills/i);
  // Only the fields a 0.3 runtime reads, plus the Codex prefix receipt; no frozen-catalog provenance.
  assert.deepEqual(Object.keys(a.bundle).sort(), ["basePromptLength", "policy", "schema"]);
  await syncPrompt({ agentDir, ...a });
  assert.equal(readFrozenPolicy(agentDir), "");
  assert.equal(readCodexBaseInstructions(agentDir), a.prompt);
  await writeFile(join(agentDir, "SOUL.md"), "SOUL_EDITED");
  assert.equal((await compilePrompt("base", agentDir)).prompt, a.prompt);
  await writeFile(join(agentDir, "codex-home", "unblock-codex-prompt.md"), "foreign edit");
  assert.throws(() => readFrozenPolicy(agentDir), /outside sync/);
  assert.throws(() => readCodexBaseInstructions(agentDir), /outside sync/);
  await restorePrompt({ agentDir, ...a });
  assert.equal(readFrozenPolicy(agentDir), null);
});

test("Codex layouts older than the reviewed live-context carriers are refused", () => {
  // 2026.9.2-2026.9.9 deliver persona in turn-scoped collaboration text native children never see.
  for (const sources of [[adapterFixture(legacy)], [adapterFixture(modern)], splitAdapterFixture(),
    [...splitAdapterFixture(), "async function buildCodexWorkspaceBootstrapContext(params) { return {}; }"]]) {
    assert.throws(() => patchAdapterSources(sources, "/agent", "main", "/plugin/runtime.js"), /requires @openclaw\/codex >=2026\.10\.5/);
  }
});

test("version floor permits newer stable builds, not old or prerelease builds", () => {
  for (const version of ["2026.10.5", "2026.10.5-1", "2026.10.9", "2026.11.1", "2027.1.1"]) assert.doesNotThrow(() => assertSupportedVersion(version, "OpenClaw"));
  for (const version of ["2026.9.2", "2026.9.9", "2026.10.4", "2025.12.99", "2026.10.6-beta.1", null, "garbage"]) assert.throws(() => assertSupportedVersion(version, "OpenClaw"), />=2026.10.5/);
});

test("multi-bundle installs are idempotent, refuse foreign edits and recover an interrupted runtime-path upgrade", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "adapter-split-"));
  const agentDir = join(root, "agent");
  await mkdir(join(agentDir, "codex-home"), { recursive: true });
  const { packageDir, paths, originals } = await codexPackage(root);
  const plan = await prepareAdapter(agentDir, "main", packageDir, runtimePath);
  assert.ok(plan.files.length > 1);
  await installAdapter(agentDir, plan);
  assert.equal((await adapterStatus(agentDir)).installed, true);
  assert.equal((await installAdapter(agentDir, await prepareAdapter(agentDir, "main", undefined, runtimePath))).adapterChanged, false);
  const [first, second] = plan.files;
  await writeFile(second.path, second.patched + "// foreign change");
  await assert.rejects(restoreAdapter(agentDir), /Foreign adapter edit/);
  assert.equal(await readFile(first.path, "utf8"), first.patched);
  await writeFile(second.path, second.patched);
  const changedRuntime = join(root, "runtime.js");
  await writeFile(changedRuntime, await readFile(runtimePath, "utf8"));
  const upgrade = await prepareAdapter(agentDir, "main", packageDir, changedRuntime);
  await installAdapter(agentDir, upgrade);
  // Simulate interruption after receipt publication and only one upgraded bundle.
  await writeFile(second.path, second.patched);
  assert.equal((await adapterStatus(agentDir)).installed, false);
  await installAdapter(agentDir, await prepareAdapter(agentDir, "main", undefined, changedRuntime));
  assert.equal((await adapterStatus(agentDir)).installed, true);
  await restoreAdapter(agentDir);
  assert.deepEqual(await Promise.all(paths.map(path => readFile(path, "utf8"))), originals);
});

test("0.2.0 single-file receipts still restore; re-sync of that old Codex package is refused", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "adapter-receipt-v1-"));
  const agentDir = join(root, "agent");
  const home = join(agentDir, "codex-home");
  const packageDir = join(root, "codex");
  await mkdir(home, { recursive: true });
  await mkdir(join(packageDir, "dist"), { recursive: true });
  await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: "@openclaw/codex", version: "2026.9.4" }));
  const path = join(packageDir, "dist", "thread-lifecycle-old.js");
  const original = adapterFixture(modern);
  const oldPatch = "// unblock-codex-prompt bridge v1\n" + original;
  await writeFile(path, oldPatch);
  await writeFile(join(home, ".unblock-codex-prompt-adapter-original.js"), original);
  await writeFile(join(home, ".unblock-codex-prompt-adapter.json"), JSON.stringify({
    schema: 1, packageDir, path, originalSha256: sha256(original), patchedSha256: sha256(oldPatch),
  }));
  // Its only file holds neither our bytes nor the original: not owned, so restore leaves it alone.
  await writeFile(path, oldPatch + "// foreign");
  assert.equal(await codexAdapterOwnership(agentDir), "changed");
  assert.deepEqual(await restoreAdapter(agentDir), { ownership: "changed", files: [], superseded: [], restartRequired: false });
  assert.equal(await readFile(path, "utf8"), oldPatch + "// foreign");
  await assert.rejects(prepareAdapter(agentDir, "main", undefined, runtimePath), /another writer/);
  await writeFile(path, oldPatch);
  await restoreAdapter(agentDir);
  assert.equal(await readFile(path, "utf8"), original);
  await assert.rejects(prepareAdapter(agentDir, "main", undefined, runtimePath), />=2026\.10\.5/);
});

test("renamed bundles retain exact backups, idempotence and foreign-edit/path protection", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "adapter-compat-"));
  const agentDir = join(root, "agent");
  await mkdir(join(agentDir, "codex-home"), { recursive: true });
  const { packageDir } = await codexPackage(root);
  const plan = await prepareAdapter(agentDir, "main", packageDir, runtimePath);
  await installAdapter(agentDir, plan);
  assert.equal((await installAdapter(agentDir, await prepareAdapter(agentDir, "main", undefined, runtimePath))).adapterChanged, false);
  const [file] = plan.files;
  await writeFile(file.path, file.patched + "// foreign change");
  await assert.rejects(prepareAdapter(agentDir, "main", undefined, runtimePath), /another writer/);
  await assert.rejects(restoreAdapter(agentDir), /Foreign adapter edit/);
  await writeFile(file.path, file.patched);
  await restoreAdapter(agentDir);
  assert.equal(await readFile(file.path, "utf8"), file.original);
  const receiptPath = join(agentDir, "codex-home", ".unblock-codex-prompt-adapter.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  await writeFile(receiptPath, JSON.stringify({ ...receipt, files: [{ ...receipt.files[0], path: join(root, "thread-lifecycle-escape.js") }] }));
  await assert.rejects(readReceipt(agentDir), /Invalid adapter receipt/);
});
