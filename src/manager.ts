import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readPromptPointer, setPromptPointer } from "./toml.js";

type Enrollment = { schema: 1; active: boolean; previousPointer: string | null };
export type FrozenBundle = { schema: 1; policy: string; sources: { name: string; sha256: string | null }[]; skillCount: number; basePromptLength?: number; remotePrompt?: { url: string; revision: string; checkedAt?: number } };
export const FROZEN_CONTEXT_HEADER = "\n\n## Frozen agent context\n";
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

function parseEnrollment(source: string | null): Enrollment | null {
  if (source === null) return null;
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new Error("Invalid prompt enrollment state"); }
  if (!value || typeof value !== "object" || !("schema" in value) || value.schema !== 1 ||
      !("active" in value) || typeof value.active !== "boolean" || !("previousPointer" in value) ||
      (value.previousPointer !== null && typeof value.previousPointer !== "string")) {
    throw new Error("Invalid prompt enrollment state");
  }
  return { schema: 1, active: value.active, previousPointer: value.previousPointer };
}

async function snapshot(target: PromptTarget) {
  const files = paths(target);
  await assertDirectoryChain(files.home);
  const [config, prompt, state] = await Promise.all([
    readOptional(files.config), readOptional(files.prompt), readOptional(files.state),
  ]);
  return { files, config, prompt, state, pointer: readPromptPointer(config ?? ""), enrollment: parseEnrollment(state) };
}

export function sha256(text: string) { return createHash("sha256").update(text).digest("hex"); }

