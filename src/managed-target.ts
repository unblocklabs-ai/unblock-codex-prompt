import { PLUGIN_ID } from "./config.js";

/**
 * Source of the "is this the managed target agent" predicate the patched Codex bridge inlines.
 * The generated function takes the run's params (`config`, `agentId`) and returns true only when:
 * the plugin is enabled and allowed, its entry is enabled with `frozenContext: true`, the run's
 * agent is the configured target (default `main`) and `eligible` (a JavaScript expression over
 * `params`, if given) holds. A managed run whose configured target is no longer the agent the
 * bridge was installed for throws `targetChanged` instead of managing the wrong agent.
 * It is generated inline, never loaded from the plugin, so a plugin rollback without restore
 * keeps the installed bridge's own gate.
 */
export function managedTargetSource(options: { name: string; agentId: string; targetChanged: string; eligible?: string }) {
  const id = JSON.stringify(PLUGIN_ID);
  const eligible = options.eligible ? ` || !(${options.eligible})` : "";
  return `function ${options.name}(params) {
  const plugins = params.config?.plugins;
  const entry = plugins?.entries?.[${id}];
  if (plugins?.enabled === false || entry?.enabled !== true || entry.config?.frozenContext !== true ||
      (Array.isArray(plugins.allow) && !plugins.allow.includes(${id}))) return false;
  const target = entry.config?.agentId ?? "main";
  if (params.agentId !== target${eligible}) return false;
  if (target !== ${JSON.stringify(options.agentId)}) throw new Error(${JSON.stringify(options.targetChanged)});
  return true;
}
`;
}

type Entry = { enabled?: unknown; config?: { frozenContext?: unknown; agentId?: unknown } };
type PluginsConfig = { enabled?: unknown; allow?: unknown; entries?: Record<string, Entry | undefined> };

/**
 * The same predicate, evaluated in the plugin (the Claude prompt hook): the configured target
 * agent when the plugin is enabled and allowed and its entry is enabled with
 * `frozenContext: true`, otherwise undefined. There is no installed agent to compare with: the
 * hook reads the configured target's own enrollment, so a retargeted, unenrolled agent is
 * simply unmanaged.
 */
export function managedTargetAgent(config: unknown): string | undefined {
  const plugins = (config as { plugins?: PluginsConfig } | undefined)?.plugins;
  const entry = plugins?.entries?.[PLUGIN_ID];
  if (plugins?.enabled === false || entry?.enabled !== true || entry.config?.frozenContext !== true ||
      (Array.isArray(plugins?.allow) && !plugins.allow.includes(PLUGIN_ID))) return undefined;
  const target = entry.config?.agentId ?? "main";
  return typeof target === "string" ? target : undefined;
}

export function isManagedTarget(config: unknown, agentId: unknown) {
  const target = managedTargetAgent(config);
  return target !== undefined && agentId === target;
}
