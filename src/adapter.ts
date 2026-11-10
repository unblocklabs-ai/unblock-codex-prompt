import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { parse, type FunctionDeclaration } from "acorn";
import { readOptional, sha256 } from "./manager.js";
import { applyPatchedRestore, beginPatch, installPatch, openPatchedFiles, patchedFilesOwnership, patchedFilesStatus, planPatchedRestore, type PatchedFile, type PatchedFileSet, type RestorePlan } from "./patched-files.js";
import { openclawRoot } from "./compiler.js";
import { assertSupportedVersion, MINIMUM_OPENCLAW } from "./compatibility.js";
import { managedTargetSource } from "./managed-target.js";
import { codexBridgeSource } from "./codex-bridge-source.js";

const MARKER = "// unblock-codex-prompt bridge v1";
const BUNDLE_NAME = /^(?:thread-(?:lifecycle|requests|policy)|dynamic-tools|attempt-workspace-context|run-attempt)-[\w-]+\.m?js$/u;
const HASH = /^[a-f0-9]{64}$/u;
// Reviewed context producers/carriers, identical in every published @openclaw/codex 2026.10.5-2026.10.9.
const REFRESHABLE_CONTEXT_HASHES = {
  buildDeveloperInstructions: "4b4054cdd5ce65358508182d65e71a4c742b2e9debfa51eb65c5b4e26d1eb0bb",
  buildCodexWorkspaceBootstrapContext: "91bb36eddcf16741957a775af106ab3226ec02dbbe2576b71675ea6db922c0b9",
  renderCodexSkillsInstructions: "b3b53dccaa80cbd80070f69939909ed7947e5503ab128630a42ed6e255c56039",
  prepareCodexAttemptContext: "5e38fc7a339ef241acfce3fa1dfae8d06d7f2c4106ee0e511108e680e262a67a",
  buildCodexParentLocalInstructions: "d68a84359b515949483f5559f3ab4ef6b43f9b5005d5976f5e1559bb9a9f651b",
  buildCodexThreadConfiguration: "e6994e63d7f408b82ea55a9e9c3e1a87967e13c168d6d72a50a4c16466cca093",
  refreshCodexThreadInstructions: "23068afa77e3286acc06885b7440d6a1b44ede4c93a6e322fbbbcd6df8fb8777",
  restoreCodexThreadInstructionsAfterCompaction: "86d6f792175cfbc604f5408016e00b77ed1f7fbefa33b0210d6fbf8d56a2c0a4",
};
type AdapterFunction = { node: FunctionDeclaration; bundle: number };
/** packageVersion (recorded since 0.4) lets restore tell an updater's replacement from a foreign edit. */
type Receipt = ({ schema: 1; packageDir: string } & PatchedFile) | { schema: 2; packageDir: string; packageVersion?: string; files: PatchedFile[] };
function receiptPath(agentDir: string) { return join(agentDir, "codex-home", ".unblock-codex-prompt-adapter.json"); }
function receiptFiles(receipt: Receipt): PatchedFile[] {
  if (receipt.schema === 2) return receipt.files;
  const { path, originalSha256, patchedSha256, previousPatchedSha256 } = receipt;
  return [{ path, originalSha256, patchedSha256, ...previousPatchedSha256 ? { previousPatchedSha256 } : {} }];
}
function backupPath(agentDir: string, path: string, legacy = false) {
  return join(agentDir, "codex-home", legacy ? ".unblock-codex-prompt-adapter-original.js" : ".unblock-codex-prompt-adapter-original-" + basename(path));
}

