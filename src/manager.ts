import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readPromptPointer, setPromptPointer } from "./toml.js";

export const RUNTIMES = ["codex", "claude-cli"] as const;
export type ManagedRuntime = typeof RUNTIMES[number];
/** previousPointer is Codex's original model_instructions_file; unused by Claude-only enrollment. */
export type Enrollment = { active: boolean; previousPointer: string | null; runtimes: ManagedRuntime[] };
/** A fetched fleet policy and its provenance. Metadata (never `text`) is safe to report. */
export type PolicyReceipt = { url: string; revision: string; checkedAt: number };
export type ClaudePolicy = PolicyReceipt & { text: string };
/**
 * `policy` stays "" (0.3 runtimes require the field; they read only `schema`, `policy` and
 * `promptSha256`). The Codex policy is the prompt-file prefix, with `basePromptLength` and
 * `remotePrompt` describing it. Claude's policy and the shared agent context live in the bundle
 * itself, so Claude never reads the Codex artifact.
 */
export type FrozenBundle = { schema: 1; policy: string; basePromptLength?: number;
  remotePrompt?: { url: string; revision: string; checkedAt?: number }; claudePolicy?: ClaudePolicy; agentContext?: string };
/** First heading of the agent context, the boundary after the shared policy prefix. */
export const MEMORY_REFERENCE_HEADER = "\n\n## Memory reference\n";
/**
 * Accepted boundaries: the current first heading, then the 0.4 branch builds' `## Agent context`
 * and the 0.3 `## Frozen agent context`, so their prompt files still refresh in place.
 */
export const CONTEXT_BOUNDARY_HEADERS = [MEMORY_REFERENCE_HEADER, "\n\n## Agent context\n", "\n\n## Frozen agent context\n"] as const;

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }

/** Strict shape check for a stored Claude policy; throws on anything else. */
export function parseClaudePolicy(value: unknown): ClaudePolicy {
  if (!record(value) || typeof value.text !== "string" || !value.text.trim() || typeof value.url !== "string" || !value.url ||
      typeof value.revision !== "string" || !value.revision || typeof value.checkedAt !== "number" || !Number.isFinite(value.checkedAt)) {
    throw new Error("Claude policy missing or invalid; run codex-prompt sync");
  }
  return { text: value.text, url: value.url, revision: value.revision, checkedAt: value.checkedAt };
}
export type PromptTarget = { agentDir: string; prompt: string; bundle?: FrozenBundle };

function paths(target: PromptTarget) {
  const home = join(resolve(target.agentDir), "codex-home");
  return {
    home,
    config: join(home, "config.toml"),
    prompt: join(home, "unblock-codex-prompt.md"),
    state: join(home, ".unblock-codex-prompt.json"),
    lock: join(home, ".unblock-codex-prompt.lock"),
    bundle: join(home, ".unblock-codex-prompt-bundle.json"),
  };
}

function isMissing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function statOptional(path: string) {
  try { return await lstat(path); } catch (error) { if (isMissing(error)) return null; throw error; }
}

async function assertDirectoryChain(path: string): Promise<void> {
  const parent = dirname(path);
  if (parent !== path) await assertDirectoryChain(parent);
  const stat = await statOptional(path);
  if (stat && !stat.isDirectory()) throw new Error(`Expected a real directory, not a symlink or file: ${path}`);
}

export async function readOptional(path: string) {
  const stat = await statOptional(path);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`Refusing non-regular, linked, or shared file: ${path}`);
  return readFile(path, "utf8");
}

export function parseEnrollment(source: string | null): Enrollment | null {
  if (source === null) return null;
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new Error("Invalid prompt enrollment state"); }
  if (!value || typeof value !== "object" || !("schema" in value) || (value.schema !== 1 && value.schema !== 2) ||
      !("active" in value) || typeof value.active !== "boolean" || !("previousPointer" in value) ||
      (value.previousPointer !== null && typeof value.previousPointer !== "string")) {
    throw new Error("Invalid prompt enrollment state");
  }
  // Schema 1 without runtimes is the pre-0.4 Codex enrollment.
  if (value.schema === 1 && !("runtimes" in value)) return { active: value.active, previousPointer: value.previousPointer, runtimes: ["codex"] };
  const runtimes: unknown = "runtimes" in value ? value.runtimes : undefined;
  if (!Array.isArray(runtimes) || !runtimes.length || new Set(runtimes).size !== runtimes.length ||
      runtimes.some(runtime => !RUNTIMES.includes(runtime))) throw new Error("Invalid prompt enrollment state");
  return { active: value.active, previousPointer: value.previousPointer, runtimes: sortRuntimes(runtimes) };
}

