import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import type { ManagedRuntime } from "./manager.js";

type PolicyResolver = (params: { config: OpenClawConfig; provider?: string; modelId?: string; agentId?: string }) => { policy?: { id?: unknown } } | undefined;
type Detection = { ref: string; runtime: string | null };

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }

/** OpenClaw's public configured-policy resolver (2026.10.6+), feature-detected for older hosts. */
export function runtimePolicyResolver(api: unknown): PolicyResolver | undefined {
  const runtime = record(api) ? api.runtime : undefined;
  const modelConfig = record(runtime) ? runtime.modelConfig : undefined;
  const resolve = record(modelConfig) ? modelConfig.resolveModelRuntimePolicy : undefined;
  return typeof resolve === "function" ? resolve as PolicyResolver : undefined;
}

function agentEntry(config: OpenClawConfig, agentId: string) {
  const agents: unknown = (config as Record<string, unknown>).agents;
  if (!record(agents)) return undefined;
  if (Array.isArray(agents.list)) return agents.list.find((entry: unknown) => record(entry) && entry.id === agentId) as Record<string, unknown> | undefined;
  return record(agents.entries) && record(agents.entries[agentId]) ? agents.entries[agentId] as Record<string, unknown> : undefined;
}

function primaryOf(model: unknown) {
  const value = typeof model === "string" ? model : record(model) ? model.primary : undefined;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** OpenClaw's fallback override: an agent model replaces default fallbacks unless it lists its own. */
function fallbacksOverride(model: unknown): unknown[] | undefined {
  if (!model) return undefined;
  if (typeof model === "string") return primaryOf(model) ? [] : undefined;
  if (!record(model)) return undefined;
  if (!Object.hasOwn(model, "fallbacks")) return Object.hasOwn(model, "primary") && primaryOf(model) ? [] : undefined;
  return Array.isArray(model.fallbacks) ? model.fallbacks : undefined;
}

/**
 * Model refs the agent can select by configuration, resolved like OpenClaw: the agent's model
 * replaces the default primary (and default fallbacks unless it lists its own), plus the agent's
 * own allowed-model map, which it can switch to at run time. The Gateway-wide default map
 * (agents.defaults.models) does not enroll a runtime for this agent.
 */
export function configuredModelRefs(config: OpenClawConfig, agentId: string) {
  const agents: unknown = (config as Record<string, unknown>).agents;
  const defaults = record(agents) && record(agents.defaults) ? agents.defaults : undefined;
  const agent = agentEntry(config, agentId);
  const refs = new Set<string>();
  const add = (value: unknown) => { if (typeof value === "string" && value.trim()) refs.add(value.trim()); };
  add(primaryOf(agent?.model) ?? primaryOf(defaults?.model));
  const fallbacks = fallbacksOverride(agent?.model) ?? (record(defaults?.model) && Array.isArray(defaults.model.fallbacks) ? defaults.model.fallbacks : []);
  fallbacks.forEach(add);
  if (record(agent?.models)) Object.keys(agent.models).forEach(add);
  return [...refs];
}

/**
 * Explicit-sync detection only. This reads authored policy; it does not establish runtime
 * availability. Each turn's actual execution path stays authoritative at the patched seams.
 */
export function detectConfiguredRuntimes(config: OpenClawConfig, agentId: string, resolve: PolicyResolver | undefined) {
  const detections: Detection[] = configuredModelRefs(config, agentId).map(ref => {
    const slash = ref.indexOf("/");
    const provider = slash > 0 ? ref.slice(0, slash) : undefined;
    const modelId = slash > 0 ? ref.slice(slash + 1) : ref;
    // Legacy `claude-cli/<model>` refs name the CLI backend directly (OpenClaw compatibility input).
    if (provider?.toLowerCase() === "claude-cli") return { ref, runtime: "claude-cli" };
    let id: unknown;
    try { id = resolve?.({ config, agentId, ...provider ? { provider } : {}, modelId })?.policy?.id; } catch { id = undefined; }
    return { ref, runtime: typeof id === "string" && id.trim() ? id.trim().toLowerCase() : null };
  });
  const runtimes = new Set<ManagedRuntime>();
  for (const { runtime } of detections) if (runtime === "codex" || runtime === "claude-cli") runtimes.add(runtime);
  return { runtimes, detections, resolver: resolve ? "openclaw" as const : "unavailable" as const };
}
