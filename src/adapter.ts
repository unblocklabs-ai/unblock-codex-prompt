import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { parse } from "acorn";
import { readOptional, replaceFile, sha256 } from "./manager.js";
import { openclawRoot } from "./compiler.js";
import { assertSupportedVersion, MINIMUM_OPENCLAW } from "./compatibility.js";

const MARKER = "// unblock-codex-prompt bridge v1";
const BUNDLE_NAME = /^thread-(lifecycle|requests)-[\w-]+\.m?js$/u;
const HASH = /^[a-f0-9]{64}$/u;
// Reviewed context carriers, independent of release-specific bundle names.
const CONTEXT_HASHES = {
  legacy: "1fb45c46c50a63f68e8b6bdfbc5d7ae2d323470c00db69779d159592868940bb",
  parent: "5ee80edf3f3887e841def5d64896a3d27c35063f6d4803dceeb8b8bf07b654f0",
  splitParent: "6515e383260e0edd4379a2e694d9b066ddb02a79b55fd7494bf7f85affee72c6",
  collaboration: "aea7e95ca43f0997b0a3f616f327132bfdd057bb731e6eead132fba21de3f981",
  legacyThread: "703a32a0b18eacd45a9fd3d68c04a13527bdbeaae50a11a6b76768b84b99a9ed",
  thread: "3aa4c414cb449cdb9167e6ed2df9397559176310ce7cff882652bd669ac8cee8",
};
type AdapterFile = { path: string; originalSha256: string; patchedSha256: string; previousPatchedSha256?: string };
type Receipt = ({ schema: 1; packageDir: string } & AdapterFile) | { schema: 2; packageDir: string; files: AdapterFile[] };
function receiptPath(agentDir: string) { return join(agentDir, "codex-home", ".unblock-codex-prompt-adapter.json"); }
function receiptFiles(receipt: Receipt) { return receipt.schema === 1 ? [receipt] : receipt.files; }
function backupPath(agentDir: string, file: { path: string }, legacy = false) {
  return join(agentDir, "codex-home", legacy ? ".unblock-codex-prompt-adapter-original.js" : ".unblock-codex-prompt-adapter-original-" + basename(file.path));
}
function ownsSource(file: AdapterFile, source: string | null) {
  if (source === null) return false;
  const hash = sha256(source);
  return hash === file.originalSha256 || hash === file.patchedSha256 || hash === file.previousPatchedSha256;
}

function parseReceipt(source: string | null): Receipt | null {
  if (source === null) return null;
  const value: unknown = JSON.parse(source);
  if (!value || typeof value !== "object" || !("schema" in value) || (value.schema !== 1 && value.schema !== 2) ||
      !("packageDir" in value) || typeof value.packageDir !== "string" || !isAbsolute(value.packageDir)) throw new Error("Invalid adapter receipt");
  const packageDir = value.packageDir;
  const entries: unknown[] = value.schema === 1 ? [value] : "files" in value && Array.isArray(value.files) ? value.files : [];
  if (!entries.length) throw new Error("Invalid adapter receipt");
  const files = entries.map((entry): AdapterFile => {
    if (!entry || typeof entry !== "object" || !("path" in entry) || typeof entry.path !== "string" ||
        !BUNDLE_NAME.test(basename(entry.path)) ||
        ![join(packageDir, "dist", basename(entry.path)), ...(value.schema === 2 ? [join(packageDir, "dist", ".setup", basename(entry.path))] : [])].includes(entry.path) ||
        (value.schema === 1 && !basename(entry.path).startsWith("thread-lifecycle-")) ||
        !("originalSha256" in entry) || typeof entry.originalSha256 !== "string" || !HASH.test(entry.originalSha256) ||
        !("patchedSha256" in entry) || typeof entry.patchedSha256 !== "string" || !HASH.test(entry.patchedSha256)) throw new Error("Invalid adapter receipt");
    const previous = "previousPatchedSha256" in entry ? entry.previousPatchedSha256 : undefined;
    if (previous !== undefined && (typeof previous !== "string" || !HASH.test(previous))) throw new Error("Invalid adapter receipt");
    return { path: entry.path, originalSha256: entry.originalSha256, patchedSha256: entry.patchedSha256,
      ...(typeof previous === "string" ? { previousPatchedSha256: previous } : {}) };
  });
  if (new Set(files.map(file => basename(file.path))).size !== files.length) throw new Error("Invalid adapter receipt");
  return value.schema === 1 ? { schema: 1, packageDir, ...files[0]! } : { schema: 2, packageDir, files };
}
export async function readReceipt(agentDir: string) { return parseReceipt(await readOptional(receiptPath(agentDir))); }