function sortRuntimes(runtimes: readonly ManagedRuntime[]) { return RUNTIMES.filter(runtime => runtimes.includes(runtime)); }

/**
 * Schema 1 is the format 0.3.x reads (it checks only schema, active and previousPointer).
 * Every state 0.3.x can safely act on uses it: Codex enrollments (with Claude too, 0.3.x keeps
 * managing Codex and registers no Claude prompt hook, so Claude falls back upstream) and paused ones.
 * Active Claude-only enrollment is schema 2, which 0.3.x refuses rather than mismanaging it.
 * Codex-only enrollment omits runtimes: exactly the 0.3.x shape.
 */
export function serializeEnrollment(enrollment: Enrollment) {
  const runtimes = sortRuntimes(enrollment.runtimes);
  const codexOnly = runtimes.length === 1 && runtimes[0] === "codex";
  const value = { schema: enrollment.active && !runtimes.includes("codex") ? 2 : 1, active: enrollment.active,
    previousPointer: enrollment.previousPointer, ...codexOnly ? {} : { runtimes } };
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function snapshot(target: PromptTarget) {
  const files = paths(target);
  await assertDirectoryChain(files.home);
  const [config, prompt, state] = await Promise.all([
    readOptional(files.config), readOptional(files.prompt), readOptional(files.state),
  ]);
  const enrollment = parseEnrollment(state);
  // Claude-only enrollment never parses or edits Codex configuration.
  const pointer = () => readPromptPointer(config ?? "");
  return { files, config, prompt, state, pointer, enrollment };
}

/** Disk-only enrollment for callers that select runtime components. */
export async function readEnrollment(agentDir: string) {
  return (await snapshot({ agentDir, prompt: "" })).enrollment;
}

export function sha256(text: string) { return createHash("sha256").update(text).digest("hex"); }

/** Disk state only: this cannot attest to instructions retained by a live Codex thread or Claude process. */
export async function promptStatus(target: PromptTarget) {
  const s = await snapshot(target);
  const codex = s.enrollment?.runtimes.includes("codex") ?? true;
  return {
    enrolled: s.enrollment?.active === true,
    restored: s.enrollment?.active === false,
    runtimes: s.enrollment?.runtimes ?? [],
    configPath: s.files.config,
    promptPath: s.files.prompt,
    pointerMatches: codex ? s.pointer() === s.files.prompt : null,
    actualSha256: s.prompt === null ? null : sha256(s.prompt),
    runtimeVerified: false,
  };
}

export async function replaceFile(path: string, previous: string | null, contents: string) {
  if (previous === contents) return false;
  const mode = (await statOptional(path))?.mode ?? 0o600;
  const temporary = join(dirname(path), `.${randomUUID()}.prompt-tmp`);
  try {
    await writeFile(temporary, contents, { flag: "wx", mode: mode & 0o777 });
    if (await readOptional(path) !== previous) throw new Error(`Concurrent edit detected; refusing to overwrite ${path}`);
    await rename(temporary, path);
  } finally {
    try { await unlink(temporary); } catch (error) { if (!isMissing(error)) throw error; }
  }
  return true;
}

export async function withLock<T>(target: PromptTarget, operation: () => Promise<T>) {
  const files = paths(target);
  await assertDirectoryChain(files.home);
  await mkdir(files.home, { recursive: true, mode: 0o700 });
  try {
    await mkdir(files.lock, { mode: 0o700 });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error(`Prompt sync is locked: ${files.lock}. If its process crashed, remove this empty directory after confirming no sync is running.`);
    }
    throw error;
  }
  try { return await operation(); } finally { await rmdir(files.lock); }
}

export const ACTIVATION: Record<ManagedRuntime, string> = {
  codex: "Restart the managed app-server and use a new Codex session; existing threads may retain old instructions.",
  "claude-cli": "No restart is needed once the Gateway has loaded this plugin version: the plugin builds the Claude CLI prompt on every turn, so the target agent's next Claude turn uses it. A plugin install or update needs a Gateway restart to load the plugin. The new prompt starts a new Claude CLI process that may resume the existing conversation, whose earlier history is not cleaned.",
};

