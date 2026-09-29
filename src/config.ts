export const PLUGIN_ID = "unblock-codex-prompt";
// ChatGPT Pages and Pets skills reach Codex through remote plugins and do not apply to OpenClaw agents.
export const DEFAULT_DISABLED_CODEX_SKILLS = ["pages", "work-pets"];

export function parseConfig(raw: unknown) {
  const value = raw ?? {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Plugin config must be an object");
  for (const key of Object.keys(value)) {
    if (key !== "agentId" && key !== "agentName" && key !== "frozenContext" && key !== "promptUrl" && key !== "suppressExplicitDelegationPrompt" && key !== "disabledCodexSkills") throw new Error(`Unknown plugin option: ${key}`);
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
  const frozenContext = "frozenContext" in value ? value.frozenContext : false;
  if (typeof frozenContext !== "boolean") throw new Error("frozenContext must be boolean");
  const promptUrl = "promptUrl" in value ? value.promptUrl : undefined;
  if (promptUrl !== undefined) {
    if (typeof promptUrl !== "string") throw new Error("promptUrl must be an HTTPS URL");
    validatePromptUrl(promptUrl);
    if (!frozenContext) throw new Error("promptUrl requires frozenContext to replace the OpenClaw policy too");
  }
  const suppressExplicitDelegationPrompt = "suppressExplicitDelegationPrompt" in value ? value.suppressExplicitDelegationPrompt : false;
  if (typeof suppressExplicitDelegationPrompt !== "boolean") throw new Error("suppressExplicitDelegationPrompt must be boolean");
  if (suppressExplicitDelegationPrompt && !frozenContext) throw new Error("suppressExplicitDelegationPrompt requires frozenContext");
  const disabledCodexSkills = "disabledCodexSkills" in value ? value.disabledCodexSkills : DEFAULT_DISABLED_CODEX_SKILLS;
  if (!Array.isArray(disabledCodexSkills) || disabledCodexSkills.length > 64 ||
      disabledCodexSkills.some(entry => typeof entry !== "string" || !/^[\w.@:-]{1,128}$/u.test(entry)) || new Set(disabledCodexSkills).size !== disabledCodexSkills.length) {
    throw new Error("disabledCodexSkills must be a list of up to 64 unique skill or plugin names");
  }
  return { agentId, agentName: agentName?.trim(), frozenContext, promptUrl, suppressExplicitDelegationPrompt, disabledCodexSkills: disabledCodexSkills as string[] };
}

export function validatePromptUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("promptUrl must use HTTPS without credentials or a fragment");
  }
  return url;
}

export function renderPrompt(template: string, agentName?: string) {
  if (template.split("{{identity}}").length !== 2) throw new Error("Prompt template must contain exactly one identity placeholder");
  return template.replace("{{identity}}", () => agentName ? `${agentName}, an OpenClaw agent` : "an OpenClaw agent");
}
