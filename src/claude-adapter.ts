import { readFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { applyPatchedRestore, patchedFilesOwnership, patchedFilesStatus, planPatchedRestore, type PatchedFile, type PatchedFileSet, type RestorePlan } from "./patched-files.js";

/**
 * Removal of the 0.4 Claude CLI core patch. 0.4 patched two OpenClaw core functions and kept a
 * receipt with exact-byte backups; 0.5 replaces Claude's prompt through the public
 * before_prompt_build hook and never patches core. Only what restoring a 0.4 install needs
 * remains: the receipt format and the shared patched-file lifecycle's status and restore.
 */
const HASH = /^[a-f0-9]{64}$/u;
const CHUNK = /^[\w.-]+\.mjs$/u;

type Receipt = { schema: 1; openclawRoot: string; openclawVersion: string; files: PatchedFile[] };
function receiptPath(agentDir: string) { return join(agentDir, "codex-home", ".unblock-claude-prompt-adapter.json"); }
function backupPath(agentDir: string, path: string) { return join(agentDir, "codex-home", ".unblock-claude-prompt-adapter-original-" + basename(path)); }

function parseReceipt(source: string): Receipt {
  const value: unknown = JSON.parse(source);
  if (!value || typeof value !== "object" || !("schema" in value) || value.schema !== 1 ||
      !("openclawRoot" in value) || typeof value.openclawRoot !== "string" || !isAbsolute(value.openclawRoot) ||
      !("openclawVersion" in value) || typeof value.openclawVersion !== "string" ||
      !("files" in value) || !Array.isArray(value.files) || !value.files.length) throw new Error("Invalid Claude adapter receipt");
  const root = value.openclawRoot;
  const files = value.files.map((entry: unknown): PatchedFile => {
    if (!entry || typeof entry !== "object" || !("path" in entry) || typeof entry.path !== "string" ||
        !CHUNK.test(basename(entry.path)) || entry.path !== join(root, "dist", basename(entry.path)) ||
        !("originalSha256" in entry) || typeof entry.originalSha256 !== "string" || !HASH.test(entry.originalSha256) ||
        !("patchedSha256" in entry) || typeof entry.patchedSha256 !== "string" || !HASH.test(entry.patchedSha256)) throw new Error("Invalid Claude adapter receipt");
    const previous = "previousPatchedSha256" in entry ? entry.previousPatchedSha256 : undefined;
    if (previous !== undefined && (typeof previous !== "string" || !HASH.test(previous))) throw new Error("Invalid Claude adapter receipt");
    return { path: entry.path, originalSha256: entry.originalSha256, patchedSha256: entry.patchedSha256, ...previous ? { previousPatchedSha256: previous } : {} };
  });
  if (new Set(files.map(file => file.path)).size !== files.length) throw new Error("Invalid Claude adapter receipt");
  return { schema: 1, openclawRoot: root, openclawVersion: value.openclawVersion, files };
}

async function openclawVersion(root: string) {
  const pkg: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (!pkg || typeof pkg !== "object" || !("name" in pkg) || pkg.name !== "openclaw" || !("version" in pkg) || typeof pkg.version !== "string") throw new Error("Cannot locate the running OpenClaw package");
  return pkg.version;
}

/** This agent's 0.4 Claude patched-file set in OpenClaw core: receipt, backups and install identity. */
function claudeFiles(agentDir: string): PatchedFileSet {
  return {
    receiptPath: receiptPath(agentDir),
    parseReceipt(source) {
      const receipt = parseReceipt(source);
      return { root: receipt.openclawRoot, version: receipt.openclawVersion, files: receipt.files, backupPath: file => backupPath(agentDir, file.path) };
    },
    installedVersion: root => openclawVersion(root).catch(() => null),
    backupPath: path => backupPath(agentDir, path),
    messages: {
      // Install-path messages are unreachable: 0.5 never patches OpenClaw core.
      installChanged: "The Claude core patch is no longer installed by this plugin",
      changed: "OpenClaw core changed by another writer",
      missing: "Missing OpenClaw Claude assembly chunk",
      prepareBackupInvalid: "Claude adapter backup invalid",
      moved: "OpenClaw Claude assembly moved",
      foreignBackup: "Foreign Claude adapter backup",
      concurrent: "Concurrent OpenClaw core edit; refusing to overwrite",
      foreignEdit: "Foreign OpenClaw core edit; refusing restore",
      backupInvalid: "Claude adapter backup invalid",
    },
  };
}

/** "patched" while any recorded core file still holds the 0.4 patch: a leftover to remove. */
export async function claudeAdapterOwnership(agentDir: string) {
  return patchedFilesOwnership(claudeFiles(agentDir));
}

/**
 * Disk state of a 0.4 receipt's files; distinguishes missing (e.g. after an OpenClaw update) from
 * foreign edits. `leftover` is true while any recorded file still holds the 0.4 patch bytes.
 */
export async function claudeAdapterStatus(agentDir: string) {
  const set = claudeFiles(agentDir);
  const status = await patchedFilesStatus(set);
  if (!status) return { installed: false, leftover: false, state: "absent" as const };
  const leftover = await patchedFilesOwnership(set) === "patched";
  return { installed: status.installed, leftover, state: status.state, openclawRoot: status.recorded.root, openclawVersion: status.recorded.version, paths: status.paths,
    coreIntegrity: leftover ? "modified: run codex-prompt sync or restore to remove the 0.4 Claude core patch, then restart the Gateway"
      : status.state === "original" ? "unmodified" : "no 0.4 patch bytes remain; the recorded files were updated or changed by another writer" };
}

/** Validates every recorded chunk and backup before any write; empty unless the 0.4 patch bytes are installed. */
export async function planClaudeRestore(agentDir: string) {
  return planPatchedRestore(claudeFiles(agentDir));
}

export async function applyClaudeRestore(plan: RestorePlan) {
  return applyPatchedRestore(plan);
}