export async function syncPrompt(target: PromptTarget, options: { adopt?: boolean; automatic?: boolean; runtimes?: readonly ManagedRuntime[] } = {}) {
  if (!target.prompt.trim()) throw new Error("Refusing an empty base prompt");
  const requested = sortRuntimes(options.runtimes ?? ["codex"]);
  if (!requested.length) throw new Error("Select at least one managed runtime");
  // Reject invalid state before creating even the lock directory.
  await snapshot(target);
  return withLock(target, async () => {
    const s = await snapshot(target);
    if (s.enrollment?.active === false && options.automatic) return { changed: false, restored: true };
    const current = s.enrollment?.active ? s.enrollment : null;
    // Sync adds components; removing one requires restore so its owned edits are reverted.
    const runtimes = sortRuntimes([...current?.runtimes ?? [], ...requested]);
    const codex = runtimes.includes("codex");
    const pointer = codex ? s.pointer() : null;
    const addingCodex = codex && !current?.runtimes.includes("codex");
    if (codex && pointer !== null && pointer !== s.files.prompt && !options.adopt) {
      throw new Error("A different model_instructions_file is configured. Review it, then run openclaw codex-prompt sync --adopt to take ownership.");
    }
    if (!s.enrollment && (s.prompt !== null || pointer === s.files.prompt)) {
      throw new Error("Managed prompt exists without enrollment state; recover the state before syncing");
    }
    const enrollment: Enrollment = {
      active: true, runtimes,
      previousPointer: addingCodex ? pointer : current?.previousPointer ?? null,
    };
    // Save rollback information first; point Codex at the file only after it exists.
    const stateChanged = await replaceFile(s.files.state, s.state, serializeEnrollment(enrollment));
    const promptChanged = await replaceFile(s.files.prompt, s.prompt, target.prompt);
    const bundleChanged = target.bundle ? await replaceFile(s.files.bundle, await readOptional(s.files.bundle),
      `${JSON.stringify({ ...target.bundle, promptSha256: sha256(target.prompt) }, null, 2)}\n`) : false;
    const configChanged = codex ? await replaceFile(s.files.config, s.config, setPromptPointer(s.config ?? "", s.files.prompt)) : false;
    return { changed: stateChanged || promptChanged || configChanged || bundleChanged, promptChanged, configChanged, runtimes,
      sha256: sha256(target.prompt), activation: runtimes.map(runtime => ACTIVATION[runtime]).join(" ") };
  });
}

export async function restorePrompt(target: PromptTarget) {
  const initial = await snapshot(target);
  if (!initial.enrollment) throw new Error("This agent has no prompt enrollment to restore");
  return withLock(target, async () => {
    const s = await snapshot(target);
    if (!s.enrollment) throw new Error("Enrollment disappeared during restore");
    const codex = s.enrollment.runtimes.includes("codex");
    const pointer = codex ? s.pointer() : null;
    if (codex && pointer !== s.files.prompt && pointer !== s.enrollment.previousPointer) {
      throw new Error("Prompt pointer was changed by another writer; refusing to restore over it");
    }
    // A restart must not re-enroll while a restore is in progress.
    await replaceFile(s.files.state, s.state, serializeEnrollment({ ...s.enrollment, active: false }));
    const changed = codex ? await replaceFile(s.files.config, s.config, setPromptPointer(s.config ?? "", s.enrollment.previousPointer)) : false;
    return { changed, restored: true, runtimes: s.enrollment.runtimes, retainedPromptPath: s.files.prompt };
  });
}

export type FetchedPolicy = () => Promise<{ prompt: string; source: { url: string; revision: string } }>;

/**
 * Daily/explicit refresh of each enrolled runtime's fleet policy; it never rereads the agent
 * context. Every enrolled runtime is fetched before anything is written, so one failure leaves
 * all local state untouched. Then, in one locked write:
 * - Codex: only the policy prefix of the prompt file is replaced (the file keeps its inode when
 *   unchanged). Everything after `basePromptLength` is kept byte-for-byte, so a snapshot from an
 *   older sync keeps its frozen skills catalog tail until the next sync rewrites the file;
 * - Claude: only `claudePolicy` in the bundle is replaced; the prompt file is not touched for it.
 */
