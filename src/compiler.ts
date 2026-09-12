import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { readOptional, sha256, type FrozenBundle } from "./manager.js";

export const SUPPORTED_OPENCLAW = "2026.9.2";

export async function openclawRoot() {
  let directory = dirname(fileURLToPath(import.meta.resolve("openclaw/plugin-sdk/agent-runtime")));
  for (;;) {
    const source = await readOptional(join(directory, "package.json"));
    if (source) {
      const pkg: unknown = JSON.parse(source);
      if (pkg && typeof pkg === "object" && "name" in pkg && pkg.name === "openclaw") {
        if (!("version" in pkg) || pkg.version !== SUPPORTED_OPENCLAW) throw new Error(`Frozen bridge supports OpenClaw ${SUPPORTED_OPENCLAW} only; review upgrades before syncing`);
        return directory;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error("Cannot locate the running OpenClaw package");
    directory = parent;
  }
}

// OpenClaw has no public catalog-building SDK. Pin this single internal export,
// retaining its eligibility, agent allowlist, prompt visibility and size limits.
export async function buildSkillsCatalog(config: OpenClawConfig, agentId: string, workspaceDir: string) {
  const dist = join(await openclawRoot(), "dist");
  const names = (await readdir(dist)).filter(name => /^workspace-skill-prompt-[\w-]+\.js$/u.test(name));
  if (names.length !== 1) throw new Error("Unsupported OpenClaw skills module layout");
  const path = join(dist, names[0]!);
  const source = await readFile(path, "utf8");
  if (!source.includes("buildSkillSnapshot as t")) throw new Error("Unsupported OpenClaw skills export");
  const module: { t?: (workspace: string, options: { config: OpenClawConfig; agentId: string }) => unknown } = await import(pathToFileURL(path).href);
  if (typeof module.t !== "function") throw new Error("Missing OpenClaw skill snapshot builder");
  const result = module.t(workspaceDir, { config, agentId });
  if (!result || typeof result !== "object" || !("prompt" in result) || typeof result.prompt !== "string" ||
      !("resolvedSkills" in result) || !Array.isArray(result.resolvedSkills)) throw new Error("Unsupported OpenClaw skill snapshot result");
  return { prompt: result.prompt, count: result.resolvedSkills.length };
}

export async function compilePrompt(base: string, policy: string, workspaceDir: string, catalog: { prompt: string; count: number }) {
  const sources: FrozenBundle["sources"] = [];
  const sections = [base.trim(), "## Frozen agent context\nThis context is a local snapshot, refreshed explicitly by the operator. Native AGENTS.md, native skills, actual tool schemas and current session context remain separate. This snapshot does not grant tools or permissions."];
  for (const name of ["SOUL.md", "IDENTITY.md", "USER.md"]) {
    const content = await readOptional(join(workspaceDir, name));
    sources.push({ name, sha256: content === null ? null : sha256(content) });
    if (content?.trim()) sections.push(`### ${name}\n${content.trim()}`);
  }
  sections.push(`## Frozen memory reference\nWhen prior context matters, use the currently available memory tools and follow their schemas. If retrieval is unavailable, say so; do not invent results. The workspace memory reference is ${join(workspaceDir, "MEMORY.md")}. Its contents are not included here. Read it only when the active session's privacy policy permits; do not expose private memory in group or customer conversations.`);
  sources.push({ name: "OpenClaw skills catalog", sha256: sha256(catalog.prompt) });
  sections.push(`## Frozen OpenClaw skills catalog\nThis is the approved agent-workspace catalog at sync time, not a promise that credentials or tools remain available. Session-local skill selection and execution-directory skill discovery do not refresh this snapshot. Use the native catalog separately.\n\n${catalog.prompt.trim() || "No eligible model-visible OpenClaw skills at sync time."}`);
  return { prompt: `${sections.join("\n\n")}\n`, bundle: { schema: 1 as const, policy: policy.trim(), sources, skillCount: catalog.count, basePromptLength: base.trim().length } };
}
