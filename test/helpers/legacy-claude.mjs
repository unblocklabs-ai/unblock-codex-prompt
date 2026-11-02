import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { sha256 } from "../../dist/manager.js";

/**
 * What a 0.4 Claude CLI sync left behind, written directly: the patched OpenClaw core chunks,
 * their exact original-byte backups and the receipt. 0.5 no longer patches core; it only removes this.
 */
export const LEGACY_MARKER = "// unblock-codex-prompt claude bridge v1\n";
export const legacyChunks = (tag = "test") => ({
  [`helpers-${tag}.mjs`]: "function buildCliAgentSystemPrompt(params) { return params; }\nexport { buildCliAgentSystemPrompt as t };\n",
  [`system-prompt-config-${tag}.mjs`]: "function buildConfiguredAgentSystemPrompt(params) { return params; }\nexport { buildConfiguredAgentSystemPrompt as t };\n",
  [`system-prompt-${tag}.mjs`]: "function buildAgentSystemPrompt(params) { return \"OpenClaw\"; }\nexport { buildAgentSystemPrompt as n };\n",
  [`unrelated-${tag}.mjs`]: "export const unrelated = true;\n",
});
const patchedNames = tag => [`helpers-${tag}.mjs`, `system-prompt-${tag}.mjs`];

/** A fake OpenClaw core install. */
export async function legacyCore(root, { version = "2026.10.6", tag = "test" } = {}) {
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "openclaw", version }));
  for (const [name, source] of Object.entries(legacyChunks(tag))) await writeFile(join(root, "dist", name), source);
  return root;
}

export const legacyReceiptPath = agentDir => join(agentDir, "codex-home", ".unblock-claude-prompt-adapter.json");
export const legacyBackupPath = (agentDir, path) => join(agentDir, "codex-home", ".unblock-claude-prompt-adapter-original-" + basename(path));

/** Installs the 0.4 Claude patch's on-disk result for `agentDir` against the core at `root`. */
export async function installLegacyClaudePatch(agentDir, root, { tag = "test" } = {}) {
  const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  await mkdir(join(agentDir, "codex-home"), { recursive: true });
  const files = [];
  for (const name of patchedNames(tag)) {
    const path = join(root, "dist", name);
    const original = await readFile(path, "utf8");
    const patched = LEGACY_MARKER + original.replace("function ", "function unblockPatched_");
    await writeFile(legacyBackupPath(agentDir, path), original);
    await writeFile(path, patched);
    files.push({ path, original, patched });
  }
  await writeFile(legacyReceiptPath(agentDir), JSON.stringify({ schema: 1, openclawRoot: root, openclawVersion: version,
    files: files.map(file => ({ path: file.path, originalSha256: sha256(file.original), patchedSha256: sha256(file.patched) })) }, null, 2) + "\n");
  return { files };
}