export async function refreshSharedPrompt(agentDir: string, fetchers: { codex?: FetchedPolicy; claude?: FetchedPolicy }, now = Date.now()) {
  const target = { agentDir, prompt: "" };
  return withLock(target, async () => {
    const s = await snapshot(target);
    if (!s.enrollment?.active) return { changed: false, skipped: true };
    const codex = s.enrollment.runtimes.includes("codex");
    const claude = s.enrollment.runtimes.includes("claude-cli");
    if ((codex && s.pointer() !== s.files.prompt) || s.prompt === null) throw new Error("Managed prompt pointer missing or changed; refusing refresh");
    const previousBundle = await readOptional(s.files.bundle);
    const bundle: unknown = JSON.parse(previousBundle ?? "null");
    if (!record(bundle) || bundle.schema !== 1 || bundle.promptSha256 !== sha256(s.prompt) || typeof bundle.policy !== "string" ||
        (codex && !bundle.remotePrompt)) {
      throw new Error("Valid enrolled remote snapshot required; run codex-prompt sync");
    }
    let previousClaude: ClaudePolicy | undefined;
    if (claude) {
      try { previousClaude = parseClaudePolicy(bundle.claudePolicy); } catch { throw new Error("Valid enrolled remote snapshot required; run codex-prompt sync"); }
      if (typeof bundle.agentContext !== "string" || !bundle.agentContext.trim()) throw new Error("Valid enrolled remote snapshot required; run codex-prompt sync");
    }
    // Every remote snapshot records its prefix length (0.1.0 onwards); the agent context after it
    // starts with one of the accepted boundary headings (current, 0.4 branch or 0.3).
    const boundary = bundle.basePromptLength;
    if (codex && (typeof boundary !== "number" || !Number.isInteger(boundary) || boundary <= 0 ||
        !CONTEXT_BOUNDARY_HEADERS.some(header => s.prompt!.slice(boundary).startsWith(header)))) {
      throw new Error("Frozen context boundary is ambiguous; run codex-prompt sync");
    }
    const [codexRemote, claudeRemote] = await Promise.all([codex ? fetchers.codex?.() : undefined, claude ? fetchers.claude?.() : undefined]);
    if ((codex && !codexRemote) || (claude && !claudeRemote)) throw new Error("Invalid shared prompt revision");
    for (const remote of [codexRemote, claudeRemote]) {
      if (remote && (!remote.prompt.trim() || remote.source.revision !== sha256(remote.prompt))) throw new Error("Invalid shared prompt revision");
    }
    if (await readOptional(s.files.config) !== s.config || await readOptional(s.files.state) !== s.state) throw new Error("Enrollment or configuration changed during refresh");
    const prompt = codexRemote ? codexRemote.prompt.trim() + s.prompt.slice(boundary as number) : s.prompt;
    const claudePolicy: ClaudePolicy | undefined = claudeRemote ? { text: claudeRemote.prompt.trim(), url: claudeRemote.source.url,
      revision: claudeRemote.source.revision, checkedAt: now } : undefined;
    const nextBundle = `${JSON.stringify({ ...bundle,
      ...codexRemote ? { basePromptLength: codexRemote.prompt.trim().length, remotePrompt: { ...codexRemote.source, checkedAt: now } } : {},
      ...claudePolicy ? { claudePolicy } : {}, promptSha256: sha256(prompt) }, null, 2)}\n`;
    const changed = await replaceFile(s.files.prompt, s.prompt, prompt);
    try { await replaceFile(s.files.bundle, previousBundle, nextBundle); }
    catch (error) {
      // Roll back the prompt if publishing its receipt failed; never overwrite a concurrent edit.
      if (changed) await replaceFile(s.files.prompt, prompt, s.prompt);
      throw error;
    }
    const claudeChanged = claudePolicy !== undefined && claudePolicy.text !== previousClaude?.text;
    // Codex's reviewed bridge resends the base file as each thread's base instructions, so a change
    // re-syncs existing threads on their next turn; Claude's prompt hook reads the policy every turn.
    return { changed: changed || claudeChanged, checkedAt: now,
      ...codexRemote ? { revision: codexRemote.source.revision, nextCodexTurn: changed } : {},
      ...claudeRemote ? { claudeRevision: claudeRemote.source.revision, nextClaudeProcess: claudeChanged } : {} };
  });
}