/** Disk state only: this cannot attest to instructions retained by a live Codex thread. */
export async function promptStatus(target: PromptTarget) {
  const s = await snapshot(target);
  return {
    enrolled: s.enrollment?.active === true,
    restored: s.enrollment?.active === false,
    configPath: s.files.config,
    promptPath: s.files.prompt,
    pointerMatches: s.pointer === s.files.prompt,
    promptMatches: s.prompt === target.prompt,
    expectedSha256: sha256(target.prompt),
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

export async function syncPrompt(target: PromptTarget, options: { adopt?: boolean; automatic?: boolean } = {}) {
  if (!target.prompt.trim()) throw new Error("Refusing an empty base prompt");
  // Reject invalid state before creating even the lock directory.
  await snapshot(target);
  return withLock(target, async () => {
    const s = await snapshot(target);
    if (s.enrollment?.active === false && options.automatic) return { changed: false, restored: true };
    if (s.pointer !== null && s.pointer !== s.files.prompt && !options.adopt) {
      throw new Error("A different model_instructions_file is configured. Review it, then run openclaw codex-prompt sync --adopt to take ownership.");
    }
    if (!s.enrollment && (s.prompt !== null || s.pointer === s.files.prompt)) {
      throw new Error("Managed prompt exists without enrollment state; recover the state before syncing");
    }
    const enrollment: Enrollment = s.enrollment?.active ? s.enrollment : {
      schema: 1, active: true, previousPointer: s.pointer,
    };
    const nextConfig = setPromptPointer(s.config ?? "", s.files.prompt);
    // Save rollback information first; point Codex at the file only after it exists.
    const stateChanged = await replaceFile(s.files.state, s.state, `${JSON.stringify(enrollment, null, 2)}\n`);
    const promptChanged = await replaceFile(s.files.prompt, s.prompt, target.prompt);
    const bundleChanged = target.bundle ? await replaceFile(s.files.bundle, await readOptional(s.files.bundle),
      `${JSON.stringify({ ...target.bundle, promptSha256: sha256(target.prompt) }, null, 2)}\n`) : false;
    const configChanged = await replaceFile(s.files.config, s.config, nextConfig);
    return { changed: stateChanged || promptChanged || configChanged || bundleChanged, promptChanged, configChanged, sha256: sha256(target.prompt), activation: "Restart the managed app-server and use a new Codex session; existing threads may retain old instructions." };
  });
}

export async function restorePrompt(target: PromptTarget) {
  const initial = await snapshot(target);
  if (!initial.enrollment) throw new Error("This agent has no prompt enrollment to restore");
  return withLock(target, async () => {
    const s = await snapshot(target);
    if (!s.enrollment) throw new Error("Enrollment disappeared during restore");
    if (s.pointer !== s.files.prompt && s.pointer !== s.enrollment.previousPointer) {
      throw new Error("Prompt pointer was changed by another writer; refusing to restore over it");
    }
    const nextConfig = setPromptPointer(s.config ?? "", s.enrollment.previousPointer);
    // A restart must not re-enroll while a restore is in progress.
    await replaceFile(s.files.state, s.state, `${JSON.stringify({ ...s.enrollment, active: false }, null, 2)}\n`);
    const changed = await replaceFile(s.files.config, s.config, nextConfig);
    return { changed, restored: true, retainedPromptPath: s.files.prompt };
  });
}

/** Replace only the shared prefix; never reread workspace documents or skills. */
export async function refreshSharedPrompt(agentDir: string, fetchBase: () => Promise<{ prompt: string; source: { url: string; revision: string } }>, now = Date.now()) {
  const target = { agentDir, prompt: "" };
  return withLock(target, async () => {
    const s = await snapshot(target);
    if (!s.enrollment?.active) return { changed: false, skipped: true };
    if (s.pointer !== s.files.prompt || s.prompt === null) throw new Error("Managed prompt pointer missing or changed; refusing refresh");
    const previousBundle = await readOptional(s.files.bundle);
    const bundle: unknown = JSON.parse(previousBundle ?? "null");
    if (!bundle || typeof bundle !== "object" || !("schema" in bundle) || bundle.schema !== 1 ||
        !("promptSha256" in bundle) || bundle.promptSha256 !== sha256(s.prompt) ||
        !("policy" in bundle) || typeof bundle.policy !== "string" || !bundle.policy.trim() ||
        !("remotePrompt" in bundle) || !bundle.remotePrompt) {
      throw new Error("Valid enrolled remote snapshot required; run codex-prompt sync");
    }
    // Legacy snapshots can migrate only when the compiler boundary is unambiguous.
    const boundary = "basePromptLength" in bundle ? bundle.basePromptLength : s.prompt.indexOf(FROZEN_CONTEXT_HEADER);
    if (typeof boundary !== "number" || !Number.isInteger(boundary) || boundary <= 0 ||
        !s.prompt.slice(boundary).startsWith(FROZEN_CONTEXT_HEADER) ||
        (!("basePromptLength" in bundle) && boundary !== s.prompt.lastIndexOf(FROZEN_CONTEXT_HEADER))) {
      throw new Error("Frozen context boundary is ambiguous; run codex-prompt sync");
    }
    const remote = await fetchBase();
    if (!remote.prompt.trim() || remote.source.revision !== sha256(remote.prompt)) throw new Error("Invalid shared prompt revision");
    if (await readOptional(s.files.config) !== s.config || await readOptional(s.files.state) !== s.state) throw new Error("Enrollment or configuration changed during refresh");
    const prompt = remote.prompt.trim() + s.prompt.slice(boundary);
    const nextBundle = `${JSON.stringify({ ...bundle, basePromptLength: remote.prompt.trim().length,
      remotePrompt: { ...remote.source, checkedAt: now }, promptSha256: sha256(prompt) }, null, 2)}\n`;
    const changed = await replaceFile(s.files.prompt, s.prompt, prompt);
    try { await replaceFile(s.files.bundle, previousBundle, nextBundle); }
    catch (error) {
      // Roll back the prompt if publishing its receipt failed; never overwrite a concurrent edit.
      if (changed) await replaceFile(s.files.prompt, prompt, s.prompt);
      throw error;
    }
    return { changed, revision: remote.source.revision, checkedAt: now, newSessionRequired: changed };
  });
}
