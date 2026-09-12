import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readPromptPointer } from "./toml.js";

function readPrivate(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Frozen bridge refuses linked or non-regular state");
  return readFileSync(path, "utf8");
}

/** Called at the actual adapter assembly boundary; failures abort, not a swallowed hook. */
export function readFrozenPolicy(agentDir: string): string | null {
  const home = join(agentDir, "codex-home");
  const state: unknown = JSON.parse(readPrivate(join(home, ".unblock-codex-prompt.json")));
  if (!state || typeof state !== "object" || !("schema" in state) || state.schema !== 1 || !("active" in state) || typeof state.active !== "boolean") throw new Error("Invalid frozen bridge enrollment");
  if (!state.active) return null;
  const bundle: unknown = JSON.parse(readPrivate(join(home, ".unblock-codex-prompt-bundle.json")));
  if (!bundle || typeof bundle !== "object" || !("schema" in bundle) || bundle.schema !== 1 ||
      !("policy" in bundle) || typeof bundle.policy !== "string" || !bundle.policy.trim() || !("promptSha256" in bundle)) throw new Error("Frozen bundle missing or invalid; run codex-prompt sync");
  const path = join(home, "unblock-codex-prompt.md");
  if (readPromptPointer(readPrivate(join(home, "config.toml"))) !== path) throw new Error("Frozen prompt pointer changed; refusing context suppression");
  const hash = createHash("sha256").update(readPrivate(path)).digest("hex");
  if (hash !== bundle.promptSha256) throw new Error("Frozen prompt changed outside sync; refusing context suppression");
  return bundle.policy;
}