function parseReceipt(source: string): Receipt {
  const value: unknown = JSON.parse(source);
  if (!value || typeof value !== "object" || !("schema" in value) || (value.schema !== 1 && value.schema !== 2) ||
      !("packageDir" in value) || typeof value.packageDir !== "string" || !isAbsolute(value.packageDir)) throw new Error("Invalid adapter receipt");
  const packageDir = value.packageDir;
  const entries: unknown[] = value.schema === 1 ? [value] : "files" in value && Array.isArray(value.files) ? value.files : [];
  if (!entries.length) throw new Error("Invalid adapter receipt");
  const files = entries.map((entry): PatchedFile => {
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
  const packageVersion = "packageVersion" in value ? value.packageVersion : undefined;
  if (packageVersion !== undefined && typeof packageVersion !== "string") throw new Error("Invalid adapter receipt");
  return value.schema === 1 ? { schema: 1, packageDir, ...files[0]! } : { schema: 2, packageDir, ...packageVersion ? { packageVersion } : {}, files };
}
export async function readReceipt(agentDir: string) {
  const source = await readOptional(receiptPath(agentDir));
  return source === null ? null : parseReceipt(source);
}

async function packageVersion(packageDir: string) {
  try {
    const pkg: unknown = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
    return pkg && typeof pkg === "object" && "version" in pkg && typeof pkg.version === "string" ? pkg.version : null;
  } catch { return null; }
}

/** This agent's Codex patched-file set: receipt, backups and package identity. */
function codexFiles(agentDir: string): PatchedFileSet {
  return {
    receiptPath: receiptPath(agentDir),
    parseReceipt(source) {
      const receipt = parseReceipt(source);
      // Schema-1 (0.2.0) receipts kept their single backup under a legacy name.
      return { root: receipt.packageDir, ...receipt.schema === 2 && receipt.packageVersion !== undefined ? { version: receipt.packageVersion } : {},
        files: receiptFiles(receipt), backupPath: file => backupPath(agentDir, file.path, receipt.schema === 1) };
    },
    installedVersion: packageVersion,
    backupPath: path => backupPath(agentDir, path),
    messages: {
      installChanged: "Restore the previous adapter before changing Codex installations",
      changed: "Codex adapter changed by another writer; refusing to overwrite",
      missing: "Missing Codex adapter",
      prepareBackupInvalid: "Codex adapter backup invalid; refusing to patch",
      moved: "Codex adapter path changed; restore before changing installations",
      foreignBackup: "Foreign adapter backup",
      concurrent: "Concurrent adapter edit; refusing to overwrite",
      foreignEdit: "Foreign adapter edit; refusing restore",
      backupInvalid: "Adapter backup invalid",
    },
  };
}

export async function codexAdapterOwnership(agentDir: string) {
  return patchedFilesOwnership(codexFiles(agentDir));
}

function bridgePrefix(agentDir: string, agentId: string) {
  return `${MARKER}
import { createRequire as unblockPromptCreateRequire } from "node:module";
// Keep the runtime with the patch; this require resolves only Node built-ins.
let unblockRuntime;
function unblockLoadBridge() {
  return unblockRuntime ??= ((require) => {
${codexBridgeSource}
    return unblockBridge;
  })(unblockPromptCreateRequire(import.meta.url));
}
function unblockNormalizeAdditions(text) { return unblockLoadBridge().normalizeOpenClawAdditions(text); }
function unblockNormalizeTurnContext(context) { return unblockLoadBridge().normalizeOpenClawTurnContext(context); }
// One non-enumerable live-context relay on the attempt params: producers that run first in the
// reviewed attempt order record their host-rendered text, buildDeveloperInstructions reads it.
// The registered symbol works across bundles and realms; copies of params never carry it.
const unblockLiveKey = Symbol.for("unblock-codex-prompt.live-context");
function unblockRelay(params, part, text) {
  Object.defineProperty(params, unblockLiveKey, { value: { ...params[unblockLiveKey], [part]: text }, configurable: true, writable: true, enumerable: false });
}
function unblockBaseInstructions(params) {
  if (!unblockManagedTarget(params)) return null;
  return unblockLoadBridge().readCodexBaseInstructions(${JSON.stringify(agentDir)});
}
${managedTargetSource({ name: "unblockManagedTarget", agentId, targetChanged: "Frozen bridge target changed; restore and reinstall the adapter" })}function unblockFrozenPolicy(params) {
  if (!unblockManagedTarget(params)) return null;
  return unblockLoadBridge().readFrozenPolicy(${JSON.stringify(agentDir)});
}
`;
}

export function patchAdapterSources(sources: string[], agentDir: string, agentId: string) {
  if (sources.some(source => source.includes(MARKER))) throw new Error("Unsupported Codex adapter shape: already patched");
  const functions = sources.flatMap((source, bundle) =>
    parse(source, { ecmaVersion: "latest", sourceType: "module" }).body
      .filter(node => node.type === "FunctionDeclaration").map(node => ({ node, bundle })));
  const find = (name: string) => {
    const matches = functions.filter(fn => fn.node.id?.name === name);
    if (matches.length !== 1) throw new Error("Unsupported Codex adapter shape: " + name);
    return matches[0]!;
  };
  // Older layouts carry persona in turn-scoped collaboration text that native children never see.
  if (functions.some(fn => fn.node.id?.name === "buildTurnScopedCollaborationInstructions") ||
      !functions.some(fn => fn.node.id?.name === "buildCodexWorkspaceBootstrapContext")) {
    throw new Error(`Unsupported Codex context layout; live agent context requires @openclaw/codex >=${MINIMUM_OPENCLAW}`);
  }
  const prefix = bridgePrefix(agentDir, agentId);
  return patchOperationalAdapter(patchRefreshableAdapter(sources, find, prefix), prefix);
}

function patchRefreshableAdapter(sources: string[], find: (name: string) => AdapterFunction, prefix: string) {
  for (const [name, expected] of Object.entries(REFRESHABLE_CONTEXT_HASHES)) {
    const { node, bundle } = find(name);
    if (sha256(sources[bundle]!.slice(node.start, node.end)) !== expected) {
      throw new Error("Unsupported Codex context assembly: " + name + "; review the changed upstream function before syncing");
    }
  }
  const developer = find("buildDeveloperInstructions");
  const skills = find("renderCodexSkillsInstructions");
  const workspace = find("buildCodexWorkspaceBootstrapContext");
  const thread = find("buildCodexThreadConfiguration");
  const originalThread = sources[thread.bundle]!.slice(thread.node.start, thread.node.end)
    .replace("function buildCodexThreadConfiguration(", "function unblockOriginalThreadConfiguration(");
  // Thread start, resume and fork requests carry the verified base file as base instructions.
  // OpenClaw fingerprints these requests, so a refreshed policy resumes the thread on its next
  // turn with the new base; Codex keeps base instructions out of history and compaction. The
  // model_instructions_file pointer to the same file remains the fallback.
  const threadWrapper = `function buildCodexThreadConfiguration(params, options) {
  const base = unblockBaseInstructions(params);
  const request = unblockOriginalThreadConfiguration(params, options);
  return base === null ? request : { ...request, baseInstructions: base };
}
`;
  const originalWorkspace = sources[workspace.bundle]!.slice(workspace.node.start, workspace.node.end)
    .replace("async function buildCodexWorkspaceBootstrapContext", "async function unblockOriginalWorkspaceContext");
  const originalSkills = sources[skills.bundle]!.slice(skills.node.start, skills.node.end)
    .replace("function renderCodexSkillsInstructions(", "function unblockOriginalSkillsInstructions(");
  // Live session context, in the host's own rendering, moves from the parent-only and refreshable
  // carriers into the thread developer instructions: rebuilt every turn (a change re-syncs the
  // thread), restored after compaction and inherited by native children. Both producers run on
  // the same attempt params object before buildDeveloperInstructions (reviewed call order in
  // every supported release) and relay their output on it:
  // - skills: OpenClaw's per-session skills catalog with its skills_search/skills_read hints,
  //   exactly as upstream renders it (nothing when upstream renders nothing);
  // - persona: SOUL, IDENTITY, shared USER and the session-selected personal USER.
  // Memory stays suppressed at its producer; native AGENTS stays live.
  const skillsWrapper = `function renderCodexSkillsInstructions(params) {
  const policy = unblockFrozenPolicy(params.attempt);
  const skills = unblockOriginalSkillsInstructions(params);
  if (policy === null) return skills;
  unblockRelay(params.attempt, "skills", skills);
  return;
}
`;
  const wrapper = `async function buildCodexWorkspaceBootstrapContext(params) {
  const policy = unblockFrozenPolicy(params.params);
  const context = await unblockOriginalWorkspaceContext(params);
  if (policy === null) return context;
  unblockRelay(params.params, "persona", context.personaInstructions);
  return { ...context, personaInstructions: undefined, sharedPersonaInstructions: undefined, memoryInstructions: undefined };
}
`;
  const edits = [
    { bundle: developer.bundle, start: developer.node.body.start + 1, end: developer.node.body.start + 1,
      text: '\n\tconst unblockPolicy = unblockFrozenPolicy(params);\n\tif (unblockPolicy !== null) return [unblockPolicy, params[unblockLiveKey]?.skills, params[unblockLiveKey]?.persona, params.gitCoauthorPrompt, unblockNormalizeAdditions(params.extraSystemPrompt)].filter(section => typeof section === "string" && section.trim()).join("\\n\\n");' },
    { bundle: skills.bundle, start: skills.node.start, end: skills.node.end, text: skillsWrapper + originalSkills },
    { bundle: workspace.bundle, start: workspace.node.start, end: workspace.node.end, text: wrapper + originalWorkspace },
    { bundle: thread.bundle, start: thread.node.start, end: thread.node.end, text: threadWrapper + originalThread },
  ];
  return sources.map((source, bundle) => {
    const selected = edits.filter(edit => edit.bundle === bundle).sort((a, b) => b.start - a.start);
    for (const edit of selected) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
    return selected.length ? prefix + source : source;
  });
}

const OPERATIONAL_HASHES = {
  buildTurnStartParams: "166c4d2ca9873f5ced180475487775c2965583aa1ff087e599321fcb408fd053",
  buildCodexTemporalAdditionalContext: "7b546f0ad79ce26d856f8645bfd5b232f1fdfce699dfe2e84c24fe5f61401094",
  resumeExistingCodexThread: "1b8d4038ee162b276095d9f3e1ad771f33c7cd794c47fb5088783dae9e7c1494",
  refreshCodexThreadPolicy: "69d6e9903896c77e71542957dbadddaca5d3cbb4d7cd56b8ff0de2a5ca42b995",
};

function patchOperationalAdapter(sources: string[], prefix: string) {
  const functionsByBundle = sources.map(source => parse(source, { ecmaVersion: "latest", sourceType: "module" }).body
    .filter(node => node.type === "FunctionDeclaration"));
  const names = functionsByBundle.flat().map(node => node.id?.name);
  const required = Object.keys(OPERATIONAL_HASHES);
  if (required.some(name => names.includes(name)) && required.some(name => names.filter(found => found === name).length !== 1)) {
    throw new Error("Unsupported Codex operational context: missing or duplicate carrier; review before syncing");
  }
  return sources.map((source, bundle) => {
    const functions = functionsByBundle[bundle]!;
    const edits = [];
    for (const [name, hash] of Object.entries(OPERATIONAL_HASHES)) {
      const matches = functions.filter(node => node.id?.name === name);
      if (!matches.length) continue; // Older carriers have no per-turn additional context.
      const node = matches[0]!;
      const original = source.slice(node.start, node.end);
      if (matches.length !== 1 || sha256(original) !== hash) throw new Error("Unsupported Codex operational context: " + name + "; review before syncing");
      let replacement: string;
      if (name === "resumeExistingCodexThread") {
        replacement = original.replace("await refreshCodexThreadPolicy({", "await refreshCodexThreadPolicy({\n\t\t\tunblockManaged: unblockFrozenPolicy(params.params) !== null,");
      } else if (name === "refreshCodexThreadPolicy") {
        replacement = original.replace("{\n", '{\n\tif (params.unblockManaged) {\n\t\tawait injectCodexThreadDeveloperHandoff(params, "Follow the OpenClaw developer instructions below in place of any earlier OpenClaw developer instructions in this conversation.\\n\\n" + params.developerInstructions);\n\t\treturn;\n\t}\n');
      } else {
        const originalName = "unblockOriginal" + name;
        const value = name === "buildTurnStartParams" ? "result.additionalContext" : "result";
        const normalized = name === "buildTurnStartParams" ? "{ ...result, additionalContext: unblockNormalizeTurnContext(result.additionalContext) }" : "unblockNormalizeTurnContext(result)";
        replacement = `function ${name}(params, options) {\n  const managed = unblockFrozenPolicy(params) !== null;\n  const result = ${originalName}(params, options);\n  return managed && ${value} ? ${normalized} : result;\n}\n` + original.replace(`function ${name}(`, `function ${originalName}(`);
      }
      edits.push({ start: node.start, end: node.end, text: replacement });
    }
    for (const edit of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
    return edits.length && !source.includes(MARKER) ? prefix + source : source;
  });
}

export async function prepareAdapter(agentDir: string, agentId: string, suppliedDir: string | undefined) {
  await openclawRoot();
  const set = codexFiles(agentDir);
  const opened = await openPatchedFiles(set);
  // A cleared receipt still remembers the package for a sync without --codex-plugin-dir.
  const packageDir = suppliedDir ? resolve(suppliedDir) : opened.recorded?.root;
  if (!packageDir) throw new Error("First frozen sync requires --codex-plugin-dir from openclaw plugins inspect codex --json");
  const patch = await beginPatch(set, opened, packageDir);
  const pkg: unknown = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  if (!pkg || typeof pkg !== "object" || !("name" in pkg) || pkg.name !== "@openclaw/codex") throw new Error("Expected the official @openclaw/codex package");
  assertSupportedVersion("version" in pkg ? pkg.version : undefined, "@openclaw/codex");
  const version = String((pkg as Record<string, unknown>).version);
  const dist = join(packageDir, "dist");
  if (!(await lstat(dist)).isDirectory()) throw new Error("Unsupported Codex bundle layout");
  const entries = await readdir(dist, { withFileTypes: true });
  const setup = entries.find(entry => entry.name === ".setup");
  if (setup && !setup.isDirectory()) throw new Error("Unsupported Codex bundle layout");
  const paths = entries.filter(entry => BUNDLE_NAME.test(entry.name)).map(entry => join(dist, entry.name));
  if (setup) paths.push(...(await readdir(join(dist, ".setup"))).filter(name => BUNDLE_NAME.test(name)).map(name => join(dist, ".setup", name)));
  paths.sort();
  if (!paths.length) throw new Error("Unsupported Codex bundle layout");
  const originals = await Promise.all(paths.map(patch.read));
  const patches = patchAdapterSources(originals, agentDir, agentId);
  const { files, entries: receiptEntries, previousReceipt, staleBackups } =
    patch.finish(new Map(paths.flatMap((path, index) => patches[index] === originals[index] ? [] : [[path, patches[index]!] as const])));
  const receipt = { schema: 2 as const, packageDir, packageVersion: version, files: receiptEntries };
  return { files, receipt, previousReceipt, staleBackups };
}

export async function installAdapter(agentDir: string, plan: Awaited<ReturnType<typeof prepareAdapter>>) {
  return installPatch(codexFiles(agentDir), plan, JSON.stringify(plan.receipt, null, 2) + "\n");
}

export async function adapterStatus(agentDir: string) {
  const status = await patchedFilesStatus(codexFiles(agentDir));
  if (!status) return { installed: false, state: "absent" as const };
  return { installed: status.installed, state: status.state, path: status.paths[0]!, paths: status.paths, packageDir: status.recorded.root,
    ...status.recorded.version ? { packageVersion: status.recorded.version } : {}, minimumVersion: MINIMUM_OPENCLAW };
}

/** Validates every recorded file before any write; empty unless this adapter's bytes are installed. */
export async function planAdapterRestore(agentDir: string) {
  return planPatchedRestore(codexFiles(agentDir));
}

export async function applyAdapterRestore(plan: RestorePlan) {
  return applyPatchedRestore(plan);
}
