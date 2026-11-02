import { PLUGIN_ID } from "./config.js";

/**
 * Source of the one "is this the managed target agent" predicate both patched bridges inline.
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
