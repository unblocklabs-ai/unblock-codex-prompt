import { readFile, readdir } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";
import { readOptional, replaceFile, sha256 } from "./manager.js";
import { openclawRoot } from "./compiler.js";
import { assertSupportedVersion, MINIMUM_OPENCLAW } from "./compatibility.js";

const MARKER = "// unblock-codex-prompt bridge v1";
const BUNDLE_NAME = /^thread-lifecycle-[\w-]+\.m?js$/u;
const HASH = /^[a-f0-9]{64}$/u;
// Fingerprint only the context-assembly seams, not release-specific bundle names
// or unrelated code. New releases can use either reviewed layout unchanged.
const CONTEXT_HASHES = {
  legacy: "1fb45c46c50a63f68e8b6bdfbc5d7ae2d323470c00db69779d159592868940bb",
  parent: "5ee80edf3f3887e841def5d64896a3d27c35063f6d4803dceeb8b8bf07b654f0",
  collaboration: "aea7e95ca43f0997b0a3f616f327132bfdd057bb731e6eead132fba21de3f981",
};
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
      !isAbsolute(value.packageDir) || !BUNDLE_NAME.test(basename(value.path)) ||
      !("originalSha256" in value) || typeof value.originalSha256 !== "string" || !HASH.test(value.originalSha256) ||
      !("patchedSha256" in value) || typeof value.patchedSha256 !== "string" || !HASH.test(value.patchedSha256) ||
      value.path !== join(value.packageDir, "dist", basename(value.path))) throw new Error("Invalid adapter receipt");
  return { schema: 1, packageDir: value.packageDir, path: value.path, originalSha256: value.originalSha256, patchedSha256: value.patchedSha256 };
}

export function patchAdapterSource(source: string, agentDir: string, agentId: string, runtimePath: string) {
  if (source.includes(MARKER)) throw new Error("Unsupported Codex adapter shape: already patched");
  const functions = parse(source, { ecmaVersion: "latest", sourceType: "module" }).body.filter(node => node.type === "FunctionDeclaration");
  const find = (name: string) => {
    const matches = functions.filter(node => node.id?.name === name);
    if (matches.length !== 1) throw new Error(`Unsupported Codex adapter shape: ${name}`);
    return matches[0]!;
  };
  const developer = find("buildDeveloperInstructions");
  const collaboration = find("buildTurnScopedCollaborationInstructions");
  const parent = functions.some(node => node.id?.name === "buildCodexParentLocalInstructions") ? find("buildCodexParentLocalInstructions") : null;
  for (const fn of [developer, collaboration, ...(parent ? [parent] : [])]) {
    if (fn.async || fn.generator || fn.params.length !== 2 || fn.params[0]?.type !== "Identifier" || fn.params[0].name !== "params" ||
        !/^(options|options\s*=\s*\{\})$/u.test(source.slice(fn.params[1]!.start, fn.params[1]!.end))) throw new Error("Unsupported Codex adapter shape: parameters");
  }
  for (const name of ["buildDefaultCollaborationInstructions", "buildCronCollaborationInstructions"]) {
    if (find(name).params.length !== 0) throw new Error("Unsupported Codex adapter shape: mode helpers");
  }
  const fingerprint = (fn: typeof collaboration) => sha256(source.slice(fn.start, fn.end));
  if (fingerprint(collaboration) !== (parent ? CONTEXT_HASHES.collaboration : CONTEXT_HASHES.legacy) ||
      (parent && fingerprint(parent) !== CONTEXT_HASHES.parent)) throw new Error("Unsupported Codex context assembly; review the changed upstream functions before syncing");
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
  const insertions = [
    { at: developer.body.start + 1, text: '\n\tconst unblockPolicy = unblockFrozenPolicy(params);\n\tif (unblockPolicy !== null) return [unblockPolicy, params.gitCoauthorPrompt, params.extraSystemPrompt].filter(section => typeof section === "string" && section.trim()).join("\\n\\n");' },
    { at: collaboration.body.start + 1, text: '\n\tif (unblockFrozenPolicy(params) !== null) return params.trigger === "cron" ? buildCronCollaborationInstructions() : buildDefaultCollaborationInstructions();' },
    ...(parent ? [{ at: parent.body.start + 1, text: '\n\tif (unblockFrozenPolicy(params) !== null) return params.trigger === "cron" ? buildCronCollaborationInstructions() : null;' }] : []),
  ];
  let patched = source;
  for (const { at, text } of insertions.sort((a, b) => b.at - a.at)) patched = patched.slice(0, at) + text + patched.slice(at);
  return prefix + patched;
}

export async function prepareAdapter(agentDir: string, agentId: string, suppliedDir?: string) {
  await openclawRoot();
  const receipt = await readReceipt(agentDir);
  const packageDir = suppliedDir ? resolve(suppliedDir) : receipt?.packageDir;
  if (!packageDir) throw new Error("First frozen sync requires --codex-plugin-dir from openclaw plugins inspect codex --json");
  if (receipt && receipt.packageDir !== packageDir) throw new Error("Restore the previous adapter before changing Codex installations");
  const pkg: unknown = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  if (!pkg || typeof pkg !== "object" || !("name" in pkg) || pkg.name !== "@openclaw/codex") throw new Error("Expected the official @openclaw/codex package");
  assertSupportedVersion("version" in pkg ? pkg.version : undefined, "@openclaw/codex");
  const files = (await readdir(join(packageDir, "dist"))).filter(name => BUNDLE_NAME.test(name));
  if (files.length !== 1) throw new Error("Unsupported Codex bundle layout");
  const path = join(packageDir, "dist", files[0]!);
  const current = await readOptional(path);
  if (current === null) throw new Error("Missing Codex adapter");
  const original = receipt ? await readOptional(backupPath(agentDir)) : current;
  if (receipt && receipt.path !== path) throw new Error("Codex adapter path changed; restore before changing installations");
  if (original === null || (receipt && sha256(original) !== receipt.originalSha256)) throw new Error("Codex adapter backup invalid; refusing to patch");
  if (receipt && sha256(current) !== receipt.patchedSha256 && current !== original) throw new Error("Codex adapter changed by another writer; refusing to overwrite");
  const patched = patchAdapterSource(original, agentDir, agentId, fileURLToPath(new URL("./runtime.js", import.meta.url)));
  return { path, current, original, patched, receipt: { schema: 1 as const, packageDir, path, originalSha256: sha256(original), patchedSha256: sha256(patched) } };
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
  return { installed: current !== null && sha256(current) === receipt.patchedSha256, path: receipt.path, minimumVersion: MINIMUM_OPENCLAW };
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