export function patchAdapterSources(sources: string[], agentDir: string, agentId: string, runtimePath: string) {
  if (sources.some(source => source.includes(MARKER))) throw new Error("Unsupported Codex adapter shape: already patched");
  const functions = sources.flatMap((source, bundle) =>
    parse(source, { ecmaVersion: "latest", sourceType: "module" }).body
      .filter(node => node.type === "FunctionDeclaration").map(node => ({ node, bundle })));
  const find = (name: string) => {
    const matches = functions.filter(fn => fn.node.id?.name === name);
    if (matches.length !== 1) throw new Error("Unsupported Codex adapter shape: " + name);
    return matches[0]!;
  };
  const developer = find("buildDeveloperInstructions");
  const collaboration = find("buildTurnScopedCollaborationInstructions");
  const parent = functions.some(fn => fn.node.id?.name === "buildCodexParentLocalInstructions") ? find("buildCodexParentLocalInstructions") : null;
  const thread = functions.some(fn => fn.node.id?.name === "buildCodexThreadConfiguration") ? find("buildCodexThreadConfiguration") : null;
  for (const { node, bundle } of [developer, collaboration, ...(parent ? [parent] : []), ...(thread ? [thread] : [])]) {
    if (node.async || node.generator || node.params.length !== 2 || node.params[0]?.type !== "Identifier" || node.params[0].name !== "params" ||
        !/^(options|options\s*=\s*\{\})$/u.test(sources[bundle]!.slice(node.params[1]!.start, node.params[1]!.end))) throw new Error("Unsupported Codex adapter shape: parameters");
  }
  for (const name of ["buildDefaultCollaborationInstructions", "buildCronCollaborationInstructions"]) {
    const helper = find(name);
    if (helper.node.params.length !== 0 || helper.bundle !== collaboration.bundle) throw new Error("Unsupported Codex adapter shape: mode helpers");
  }
  const fingerprint = (fn: typeof collaboration) => sha256(sources[fn.bundle]!.slice(fn.node.start, fn.node.end));
  const split = parent !== null && fingerprint(parent) === CONTEXT_HASHES.splitParent;
  if (fingerprint(collaboration) !== (parent ? CONTEXT_HASHES.collaboration : CONTEXT_HASHES.legacy) ||
      (parent && (parent.bundle !== collaboration.bundle || ![CONTEXT_HASHES.parent, CONTEXT_HASHES.splitParent].includes(fingerprint(parent)))) ||
      (thread && thread.bundle !== developer.bundle) ||
      (split ? !thread || fingerprint(thread) !== CONTEXT_HASHES.thread : thread !== null && fingerprint(thread) !== CONTEXT_HASHES.legacyThread)) throw new Error("Unsupported Codex context assembly; review the changed upstream functions before syncing");
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
    { fn: developer, text: '\n\tconst unblockPolicy = unblockFrozenPolicy(params);\n\tif (unblockPolicy !== null) return [unblockPolicy, params.gitCoauthorPrompt, params.extraSystemPrompt].filter(section => typeof section === "string" && section.trim()).join("\\n\\n");' },
    { fn: collaboration, text: '\n\tif (unblockFrozenPolicy(params) !== null) return params.trigger === "cron" ? buildCronCollaborationInstructions() : buildDefaultCollaborationInstructions();' },
    ...(parent ? [{ fn: parent, text: '\n\tif (unblockFrozenPolicy(params) !== null) return params.trigger === "cron" ? buildCronCollaborationInstructions() : null;' }] : []),
    // 2026.9.8 moved skills to the start/resume/fork carrier, outside developer policy.
    ...(split && thread ? [{ fn: thread, text: '\n\tif (unblockFrozenPolicy(params) !== null) options = { ...options, skillsInstructions: undefined };' }] : []),
  ];
  return sources.map((source, bundle) => {
    const edits = insertions.filter(edit => edit.fn.bundle === bundle).sort((a, b) => b.fn.node.body.start - a.fn.node.body.start);
    for (const { fn, text } of edits) {
      const at = fn.node.body.start + 1;
      source = source.slice(0, at) + text + source.slice(at);
    }
    return edits.length ? prefix + source : source;
  });
}

