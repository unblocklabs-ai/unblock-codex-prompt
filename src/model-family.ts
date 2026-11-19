export type CodexModelFamily = "default" | "gpt-6.2";

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function agentEntry(config: unknown, agentId: string) {
  const agents = record(config) ? config.agents : undefined;
  if (!record(agents)) return undefined;
  if (Array.isArray(agents.list)) {
    const entry: unknown = agents.list.find((item: unknown) => record(item) && item.id === agentId);
    return record(entry) ? entry : undefined;
  }
  return record(agents.entries) && record(agents.entries[agentId]) ? agents.entries[agentId] as Record<string, unknown> : undefined;
}

function primaryOf(model: unknown) {
  const value = typeof model === "string" ? model : record(model) ? model.primary : undefined;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Primary model ref configured for an agent in openclaw.json (agent override, else defaults). */
export function primaryConfiguredModel(config: unknown, agentId: string): string | undefined {
  const agents = record(config) ? config.agents : undefined;
  const defaults = record(agents) && record(agents.defaults) ? agents.defaults : undefined;
  const agent = agentEntry(config, agentId);
  return primaryOf(agent?.model) ?? primaryOf(defaults?.model);
}

/**
 * Strip any provider prefix (e.g. `openai/gpt-6.2-astra` -> `gpt-6.2-astra`) and classify
 * whether a Codex model belongs to the GPT-6.2 family (`gpt-6.2`, `gpt-6.2-astra`, `gpt-6.2-sol`, ...).
 */
export function classifyCodexModel(modelId: unknown): CodexModelFamily {
  if (typeof modelId !== "string") return "default";
  const trimmed = modelId.trim();
  if (!trimmed) return "default";
  const slash = trimmed.lastIndexOf("/");
  const bare = (slash >= 0 ? trimmed.slice(slash + 1) : trimmed).trim();
  return /^gpt-6\.2(?:$|[-_.@])/iu.test(bare) ? "gpt-6.2" : "default";
}

export function configuredCodexModelFamily(config: unknown, agentId: string): CodexModelFamily {
  return classifyCodexModel(primaryConfiguredModel(config, agentId));
}
