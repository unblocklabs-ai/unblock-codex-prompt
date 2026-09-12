import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readOptional, replaceFile, sha256 } from "./manager.js";
import { SUPPORTED_OPENCLAW, openclawRoot } from "./compiler.js";

const ORIGINAL_SHA256 = "344d4a6332d59b5eb1d7551d6d308563f339d5d2251809c8f25e8cec04ede342";
const MARKER = "// unblock-codex-prompt bridge v1";
const developer = "function buildDeveloperInstructions(params, options = {}) {";
const collaboration = "function buildTurnScopedCollaborationInstructions(params, options = {}) {";
type Receipt = { schema: 1; packageDir: string; path: string; originalSha256: string; patchedSha256: string };
function receiptPath(agentDir: string) { return join(agentDir, "codex-home", ".unblock-codex-prompt-adapter.json"); }
function backupPath(agentDir: string) { return join(agentDir, "codex-home", ".unblock-codex-prompt-adapter-original.js"); }

export async function readReceipt(agentDir: string): Promise<Receipt | null> {
  const source = await readOptional(receiptPath(agentDir));
  if (source === null) return null;
  const value: unknown = JSON.parse(source);
  if (!value || typeof value !== "object" || !("schema" in value) || value.schema !== 1 ||
      !("packageDir" in value) || typeof value.packageDir !== "string" ||
      !("path" in value) || typeof value.path !== "string" ||
      !("originalSha256" in value) || value.originalSha256 !== ORIGINAL_SHA256 ||
      !("patchedSha256" in value) || typeof value.patchedSha256 !== "string" ||
      value.path !== join(value.packageDir, "dist", "thread-lifecycle-DPK30jad.js")) throw new Error("Invalid adapter receipt");
  return { schema: 1, packageDir: value.packageDir, path: value.path, originalSha256: value.originalSha256, patchedSha256: value.patchedSha256 };
}

export function patchAdapterSource(source: string, agentDir: string, agentId: string, runtimePath: string) {
  if (source.includes(MARKER) || source.split(developer).length !== 2 || source.split(collaboration).length !== 2) throw new Error("Unsupported Codex adapter shape");
  const prefix = `${MARKER}
import { createRequire as unblockPromptCreateRequire } from "node:module";
const unblockPromptRequire = unblockPromptCreateRequire(import.meta.url);
function unblockFrozenPolicy(params) {
  const plugins = params.config?.plugins;
  const entry = plugins?.entries?.["unblock-codex-prompt"];
  if (plugins?.enabled === false || entry?.enabled !== true || entry.config?.frozenContext !== true ||
      (Array.isArray(plugins.allow) && !plugins.allow.includes("unblock-codex-prompt"))) return null;
  const target = entry.config?.agentId ?? "main";
  if (params.agentId !== target) return null;
  if (target !== ${JSON.stringify(agentId)}) throw new Error("Frozen bridge target changed; restore and reinstall the adapter");
  return unblockPromptRequire(${JSON.stringify(runtimePath)}).readFrozenPolicy(${JSON.stringify(agentDir)});
}
`;
  return prefix + source.replace(developer, `${developer}
\tconst unblockPolicy = unblockFrozenPolicy(params);
\tif (unblockPolicy !== null) return [unblockPolicy, params.extraSystemPrompt].filter(section => typeof section === "string" && section.trim()).join("\\n\\n");`)
    .replace(collaboration, `${collaboration}
\tif (unblockFrozenPolicy(params) !== null) return params.trigger === "cron" ? buildCronCollaborationInstructions() : buildDefaultCollaborationInstructions();`);
}

export async function prepareAdapter(agentDir: string, agentId: string, suppliedDir?: string) {
  await openclawRoot();
  const receipt = await readReceipt(agentDir);
  const packageDir = suppliedDir ? resolve(suppliedDir) : receipt?.packageDir;
  if (!packageDir) throw new Error("First frozen sync requires --codex-plugin-dir from openclaw plugins inspect codex --json");
  if (receipt && receipt.packageDir !== packageDir) throw new Error("Restore the previous adapter before changing Codex installations");
  const pkg: unknown = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  if (!pkg || typeof pkg !== "object" || !("name" in pkg) || pkg.name !== "@openclaw/codex" || !("version" in pkg) || pkg.version !== SUPPORTED_OPENCLAW) throw new Error(`Frozen bridge requires @openclaw/codex ${SUPPORTED_OPENCLAW}`);
  const files = (await readdir(join(packageDir, "dist"))).filter(name => /^thread-lifecycle-[\w-]+\.js$/u.test(name));
  if (files.length !== 1 || files[0] !== "thread-lifecycle-DPK30jad.js") throw new Error("Unsupported Codex bundle layout");
  const path = join(packageDir, "dist", files[0]);
  const current = await readOptional(path);
  if (current === null) throw new Error("Missing Codex adapter");
  const original = receipt ? await readOptional(backupPath(agentDir)) : current;
  if (original === null || sha256(original) !== ORIGINAL_SHA256) throw new Error("Unknown Codex adapter bytes; refusing to patch");
  if (receipt && sha256(current) !== receipt.patchedSha256 && current !== original) throw new Error("Codex adapter changed by another writer; refusing to overwrite");
  const patched = patchAdapterSource(original, agentDir, agentId, fileURLToPath(new URL("./runtime.js", import.meta.url)));
  return { path, current, original, patched, receipt: { schema: 1 as const, packageDir, path, originalSha256: ORIGINAL_SHA256, patchedSha256: sha256(patched) } };
}

export async function installAdapter(agentDir: string, plan: Awaited<ReturnType<typeof prepareAdapter>>) {
  const backup = await readOptional(backupPath(agentDir));
  if (backup !== null && backup !== plan.original) throw new Error("Foreign adapter backup");
  await replaceFile(backupPath(agentDir), backup, plan.original);
  // Receipt first allows crash recovery; source swap is atomic and guarded.
  await replaceFile(receiptPath(agentDir), await readOptional(receiptPath(agentDir)), `${JSON.stringify(plan.receipt, null, 2)}\n`);
  return { adapterChanged: await replaceFile(plan.path, plan.current, plan.patched), restartRequired: true };
}

export async function adapterStatus(agentDir: string) {
  const receipt = await readReceipt(agentDir);
  if (!receipt) return { installed: false };
  const current = await readOptional(receipt.path);
  return { installed: current !== null && sha256(current) === receipt.patchedSha256, path: receipt.path, supportedVersion: SUPPORTED_OPENCLAW };
}

export async function restoreAdapter(agentDir: string) {
  const receipt = await readReceipt(agentDir);
  if (!receipt) return;
  const current = await readOptional(receipt.path);
  const original = await readOptional(backupPath(agentDir));
  if (original === null || sha256(original) !== receipt.originalSha256) throw new Error("Adapter backup invalid");
  if (current === original) return;
  if (current === null || sha256(current) !== receipt.patchedSha256) throw new Error("Foreign adapter edit; refusing restore");
  await replaceFile(receipt.path, current, original);
}
