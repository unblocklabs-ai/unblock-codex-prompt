import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readPromptPointer } from "./toml.js";
import { isCodexPolicyBoundary, parseClaudePolicy, parseEnrollment, parseStoredPolicy } from "./manager.js";
import { assertDedicatedCodexHome, configuredCodexHome } from "./codex-home.js";
import { managedTargetAgent } from "./managed-target.js";
import { classifyCodexModel, configuredCodexModelFamily, type CodexModelFamily } from "./model-family.js";
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
  let bundle: unknown;
  // A parse error would quote the start of the file; never let bundle text reach a log.
  try { bundle = JSON.parse(readPrivate(join(home, ".unblock-codex-prompt-bundle.json"))); }
  catch (error) { if (error instanceof SyntaxError) throw new Error("Frozen bundle missing or invalid; run codex-prompt sync"); throw error; }
  if (!bundle || typeof bundle !== "object" || !("schema" in bundle) || bundle.schema !== 1 ||
      !("policy" in bundle) || typeof bundle.policy !== "string" || !("promptSha256" in bundle)) throw new Error("Frozen bundle missing or invalid; run codex-prompt sync");
  const prompt = readPrivate(join(home, "unblock-codex-prompt.md"));
  if (sha256(prompt) !== bundle.promptSha256) throw new Error("Frozen prompt changed outside sync; refusing context suppression");
  return { bundle, policy: bundle.policy, prompt };
}

function readCodexSnapshot(agentDir: string, config?: unknown) {
  const home = join(agentDir, "codex-home");
  const state = readEnrollment(home);
  if (!state) throw new Error("Invalid frozen bridge enrollment");
  if (!state.active) return null;
  if (!state.runtimes.includes("codex")) throw new Error("Codex bridge installed without Codex enrollment; restore or run codex-prompt sync");
  if (config !== undefined && configuredCodexHome(config) !== state.codexHome) {
    throw new Error("Codex app-server home changed; restore and re-sync the prompt bridge");
  }
  if (state.codexHome) assertDedicatedCodexHome(state.codexHome, agentDir);
  const snapshot = readVerifiedSnapshot(home);
  if (readPromptPointer(readPrivate(join(state.codexHome ?? home, "config.toml"))) !== join(home, "unblock-codex-prompt.md")) {
    throw new Error("Frozen prompt pointer changed; refusing context suppression");
  }
  return snapshot;
}

/**
 * Called at the actual adapter assembly boundary; failures abort, not a swallowed hook. Non-null
 * means this Codex run is managed. The value is the bundle's `policy`, which current syncs leave
 * "": the Codex policy is the prompt-file prefix, delivered as base instructions.
 */
export function readFrozenPolicy(agentDir: string, config?: unknown): string | null {
  return readCodexSnapshot(agentDir, config)?.policy ?? null;
}

/**
 * The verified base instructions for a managed Codex thread at start and resume.
 * Picks the GPT-6.2 or standard Codex fleet policy from the active session's `modelId`
 * (falling back to the agent's primary model in `config`, then the bundle's recorded primary).
 * Codex reads base instructions per session rather than from history, so a refreshed policy
 * or a model switch reaches an existing thread when OpenClaw resumes it; the base file stays
 * the fallback. Lightweight runs take only the policy prefix, without the agent-context tail.
 */
export function readCodexBaseInstructions(agentDir: string, config?: unknown, contextMode?: "full" | "lightweight", modelId?: unknown): string | null {
  const snapshot = readCodexSnapshot(agentDir, config);
  if (!snapshot) return null;
  const { bundle, prompt } = snapshot;
  const family: CodexModelFamily = typeof modelId === "string" && modelId.trim()
    ? classifyCodexModel(modelId)
    : config !== undefined
      ? configuredCodexModelFamily(config, managedTargetAgent(config) ?? "main")
      : "codexPrimaryFamily" in bundle && bundle.codexPrimaryFamily === "gpt-6.2"
        ? "gpt-6.2"
        : "default";
  const hasSplitCodex = ("codexGpt62Policy" in bundle && bundle.codexGpt62Policy !== undefined) ||
    ("codexDefaultPolicy" in bundle && bundle.codexDefaultPolicy !== undefined);
  if (hasSplitCodex) {
    const selected = family === "gpt-6.2"
      ? parseStoredPolicy("codexGpt62Policy" in bundle ? bundle.codexGpt62Policy : undefined, "Codex GPT-6.2 policy")
      : parseStoredPolicy("codexDefaultPolicy" in bundle ? bundle.codexDefaultPolicy : undefined, "Codex default policy");
    const policyText = selected.text.trim();
    if (contextMode === "lightweight") return policyText;
    const boundary = "basePromptLength" in bundle ? bundle.basePromptLength : undefined;
    if (!isCodexPolicyBoundary(prompt, boundary)) {
      throw new Error("Frozen context boundary is ambiguous; run codex-prompt sync");
    }
    return `${policyText}${prompt.slice(boundary)}`;
  }
  if (contextMode !== "lightweight") return prompt;
  const boundary = "basePromptLength" in bundle ? bundle.basePromptLength : undefined;
  if (!isCodexPolicyBoundary(prompt, boundary)) {
    throw new Error("Frozen context boundary is ambiguous; run codex-prompt sync");
  }
  return prompt.slice(0, boundary);
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
