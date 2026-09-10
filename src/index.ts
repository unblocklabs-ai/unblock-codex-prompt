import { readFile } from "node:fs/promises";
import { listAgentIds, resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import { definePluginEntry, type OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { parseConfig, PLUGIN_ID, renderPrompt } from "./config.js";
import { promptStatus, restorePrompt, syncPrompt } from "./manager.js";

async function resolveTarget(config: OpenClawConfig) {
  const settings = parseConfig(config.plugins?.entries?.[PLUGIN_ID]?.config);
  if (!listAgentIds(config).includes(settings.agentId)) throw new Error(`Unknown OpenClaw agent: ${settings.agentId}`);
  const codexConfig = config.plugins?.entries?.codex?.config;
  const appServer = codexConfig?.appServer;
  if (appServer !== undefined) {
    if (!appServer || typeof appServer !== "object" || Array.isArray(appServer)) throw new Error("Invalid Codex appServer config");
    if (("transport" in appServer && appServer.transport !== "stdio") ||
        ("homeScope" in appServer && appServer.homeScope !== "agent") ||
        ("command" in appServer && appServer.command !== undefined)) {
      throw new Error("Only OpenClaw-managed, agent-scoped local stdio Codex is supported");
    }
    if ("args" in appServer && appServer.args !== undefined) {
      throw new Error("Custom Codex appServer.args may override the prompt; remove them or manage the prompt outside this plugin");
    }
  }
  const template = await readFile(new URL("../prompts/system.md", import.meta.url), "utf8");
  return { agentDir: resolveAgentDir(config, settings.agentId), prompt: renderPrompt(template, settings.agentName) };
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Unblock Codex Prompt",
  description: "Manage the shared Codex base prompt without replacing OpenClaw's developer instructions.",
  register(api) {
    // Registration/import stays read-only, including plugin inspection and CLI discovery.
    api.registerService({
      id: PLUGIN_ID,
      reload: { configPrefixes: [`plugins.entries.${PLUGIN_ID}.config`] },
      async start(ctx) {
        const result = await syncPrompt(await resolveTarget(ctx.config), { automatic: true });
        ctx.logger.info(`${PLUGIN_ID}: ${JSON.stringify(result)}`);
      },
    });
    api.registerCli(({ program, config }) => {
      const root = program.command("codex-prompt").description("Manage this agent's Codex base prompt (JSON output)");
      root.command("status").description("Inspect disk state without writing or claiming live adoption")
        .action(async () => { console.log(JSON.stringify(await promptStatus(await resolveTarget(config)), null, 2)); });
      const sync = root.command("sync").description("Render the bundled prompt and update only its TOML pointer")
        .option("--adopt", "Take ownership of an existing custom prompt pointer");
      sync.action(async () => {
        console.log(JSON.stringify(await syncPrompt(await resolveTarget(config), { adopt: sync.opts<{ adopt?: boolean }>().adopt === true }), null, 2));
      });
      root.command("restore").description("Restore the original pointer; pause automatic management and retain files")
        .action(async () => { console.log(JSON.stringify(await restorePrompt(await resolveTarget(config)), null, 2)); });
    }, { descriptors: [{ name: "codex-prompt", description: "Manage an agent-scoped Codex base prompt", hasSubcommands: true }] });
  },
});
