export const PLUGIN_ID = "unblock-codex-prompt";

export function parseConfig(raw: unknown) {
  const value = raw ?? {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Plugin config must be an object");
  for (const key of Object.keys(value)) {
    if (key !== "agentId" && key !== "agentName") throw new Error(`Unknown plugin option: ${key}`);
  }
  const agentId = "agentId" in value ? value.agentId : "main";
  const agentName = "agentName" in value ? value.agentName : undefined;
  if (typeof agentId !== "string" || !/^[a-z0-9][a-z0-9_-]*$/u.test(agentId)) {
    throw new Error("agentId must be a lowercase OpenClaw agent ID");
  }
  if (agentName !== undefined && (typeof agentName !== "string" || !agentName.trim() ||
      agentName.length > 100 || /\p{C}/u.test(agentName))) {
    throw new Error("agentName must be 1–100 characters without control characters");
  }
  return { agentId, agentName: agentName?.trim() };
}

export function renderPrompt(template: string, agentName?: string) {
  if (template.split("{{identity}}").length !== 2) throw new Error("Prompt template must contain exactly one identity placeholder");
  return template.replace("{{identity}}", () => agentName ? `${agentName}, an OpenClaw agent` : "an OpenClaw agent");
}
