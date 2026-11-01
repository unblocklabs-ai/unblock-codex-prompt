import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_CONTEXT_HEADER, readOptional, type ClaudePolicy, type FrozenBundle } from "./manager.js";
import { assertSupportedVersion } from "./compatibility.js";
import { policyFetchers } from "./remote.js";

export async function openclawRoot() {
  let directory = dirname(fileURLToPath(import.meta.resolve("openclaw/plugin-sdk/agent-runtime")));
  for (;;) {
    const source = await readOptional(join(directory, "package.json"));
    if (source) {
      const pkg: unknown = JSON.parse(source);
      if (pkg && typeof pkg === "object" && "name" in pkg && pkg.name === "openclaw") {
        assertSupportedVersion("version" in pkg ? pkg.version : undefined, "OpenClaw");
        return directory;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error("Cannot locate the running OpenClaw package");
    directory = parent;
  }
}

/**
 * Shared agent-context sections, identical for every runtime. Identity and workspace files are
 * never snapshotted: each runtime delivers them live.
 */
function agentContextSections(workspaceDir: string) {
  return [`${AGENT_CONTEXT_HEADER.trimStart()}The runtime supplies this agent's identity and workspace files live (SOUL.md, IDENTITY.md, USER.md, AGENTS.md), together with actual tool schemas and current session context. This section does not grant tools or permissions.`,
    `## Memory reference\nWhen prior context matters, use the currently available memory tools and follow their schemas. If retrieval is unavailable, say so; do not invent results. The workspace memory reference is ${join(workspaceDir, "MEMORY.md")}. Its contents are not included here. Read it only when the active session's privacy policy permits; do not expose private memory in group or customer conversations.`].join("\n\n");
}

/**
 * Compile the prompt file and bundle for the enrolled runtimes. Skills are never compiled: both
 * runtimes receive OpenClaw's per-session skills catalog live.
 * - Codex (`base` given): the file is the Codex policy followed by the agent context. The bundle
 *   keeps `policy: ""`.
 * - Claude (`claude` given): the bundle also stores the Claude policy and the agent context text.
 * - Claude only (`base` null): nothing Codex-specific is built. The file holds just the agent
 *   context, so its hash still anchors the bundle and refresh has no prefix to replace.
 */
export async function compilePrompt(base: string | null, workspaceDir: string, claude?: ClaudePolicy) {
  if (base === null && !claude) throw new Error("compilePrompt needs a Codex base, a Claude policy, or both");
  const agentContext = agentContextSections(workspaceDir);
  const claudeFields = claude ? { claudePolicy: { ...claude, text: claude.text.trim() }, agentContext } : {};
  if (base === null) return { prompt: agentContext, bundle: { schema: 1 as const, policy: "", ...claudeFields } satisfies FrozenBundle };
  return { prompt: `${base.trim()}\n\n${agentContext}\n`, bundle: { schema: 1 as const, policy: "",
    basePromptLength: base.trim().length, ...claudeFields } satisfies FrozenBundle };
}

/**
 * Everything a sync needs before it may write: every enrolled runtime's policy is fetched first
 * (Codex without `runtime`, Claude with runtime=claude). Any failure throws here, so nothing has
 * been written.
 */
export async function fetchAndCompile(options: { codex: boolean; claude: boolean; promptUrl: string; workspaceDir: string;
  request?: typeof fetch; now?: number }) {
  const fetchers = policyFetchers(options.promptUrl, options.request);
  const [remote, claudeRemote] = await Promise.all([options.codex ? fetchers.codex() : undefined, options.claude ? fetchers.claude() : undefined]);
  const checkedAt = options.now ?? Date.now();
  const claudePolicy = claudeRemote ? { text: claudeRemote.prompt, ...claudeRemote.source, checkedAt } : undefined;
  const compiled = await compilePrompt(remote?.prompt ?? null, options.workspaceDir, claudePolicy);
  if (remote) Object.assign(compiled.bundle, { remotePrompt: { ...remote.source, checkedAt } });
  return { compiled, remote: remote?.source, claudePolicy: claudePolicy && { url: claudePolicy.url, revision: claudePolicy.revision, checkedAt } };
}
