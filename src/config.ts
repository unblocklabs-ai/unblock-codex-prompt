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
  if (typeof agentId !== "string" || !/^[a-z0-9][a-z0-9_-]*$/u.test(agentId)) {
    throw new Error("agentId must be a lowercase OpenClaw agent ID");
  }
  // agentName remains accepted for existing configs; identity comes from agent documents.
  if (!("frozenContext" in value) || value.frozenContext !== true) {
    throw new Error("frozenContext must be true; base-only mode is no longer supported");
  }
  const promptUrl = "promptUrl" in value ? value.promptUrl : undefined;
  if (typeof promptUrl !== "string") throw new Error("promptUrl is required and must be an HTTPS URL");
  validatePromptUrl(promptUrl);
  const suppressExplicitDelegationPrompt = "suppressExplicitDelegationPrompt" in value ? value.suppressExplicitDelegationPrompt : false;
  if (typeof suppressExplicitDelegationPrompt !== "boolean") throw new Error("suppressExplicitDelegationPrompt must be boolean");
  const disabledCodexSkills = "disabledCodexSkills" in value ? value.disabledCodexSkills : DEFAULT_DISABLED_CODEX_SKILLS;
  if (!Array.isArray(disabledCodexSkills) || disabledCodexSkills.length > 64 ||
      disabledCodexSkills.some(entry => typeof entry !== "string" || !/^[\w.@:-]{1,128}$/u.test(entry)) || new Set(disabledCodexSkills).size !== disabledCodexSkills.length) {
    throw new Error("disabledCodexSkills must be a list of up to 64 unique skill or plugin names");
  }
  return { agentId, frozenContext: true as const, promptUrl, suppressExplicitDelegationPrompt, disabledCodexSkills: disabledCodexSkills as string[] };
}

export function validatePromptUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("promptUrl must use HTTPS without credentials or a fragment");
  }
  return url;
}
