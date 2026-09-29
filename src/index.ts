import { readFile } from "node:fs/promises";
import { listAgentIds, resolveAgentDir, resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import { definePluginEntry, type OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { parseConfig, PLUGIN_ID, renderPrompt } from "./config.js";
import { promptStatus, restorePrompt, syncPrompt, refreshSharedPrompt } from "./manager.js";
import { adapterStatus, installAdapter, prepareAdapter, restoreAdapter } from "./adapter.js";
import { buildSkillsCatalog, compilePrompt } from "./compiler.js";
import { readFrozenPolicy } from "./runtime.js";
import { fetchPrompt, REMOTE_POLICY } from "./remote.js";
import { readOptional } from "./manager.js";
import { join } from "node:path";
import { CATALOG_REFRESH_MS, catalogStatus, refreshCatalog, restoreCatalog, startCatalogRefresh } from "./catalog.js";
import { codexSkillsStatus, refreshCodexSkills, removeCodexSkills } from "./skills.js";

async function refresh(target: Awaited<ReturnType<typeof resolveTarget>>, automatic = false) {
  const failures: unknown[] = [];
  let catalog;
  let prompt;
  let skills;
  // Attempt each independently, sequentially because they share the enrollment lock.
  if (target.settings.suppressExplicitDelegationPrompt) {
    try { catalog = await refreshCatalog(target.agentDir, { automatic }); } catch (error) { failures.push(error); }
  }
  if (target.settings.promptUrl) {
    const url = target.settings.promptUrl;
    try { prompt = await refreshSharedPrompt(target.agentDir, () => fetchPrompt(url)); } catch (error) { failures.push(error); }
  }
  try { skills = await refreshCodexSkills(target.agentDir, target.settings.disabledCodexSkills); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "Refresh incomplete; failed components retain their installed data");
  return { catalog, prompt, skills };
}

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
  return { agentDir: resolveAgentDir(config, settings.agentId), settings, workspaceDir: resolveAgentWorkspaceDir(config, settings.agentId) };
}

async function bundledPrompt(agentName?: string) {
  return renderPrompt(await readFile(new URL("../prompts/system.md", import.meta.url), "utf8"), agentName);
}

async function status(config: OpenClawConfig) {
  const target = await resolveTarget(config);
  const disk = await promptStatus({ ...target, prompt: target.settings.frozenContext ? "" : await bundledPrompt(target.settings.agentName) });
  if (!target.settings.frozenContext) return disk;
  const adapter = await adapterStatus(target.agentDir);
  let ready = false;
  let error: string | undefined;
  try { ready = readFrozenPolicy(target.agentDir) !== null; } catch (cause) { error = cause instanceof Error ? cause.message : "Invalid frozen state"; }
  // A frozen snapshot intentionally differs from today's template/documents.
  const { promptMatches: _matches, expectedSha256: _expected, ...frozenDisk } = disk;
  const bundle = await readOptional(join(target.agentDir, "codex-home", ".unblock-codex-prompt-bundle.json"));
  const receipt: unknown = bundle ? JSON.parse(bundle) : null;
  const remotePrompt = receipt && typeof receipt === "object" && "remotePrompt" in receipt ? receipt.remotePrompt : null;
  return { ...frozenDisk, frozen: true, ready: ready && adapter.installed, adapter, error, configuredPromptUrl: target.settings.promptUrl, remotePrompt };
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Unblock Codex Prompt",
  description: "Explicitly compile a frozen Codex prompt with a guarded OpenClaw bridge.",
  register(api) {
    let stopCatalogRefresh: (() => Promise<void>) | undefined;
    // Registration/import stays read-only, including plugin inspection and CLI discovery.
    api.registerService({
      id: PLUGIN_ID,
      reload: { configPrefixes: [`plugins.entries.${PLUGIN_ID}.config`] },
      async start(ctx) {
        const result = await status(ctx.config);
        ctx.logger.info(`${PLUGIN_ID}: ${JSON.stringify(result)}`);
        const target = await resolveTarget(ctx.config);
        if (result.enrolled) {
          // Remote Codex plugins can add skills at any time; reconcile before app-servers start.
          try { ctx.logger.info(`${PLUGIN_ID}: codex skills ${JSON.stringify(await refreshCodexSkills(target.agentDir, target.settings.disabledCodexSkills))}`); }
          catch (error) { ctx.logger.error(`${PLUGIN_ID}: codex skills not applied: ${error instanceof Error ? error.message : String(error)}`); }
        }
        if (result.enrolled) {
          const catalog = await catalogStatus(target.agentDir);
          const remote = "remotePrompt" in result ? result.remotePrompt : null;
          const checkedAt = remote && typeof remote === "object" && "checkedAt" in remote && typeof remote.checkedAt === "number" ? remote.checkedAt : 0;
          const nextAt = Math.min(target.settings.suppressExplicitDelegationPrompt ? catalog.nextRefreshAt ?? 0 : Infinity,
            target.settings.promptUrl ? checkedAt ? checkedAt + CATALOG_REFRESH_MS : 0 : Infinity,
            Date.now() + CATALOG_REFRESH_MS);
          stopCatalogRefresh = startCatalogRefresh(async () => {
            const refreshed = await refresh(target, true);
            ctx.logger.info(`${PLUGIN_ID}: daily refresh ${JSON.stringify(refreshed)}`);
          }, nextAt, () => ctx.logger.error(`${PLUGIN_ID}: daily refresh incomplete; failed components retain installed data, retrying in one hour`));
          ctx.logger.info(`${PLUGIN_ID}: daily prompt/catalog refresh scheduled`);
        }
      },
      async stop() { await stopCatalogRefresh?.(); stopCatalogRefresh = undefined; },
    });
    api.registerCli(({ program, config }) => {
      const root = program.command("codex-prompt").description("Manage this agent's Codex base prompt (JSON output)");
      root.command("status").description("Inspect disk state without writing or claiming live adoption")
        .action(async () => {
          const target = await resolveTarget(config);
          console.log(JSON.stringify({ ...await status(config), catalog: await catalogStatus(target.agentDir),
            codexSkills: await codexSkillsStatus(target.agentDir, target.settings.disabledCodexSkills) }, null, 2));
        });
      root.command("refresh-catalog").description("Fetch fresh provider metadata and repair the managed delegation-policy catalog")
        .action(async () => {
          const target = await resolveTarget(config);
          if (!target.settings.suppressExplicitDelegationPrompt) throw new Error("Enable suppressExplicitDelegationPrompt before refreshing the catalog");
          console.log(JSON.stringify(await refreshCatalog(target.agentDir), null, 2));
        });
      root.command("refresh").description("Refresh remote prompt, enabled catalog and codex skills without rereading frozen agent context")
        .action(async () => console.log(JSON.stringify(await refresh(await resolveTarget(config)), null, 2)));
      const sync = root.command("sync").description("Explicitly refresh the prompt snapshot and install the reviewed adapter")
        .option("--adopt", "Take ownership of an existing custom prompt pointer")
        .option("--codex-plugin-dir <path>", "Verified official Codex package directory (required on first frozen sync)");
      sync.action(async () => {
        const target = await resolveTarget(config);
        const options = sync.opts<{ adopt?: boolean; codexPluginDir?: string }>();
        const plan = target.settings.frozenContext ? await prepareAdapter(target.agentDir, target.settings.agentId, options.codexPluginDir) : null;
        const remote = target.settings.promptUrl ? await fetchPrompt(target.settings.promptUrl) : null;
        const prompt = remote?.prompt ?? await bundledPrompt(target.settings.agentName);
        const compiled = target.settings.frozenContext ? await compilePrompt(prompt,
          remote ? REMOTE_POLICY : await readFile(new URL("../prompts/developer.md", import.meta.url), "utf8"), target.workspaceDir,
          await buildSkillsCatalog(config, target.settings.agentId, target.workspaceDir)) : null;
        if (compiled && remote) Object.assign(compiled.bundle, { remotePrompt: { ...remote.source, checkedAt: Date.now() } });
        const result = await syncPrompt({ ...target, prompt, ...compiled }, { adopt: options.adopt === true });
        const adapter = plan ? await installAdapter(target.agentDir, plan) : undefined;
        const catalog = target.settings.suppressExplicitDelegationPrompt ? await refreshCatalog(target.agentDir) : undefined;
        const codexSkills = await refreshCodexSkills(target.agentDir, target.settings.disabledCodexSkills);
        console.log(JSON.stringify({ ...result, adapter, skillCount: compiled?.bundle.skillCount, remotePrompt: remote?.source, catalog, codexSkills }, null, 2));
      });
      root.command("restore").description("Restore the original pointer; pause automatic management and retain files")
        .action(async () => {
          const target = await resolveTarget(config);
          await restoreCatalog(target.agentDir);
          await removeCodexSkills(target.agentDir);
          await restoreAdapter(target.agentDir);
          console.log(JSON.stringify(await restorePrompt({ ...target, prompt: "" }), null, 2));
        });
    }, { descriptors: [{ name: "codex-prompt", description: "Manage an agent-scoped Codex base prompt", hasSubcommands: true }] });
  },
});