export async function prepareAdapter(agentDir: string, agentId: string, suppliedDir: string | undefined, runtimePath: string) {
  await openclawRoot();
  if (!isAbsolute(runtimePath) || await readOptional(runtimePath) === null) throw new Error("Missing durable plugin runtime");
  const previousReceipt = await readOptional(receiptPath(agentDir));
  const receipt = parseReceipt(previousReceipt);
  const packageDir = suppliedDir ? resolve(suppliedDir) : receipt?.packageDir;
  if (!packageDir) throw new Error("First frozen sync requires --codex-plugin-dir from openclaw plugins inspect codex --json");
  if (receipt && receipt.packageDir !== packageDir) throw new Error("Restore the previous adapter before changing Codex installations");
  const pkg: unknown = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  if (!pkg || typeof pkg !== "object" || !("name" in pkg) || pkg.name !== "@openclaw/codex") throw new Error("Expected the official @openclaw/codex package");
  assertSupportedVersion("version" in pkg ? pkg.version : undefined, "@openclaw/codex");
  const dist = join(packageDir, "dist");
  if (!(await lstat(dist)).isDirectory()) throw new Error("Unsupported Codex bundle layout");
  const entries = await readdir(dist, { withFileTypes: true });
  const setup = entries.find(entry => entry.name === ".setup");
  if (setup && !setup.isDirectory()) throw new Error("Unsupported Codex bundle layout");
  const paths = entries.filter(entry => BUNDLE_NAME.test(entry.name)).map(entry => join(dist, entry.name));
  if (setup) paths.push(...(await readdir(join(dist, ".setup"))).filter(name => BUNDLE_NAME.test(name)).map(name => join(dist, ".setup", name)));
  paths.sort();
  if (!paths.length || (receipt && receiptFiles(receipt).some(file => !paths.includes(file.path)))) throw new Error("Unsupported Codex bundle layout; restore before changing installations");
  const bundles = await Promise.all(paths.map(async path => {
    const current = await readOptional(path);
    if (current === null) throw new Error("Missing Codex adapter");
    const file = receipt && receiptFiles(receipt).find(file => file.path === path);
    const original = file ? await readOptional(backupPath(agentDir, file, receipt?.schema === 1)) : current;
    if (original === null || (file && sha256(original) !== file.originalSha256)) throw new Error("Codex adapter backup invalid; refusing to patch");
    if (file && !ownsSource(file, current)) throw new Error("Codex adapter changed by another writer; refusing to overwrite");
    return { path, current, original };
  }));
  const patches = patchAdapterSources(bundles.map(bundle => bundle.original), agentDir, agentId, runtimePath);
  const files = bundles.flatMap((bundle, index) => {
    const patched = patches[index]!;
    return patched === bundle.original ? [] : [{ ...bundle, patched }];
  });
  if (receipt && (files.length !== receiptFiles(receipt).length || files.some(file => !receiptFiles(receipt).some(previous => previous.path === file.path)))) throw new Error("Codex adapter path changed; restore before changing installations");
  const nextReceipt = { schema: 2 as const, packageDir, files: files.map(file => ({
    path: file.path, originalSha256: sha256(file.original), patchedSha256: sha256(file.patched),
    // Receipt-first upgrades must remain recoverable if source swapping is interrupted.
    ...(file.current !== file.original && file.current !== file.patched ? { previousPatchedSha256: sha256(file.current) } : {}),
  })) };
  return { files, receipt: nextReceipt, previousReceipt };
}

export async function installAdapter(agentDir: string, plan: Awaited<ReturnType<typeof prepareAdapter>>) {
  // Validate every target before any bundle changes; retain exact backups for recovery.
  const backups = await Promise.all(plan.files.map(async file => {
    const path = backupPath(agentDir, file);
    const backup = await readOptional(path);
    if (backup !== null && backup !== file.original) throw new Error("Foreign adapter backup");
    if (await readOptional(file.path) !== file.current) throw new Error("Concurrent adapter edit; refusing to overwrite");
    return { path, backup, original: file.original };
  }));
  for (const backup of backups) await replaceFile(backup.path, backup.backup, backup.original);
  await replaceFile(receiptPath(agentDir), plan.previousReceipt, JSON.stringify(plan.receipt, null, 2) + "\n");
  let adapterChanged = false;
  for (const file of plan.files) adapterChanged = await replaceFile(file.path, file.current, file.patched) || adapterChanged;
  return { adapterChanged, restartRequired: true };
}

export async function adapterStatus(agentDir: string) {
  const receipt = await readReceipt(agentDir);
  if (!receipt) return { installed: false };
  const files = receiptFiles(receipt);
  const installed = (await Promise.all(files.map(async file => {
    const current = await readOptional(file.path);
    return current !== null && sha256(current) === file.patchedSha256;
  }))).every(Boolean);
  return { installed, path: files[0]!.path, paths: files.map(file => file.path), minimumVersion: MINIMUM_OPENCLAW };
}

export async function restoreAdapter(agentDir: string) {
  const receipt = await readReceipt(agentDir);
  if (!receipt) return;
  const files = await Promise.all(receiptFiles(receipt).map(async file => {
    const current = await readOptional(file.path);
    const original = await readOptional(backupPath(agentDir, file, receipt.schema === 1));
    if (original === null || sha256(original) !== file.originalSha256) throw new Error("Adapter backup invalid");
    if (!ownsSource(file, current)) throw new Error("Foreign adapter edit; refusing restore");
    return { path: file.path, current, original };
  }));
  for (const file of files) await replaceFile(file.path, file.current, file.original);
}
