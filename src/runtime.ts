import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readPromptPointer } from "./toml.js";
import { parseClaudePolicy, parseEnrollment } from "./manager.js";
export { normalizeOpenClawAdditions, normalizeOpenClawTurnContext } from "./context.js";

function readPrivate(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Frozen bridge refuses linked or non-regular state");
  return readFileSync(path, "utf8");
}

function readOptionalPrivate(path: string) {
  try { return readPrivate(path); } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function sha256(text: string) { return createHash("sha256").update(text).digest("hex"); }

function readEnrollment(home: string) {
  try { return parseEnrollment(readOptionalPrivate(join(home, ".unblock-codex-prompt.json"))); }
  catch (error) { throw error instanceof Error && error.message === "Invalid prompt enrollment state" ? new Error("Invalid frozen bridge enrollment") : error; }
}

/** The compiled snapshot, verified against its sync receipt. */
function readVerifiedSnapshot(home: string) {
  const bundle: unknown = JSON.parse(readPrivate(join(home, ".unblock-codex-prompt-bundle.json")));
  if (!bundle || typeof bundle !== "object" || !("schema" in bundle) || bundle.schema !== 1 ||
      !("policy" in bundle) || typeof bundle.policy !== "string" || !("promptSha256" in bundle)) throw new Error("Frozen bundle missing or invalid; run codex-prompt sync");
  const prompt = readPrivate(join(home, "unblock-codex-prompt.md"));
  if (sha256(prompt) !== bundle.promptSha256) throw new Error("Frozen prompt changed outside sync; refusing context suppression");
  return { bundle, policy: bundle.policy, prompt };
}

function readCodexSnapshot(agentDir: string) {
  const home = join(agentDir, "codex-home");
  const state = readEnrollment(home);
  if (!state) throw new Error("Invalid frozen bridge enrollment");
  if (!state.active) return null;
  if (!state.runtimes.includes("codex")) throw new Error("Codex bridge installed without Codex enrollment; restore or run codex-prompt sync");
  const snapshot = readVerifiedSnapshot(home);
  if (readPromptPointer(readPrivate(join(home, "config.toml"))) !== join(home, "unblock-codex-prompt.md")) {
    throw new Error("Frozen prompt pointer changed; refusing context suppression");
  }
  return snapshot;
}

/**
 * Called at the actual adapter assembly boundary; failures abort, not a swallowed hook. Non-null
 * means this Codex run is managed. The value is the bundle's `policy`, which current syncs leave
 * "": the Codex policy is the prompt-file prefix, delivered as base instructions.
 */
export function readFrozenPolicy(agentDir: string): string | null {
  return readCodexSnapshot(agentDir)?.policy ?? null;
}

/**
 * The verified base file, sent as each managed thread's base instructions at start and resume.
 * Codex reads base instructions per session rather than from history, so a refreshed file
 * reaches an existing thread when OpenClaw resumes it; the file itself stays the fallback.
 */
export function readCodexBaseInstructions(agentDir: string): string | null {
  return readCodexSnapshot(agentDir)?.prompt ?? null;
}

export type ClaudeManagedPrompt = { prompt: string; sha256: string };

/**
 * Called from the reviewed OpenClaw CLI prompt assembly. Returns null while management is
 * paused (restored); throws, aborting the run, when enrolled state is missing, invalid or
 * tampered. The prompt is the Claude policy followed by the shared agent context, both read from
 * the bundle: it never touches the Codex policy (the prompt-file prefix). Skills reach Claude live,
 * through OpenClaw's native skills mount or the session skills prompt. The bundle is the trust
 * root, and readVerifiedSnapshot checks the prompt file against its promptSha256.
 */
export function readClaudeManagedPrompt(agentDir: string): ClaudeManagedPrompt | null {
  const home = join(agentDir, "codex-home");
  const state = readEnrollment(home);
  if (!state) throw new Error("Claude bridge installed without enrollment; restore or run codex-prompt sync");
  if (!state.active) return null;
  if (!state.runtimes.includes("claude-cli")) throw new Error("Claude bridge installed without Claude CLI enrollment; restore or run codex-prompt sync");
  const { bundle } = readVerifiedSnapshot(home);
  const claudePolicy = parseClaudePolicy("claudePolicy" in bundle ? bundle.claudePolicy : undefined);
  const agentContext = "agentContext" in bundle ? bundle.agentContext : undefined;
  if (typeof agentContext !== "string" || !agentContext.trim()) throw new Error("Claude policy missing or invalid; run codex-prompt sync");
  const managed = `${claudePolicy.text}\n\n${agentContext}`;
  return { prompt: managed, sha256: sha256(managed) };
}

/** OpenClaw's generic CLI identity line; its presence means the managed assembly was lost. */
export const GENERIC_CLI_POLICY_MARKER = "You are a personal assistant running inside OpenClaw.";

export type ClaudeAdoption = { outcome: "unmanaged" } | { outcome: "pass" } | { outcome: "block"; reason: string };

/**
 * Final-adoption check for an enrolled Claude CLI run. Never-enrolled and restored agents
 * stay upstream. Prompt text is compared only; it is never returned or logged.
 */
export function checkClaudeAdoption(agentDir: string, systemPrompt: string | undefined): ClaudeAdoption {
  const home = join(agentDir, "codex-home");
  let state;
  try { state = readEnrollment(home); } catch { return { outcome: "block", reason: "Managed enrollment state is invalid; inspect codex-prompt status" }; }
  if (!state?.active || !state.runtimes.includes("claude-cli")) return { outcome: "unmanaged" };
  let managed;
  try { managed = readClaudeManagedPrompt(agentDir); } catch { return { outcome: "block", reason: "Managed snapshot is invalid or changed outside sync; run codex-prompt sync" }; }
  if (!managed) return { outcome: "unmanaged" };
  if (typeof systemPrompt !== "string") return { outcome: "block", reason: "The final system prompt is unavailable to verify managed policy" };
  if (systemPrompt.includes(GENERIC_CLI_POLICY_MARKER)) {
    return { outcome: "block", reason: "Generic OpenClaw policy is present: the Claude assembly patch is missing or inactive; restore, re-sync and restart the Gateway" };
  }
  if (!systemPrompt.includes(managed.prompt)) {
    return { outcome: "block", reason: "Managed policy was replaced or altered after assembly, for example by a prompt hook or registered text transform; review those plugins" };
  }
  return { outcome: "pass" };
}
