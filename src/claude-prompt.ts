import { readFile, realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { ClaudeManagedContext } from "./runtime.js";

/**
 * The agent workspace files the Claude CLI prompt carries, in prompt order: OpenClaw's own
 * workspace bootstrap set (`WORKSPACE_BOOTSTRAP_FILENAMES`) without MEMORY.md, whose body stays out
 * of the prompt while the memory reference points to it. BOOTSTRAP.md is included only where
 * OpenClaw would include it: primary interactive runs (see `includeBootstrap`).
 */
export const CLAUDE_WORKSPACE_FILES = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "BOOTSTRAP.md"] as const;
/** OpenClaw's bootstrap defaults (2026.10.6 and 2026.10.9 `bootstrap-*.mjs`). */
export const DEFAULT_BOOTSTRAP_MAX_CHARS = 20_000;
export const DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS = 60_000;
export const USER_BOOTSTRAP_MAX_CHARS = 4_000;

/** OpenClaw shows BOOTSTRAP.md only on primary user/manual runs, never to subagents, heartbeats or cron. */
export function includeBootstrap(ctx: { trigger?: unknown; sessionKey?: unknown }) {
  const trigger = typeof ctx.trigger === "string" ? ctx.trigger : "user";
  return (trigger === "user" || trigger === "manual") && !(typeof ctx.sessionKey === "string" && ctx.sessionKey.includes(":subagent:"));
}
// OpenClaw's own read bound for a workspace bootstrap file.
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }

function agentEntry(config: unknown, agentId: string) {
  const agents = record(config) ? config.agents : undefined;
  if (!record(agents)) return undefined;
  if (Array.isArray(agents.list)) {
    const entry: unknown = agents.list.find((item: unknown) => record(item) && item.id === agentId);
    return record(entry) ? entry : undefined;
  }
  return record(agents.entries) && record(agents.entries[agentId]) ? agents.entries[agentId] as Record<string, unknown> : undefined;
}

/**
 * OpenClaw's per-file cap: the agent's `bootstrapMaxChars`, else `agents.defaults.bootstrapMaxChars`,
 * else 20000. A positive finite number is floored; anything else falls back, as OpenClaw does.
 */
function bootstrapLimit(config: unknown, agentId: string, key: "bootstrapMaxChars" | "bootstrapTotalMaxChars", fallback: number) {
  const agents = record(config) ? config.agents : undefined;
  const defaults = record(agents) && record(agents.defaults) ? agents.defaults : undefined;
  const raw = agentEntry(config, agentId)?.[key] ?? defaults?.[key];
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

export function bootstrapMaxChars(config: unknown, agentId: string) {
  return bootstrapLimit(config, agentId, "bootstrapMaxChars", DEFAULT_BOOTSTRAP_MAX_CHARS);
}

/** OpenClaw's total budget across all workspace files (default 60000). */
export function bootstrapTotalMaxChars(config: unknown, agentId: string) {
  return bootstrapLimit(config, agentId, "bootstrapTotalMaxChars", DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS);
}

/** Keeps the head of over-long content without splitting a surrogate pair. */
function cap(text: string, maxChars: number) {
  if (text.length <= maxChars) return text;
  const end = /[\uD800-\uDBFF]/u.test(text[maxChars - 1] ?? "") ? maxChars - 1 : maxChars;
  return text.slice(0, end).trimEnd();
}

function isMissing(error: unknown) {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

export type SkippedFile = { path: string; reason: string };

/**
 * A workspace file's text, or null when it is absent. Like OpenClaw, symlinks are followed only
 * within the workspace; a file resolving outside it, a non-regular file or one above OpenClaw's
 * read bound is skipped and reported.
 */
async function readWorkspaceFile(root: string, path: string, skipped: SkippedFile[]) {
  let real;
  try { real = await realpath(path); } catch (error) { if (isMissing(error)) return null; skipped.push({ path, reason: "unreadable" }); return null; }
  if (!real.startsWith(root + sep)) { skipped.push({ path, reason: "outside the workspace" }); return null; }
  try {
    const info = await stat(real);
    if (!info.isFile()) { skipped.push({ path, reason: "not a regular file" }); return null; }
    if (info.size > MAX_FILE_BYTES) { skipped.push({ path, reason: "larger than 2 MiB" }); return null; }
    return await readFile(real, "utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    skipped.push({ path, reason: "unreadable" });
    return null;
  }
}

/**
 * The complete Claude CLI system prompt for the managed agent: the Claude policy, the memory
 * reference, then each present, non-empty workspace file under its absolute path. Files are read
 * on every call, so an edit applies to the next turn. Nothing else is added.
 */
export async function buildClaudeSystemPrompt(managed: ClaudeManagedContext, workspaceDir: string, maxChars: number,
  options: { totalMaxChars?: number; includeBootstrap?: boolean } = {}) {
  let remaining = options.totalMaxChars ?? DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS;
  const workspace = resolve(workspaceDir);
  const skipped: SkippedFile[] = [];
  let root: string | null;
  try { root = await realpath(workspace); } catch (error) { if (!isMissing(error)) throw error; root = null; }
  const sections = [managed.policy, managed.agentContext];
  if (root !== null) {
    for (const name of CLAUDE_WORKSPACE_FILES) {
      if (name === "BOOTSTRAP.md" && options.includeBootstrap === false) continue;
      if (remaining <= 0) break;
      const path = join(workspace, name);
      // Leading blank lines and trailing whitespace go; indentation is kept.
      const text = (await readWorkspaceFile(root, path, skipped))?.replace(/^(?:[ \t]*\r?\n)+/u, "").trimEnd();
      if (!text?.trim()) continue;
      const body = cap(text, Math.min(remaining, name === "USER.md" ? Math.min(maxChars, USER_BOOTSTRAP_MAX_CHARS) : maxChars));
      remaining -= body.length;
      sections.push(`## ${path}\n${body}`);
    }
  }
  return { systemPrompt: sections.join("\n\n"), skipped };
}
