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

export type ClaudeManagedContext = { policy: string; agentContext: string };

/**
 * The Claude policy and the shared agent context (memory reference), both read from the bundle,
 * for the Claude CLI prompt hook. Null unless this agent has an active enrollment that includes
 * Claude CLI (never enrolled, paused by restore, or Codex only). Throws when that enrolled state
 * is invalid or tampered: the bundle is the trust root, and readVerifiedSnapshot checks the prompt
 * file against its promptSha256. It never touches the Codex policy (the prompt-file prefix).
 */
export function readClaudeManagedContext(agentDir: string): ClaudeManagedContext | null {
  const home = join(agentDir, "codex-home");
  const state = readEnrollment(home);
  if (!state?.active || !state.runtimes.includes("claude-cli")) return null;
  const { bundle } = readVerifiedSnapshot(home);
  const claudePolicy = parseClaudePolicy("claudePolicy" in bundle ? bundle.claudePolicy : undefined);
  const agentContext = "agentContext" in bundle ? bundle.agentContext : undefined;
  if (typeof agentContext !== "string" || !agentContext.trim()) throw new Error("Claude policy missing or invalid; run codex-prompt sync");
  return { policy: claudePolicy.text.trim(), agentContext: agentContext.trim() };
}
