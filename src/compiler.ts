import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MEMORY_REFERENCE_HEADER, readOptional, type ClaudePolicy, type FrozenBundle } from "./manager.js";
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
 * Shared agent context, identical for every runtime: a pointer to the memory tools and the
 * workspace MEMORY.md. Identity and workspace files reach each runtime through its own assembly.
 */
function agentContextText(workspaceDir: string) {
  return `${MEMORY_REFERENCE_HEADER.trimStart()}When prior context matters, use the available memory tools and follow their schemas. If retrieval is unavailable, say so; do not invent results. The workspace memory reference is ${join(workspaceDir, "MEMORY.md")}. Read it only when the active session's privacy policy permits; do not expose private memory in group or customer conversations.`;
}

/**
 * Compile the prompt file and bundle for the enrolled runtimes. Skills are never compiled: both
 * runtimes receive OpenClaw's per-session skills catalog through their own assembly.
 * - Codex (`base` given): the file is the Codex policy followed by the agent context. The bundle
 *   keeps `policy: ""`.
 * - Claude (`claude` given): the bundle also stores the Claude policy and the agent context text.
 * - Claude only (`base` null): nothing Codex-specific is built. The file holds just the agent
 *   context, so its hash still anchors the bundle and refresh has no prefix to replace.
 */
export async function compilePrompt(base: string | null, workspaceDir: string, claude?: ClaudePolicy) {
  if (base === null && !claude) throw new Error("compilePrompt needs a Codex base, a Claude policy, or both");
  const agentContext = agentContextText(workspaceDir);
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
