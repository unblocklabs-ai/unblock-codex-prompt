import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Runs the real-OpenClaw check (scripts/validate-claude-hook.mjs) against the development
// dependency: OpenClaw's own hook registrar, hook runner and CLI turn prompt context.
test("against the installed OpenClaw, the plugin's before_prompt_build systemPrompt replaces the Claude CLI system prompt", () => {
  const script = fileURLToPath(new URL("../scripts/validate-claude-hook.mjs", import.meta.url));
  const output = execFileSync(process.execPath, [script], { encoding: "utf8" });
  assert.match(output, /^OpenClaw 2026\.\d+\.\d+ \([^)]*\): before_prompt_build systemPrompt replaces the Claude CLI system prompt/mu);
});
