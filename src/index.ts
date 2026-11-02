import { listAgentIds, resolveAgentDir, resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import { definePluginEntry, type OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { parseConfig, PLUGIN_ID } from "./config.js";
import { promptStatus, readEnrollment, restorePrompt, syncPrompt, refreshSharedPrompt, type Enrollment, type ManagedRuntime } from "./manager.js";
import { adapterStatus, applyAdapterRestore, codexAdapterOwnership, installAdapter, planAdapterRestore, prepareAdapter } from "./adapter.js";
import { applyClaudeRestore, claudeAdapterStatus, planClaudeRestore } from "./claude-adapter.js";
import { bootstrapMaxChars, buildClaudeSystemPrompt } from "./claude-prompt.js";
import { fetchAndCompile } from "./compiler.js";
import { managedTargetAgent } from "./managed-target.js";
import { readClaudeManagedContext, readFrozenPolicy } from "./runtime.js";
import { detectConfiguredRuntimes, runtimePolicyResolver } from "./runtimes.js";
import { policyFetchers } from "./remote.js";
import { parseClaudePolicy, readOptional } from "./manager.js";
import { basename, dirname, isAbsolute, join } from "node:path";
import { CATALOG_REFRESH_MS, catalogStatus, refreshCatalog, restoreCatalog, startCatalogRefresh } from "./catalog.js";
import { codexSkillsStatus, refreshCodexSkills, removeCodexSkills } from "./skills.js";
import { refreshFailure } from "./refresh-error.js";

type Target = Awaited<ReturnType<typeof resolveTarget>>;
const codexEnrolled = (enrollment: Enrollment | null) => enrollment?.runtimes.includes("codex") === true;

/** Revision metadata of each runtime's stored policy; never the policy text. */
function claudePolicyReceipt(bundle: unknown) {
  if (!bundle || typeof bundle !== "object" || !("claudePolicy" in bundle)) return null;
  try { const { url, revision, checkedAt } = parseClaudePolicy(bundle.claudePolicy); return { url, revision, checkedAt }; }
  catch { return null; }
}

async function refresh(target: Target, automatic = false) {
  const failures: unknown[] = [];
  const codex = codexEnrolled(await readEnrollment(target.agentDir));
  let catalog;
  let prompt;
  let skills;
  // Attempt each owned component independently, sequentially because they share the enrollment lock.
  if (codex && target.settings.suppressExplicitDelegationPrompt) {
    try { catalog = await refreshCatalog(target.agentDir, { automatic }); } catch (error) { failures.push(refreshFailure("catalog", error)); }
  }
  try { prompt = await refreshSharedPrompt(target.agentDir, policyFetchers(target.settings.promptUrl)); } catch (error) { failures.push(refreshFailure("shared prompt", error)); }
  if (codex) {
    try { skills = await refreshCodexSkills(target.agentDir, target.settings.disabledCodexSkills); } catch (error) { failures.push(refreshFailure("skills", error)); }
  }
  if (failures.length) throw new AggregateError(failures, "Refresh incomplete; failed components retain their installed data");
  return { catalog, prompt, skills };
}

/** Why the configured Codex app-server cannot read this agent's managed files, if it cannot. */
function codexAppServerProblem(config: OpenClawConfig) {
  const appServer = config.plugins?.entries?.codex?.config?.appServer;
  if (appServer === undefined) return undefined;
  if (!appServer || typeof appServer !== "object" || Array.isArray(appServer)) return "Invalid Codex appServer config";
  if (("transport" in appServer && appServer.transport !== "stdio") ||
      ("homeScope" in appServer && appServer.homeScope !== "agent")) {
    return "Only agent-scoped local stdio Codex is supported";
  }
  // OpenClaw owns launching Codex, including operator-selected binaries/args.
  // We own this agent's prompt files, not its executable selection.
  return undefined;
}

function assertCodexAppServer(config: OpenClawConfig) {
  const problem = codexAppServerProblem(config);
  if (problem) throw new Error(problem);
}

async function resolveTarget(config: OpenClawConfig) {
  const settings = parseConfig(config.plugins?.entries?.[PLUGIN_ID]?.config);
  if (!listAgentIds(config).includes(settings.agentId)) throw new Error(`Unknown OpenClaw agent: ${settings.agentId}`);
  const agentDir = resolveAgentDir(config, settings.agentId);
  // Codex app-server settings are validated by sync once it selects Codex, and reported by
  // status; restore and Claude-only management never depend on them.
  return { agentDir, settings, workspaceDir: resolveAgentWorkspaceDir(config, settings.agentId) };
}

/**
 * Why OpenClaw would not register the Claude prompt hook, if it would not. OpenClaw (2026.10.6 and
 * 2026.10.9) blocks before_prompt_build when `hooks.allowPromptInjection` is false, and registers
 * it for a non-bundled plugin only with `hooks.allowConversationAccess: true`.
 */
function promptHookProblem(config: OpenClawConfig | undefined) {
  // Inspection and metadata-only registration may not supply a config.
  const raw: unknown = (config?.plugins?.entries?.[PLUGIN_ID] as Record<string, unknown> | undefined)?.hooks;
  const hooks = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  if (hooks.allowPromptInjection === false) {
    return `plugins.entries.${PLUGIN_ID}.hooks.allowPromptInjection is false, which blocks the before_prompt_build hook that replaces the Claude CLI prompt; remove it or set it to true`;
  }
  if (hooks.allowConversationAccess !== true) {
    return `OpenClaw registers the before_prompt_build hook that replaces the Claude CLI prompt only with plugins.entries.${PLUGIN_ID}.hooks.allowConversationAccess: true`;
  }
  return undefined;
}

function errorMessage(error: unknown) { return error instanceof Error ? error.message : "Invalid frozen state"; }

async function status(config: OpenClawConfig) {
  const target = await resolveTarget(config);
  const disk = await promptStatus({ ...target, prompt: "" });
  const runtimes = disk.runtimes as ManagedRuntime[];
  const adapter = await adapterStatus(target.agentDir);
  let error: string | undefined;
  let codexReady = false;
  const codexConfigError = runtimes.includes("codex") ? codexAppServerProblem(config) : undefined;
  if (runtimes.includes("codex") && !codexConfigError) try { codexReady = disk.enrolled && readFrozenPolicy(target.agentDir) !== null && adapter.installed; } catch (cause) { error = errorMessage(cause); }
  // A 0.4 install patched OpenClaw core for Claude; any receipt it left is reported. An unreadable
  // receipt is reported too, and counts as a possible leftover until sync or restore resolves it.
  const legacyClaudeCore = await claudeAdapterStatus(target.agentDir)
    .catch(cause => ({ installed: false, leftover: true, state: "invalid" as const, error: errorMessage(cause) }));
  let claude;
  if (runtimes.includes("claude-cli")) {
    let managed = false;
    let claudeError: string | undefined;
    try { managed = disk.enrolled && readClaudeManagedContext(target.agentDir) !== null; } catch (cause) { claudeError = errorMessage(cause); }
    const hookProblem = promptHookProblem(config);
    claude = { ready: managed && !hookProblem && !legacyClaudeCore.leftover, promptHook: hookProblem ?? "granted", error: claudeError };
  }
  const ready = disk.enrolled && runtimes.length > 0 && (!runtimes.includes("codex") || codexReady) && (!claude || claude.ready);
  // Status inspects installed instructions without fetching or rebuilding them.
  const bundle = await readOptional(join(target.agentDir, "codex-home", ".unblock-codex-prompt-bundle.json"));
  const receipt: unknown = bundle ? JSON.parse(bundle) : null;
  const remotePrompt = receipt && typeof receipt === "object" && "remotePrompt" in receipt ? receipt.remotePrompt : null;
  const claudePolicy = runtimes.includes("claude-cli") ? claudePolicyReceipt(receipt) : null;
  return { ...disk, frozen: true, ready, adapter, error, ...codexConfigError ? { codexConfigError } : {}, ...claude ? { claude } : {},
    ...legacyClaudeCore.state !== "absent" ? { legacyClaudeCore } : {}, configuredPromptUrl: target.settings.promptUrl, remotePrompt, ...runtimes.includes("claude-cli") ? { claudePolicy } : {} };
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Unblock Codex Prompt",
  description: "Explicitly compile a frozen fleet prompt with a guarded Codex bridge and a Claude CLI prompt hook.",
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
        const codex = result.runtimes.includes("codex");
        if (result.enrolled && codex) {
          // Remote Codex plugins can add skills at any time; reconcile before app-servers start.
          try { ctx.logger.info(`${PLUGIN_ID}: codex skills ${JSON.stringify(await refreshCodexSkills(target.agentDir, target.settings.disabledCodexSkills))}`); }
          catch (error) { ctx.logger.error(`${PLUGIN_ID}: codex skills not applied: ${error instanceof Error ? error.message : String(error)}`); }
        }
        if (result.enrolled && result.codexConfigError) {
          ctx.logger.error(`${PLUGIN_ID}: Codex management is not effective: ${result.codexConfigError}; restore, or return Codex to agent-scoped local stdio and re-sync`);
        }
        if (result.legacyClaudeCore?.state === "invalid") {
          ctx.logger.error(`${PLUGIN_ID}: the 0.4 Claude CLI core receipt is unreadable (${"error" in result.legacyClaudeCore ? result.legacyClaudeCore.error : "invalid"}); inspect it, then run openclaw codex-prompt sync or restore`);
        } else if (result.legacyClaudeCore?.leftover) {
          ctx.logger.error(`${PLUGIN_ID}: OpenClaw core still holds the 0.4 Claude CLI patch; run openclaw codex-prompt sync (or restore), then restart the Gateway`);
        }
        if (result.enrolled && result.claude && !result.claude.ready) {
          if (result.claude.promptHook !== "granted") {
            ctx.logger.error(`${PLUGIN_ID}: the Claude CLI prompt hook is not registered (${result.claude.promptHook}); the target agent's Claude runs use OpenClaw's prompt. Restore the grant, or run openclaw codex-prompt restore`);
          } else if (result.claude.error) {
            ctx.logger.error(`${PLUGIN_ID}: Claude CLI managed state is invalid (${result.claude.error}); the target agent's Claude runs use OpenClaw's prompt until openclaw codex-prompt sync`);
          }
        }
        if (result.enrolled) {
          const catalog = codex ? await catalogStatus(target.agentDir) : undefined;
          // The oldest check among the enrolled runtimes' policies decides when the next refresh is due.
          const remote = result.remotePrompt;
          const codexChecked = remote && typeof remote === "object" && "checkedAt" in remote && typeof remote.checkedAt === "number" ? remote.checkedAt : 0;
          const claudeChecked = result.claudePolicy?.checkedAt ?? 0;
          const checkedAt = Math.min(...[codex ? codexChecked : Infinity, result.claudePolicy !== undefined ? claudeChecked : Infinity]);
          const nextAt = Math.min(codex && target.settings.suppressExplicitDelegationPrompt ? catalog?.nextRefreshAt ?? 0 : Infinity,
            checkedAt ? checkedAt + CATALOG_REFRESH_MS : 0,
            Date.now() + CATALOG_REFRESH_MS);
          stopCatalogRefresh = startCatalogRefresh(async () => {
            const refreshed = await refresh(target, true);
            ctx.logger.info(`${PLUGIN_ID}: daily refresh ${JSON.stringify(refreshed)}`);
          }, nextAt, (error, retryAt) => {
            const details = error instanceof AggregateError ? error.errors.map(failure => failure.message).join("; ") : "refresh failed";
            ctx.logger.error(`${PLUGIN_ID}: daily refresh incomplete: ${details}; failed components retain installed data; retry at ${new Date(retryAt).toISOString()} (in one hour)`);
          });
          ctx.logger.info(`${PLUGIN_ID}: daily prompt/catalog refresh scheduled`);
        }
      },
      async stop() { await stopCatalogRefresh?.(); stopCatalogRefresh = undefined; },
    });

    // Claude CLI prompt: for the target agent's claude-cli runs (subagent sessions included) the
    // hook returns the complete system prompt, which OpenClaw uses in place of its own. It is
    // built on every call from the verified enrollment and the live workspace files. Other agents
    // and providers, and paused or unenrolled state, return nothing. Invalid or tampered state is
    // logged and also returns nothing, so that run keeps OpenClaw's prompt. Prompt text is never logged.
    if (!promptHookProblem(api.config)) {
      const reportedSkips = new Set<string>();
      api.on("before_prompt_build", async (_event, ctx) => {
        if (typeof ctx.modelProviderId !== "string" || ctx.modelProviderId.trim().toLowerCase() !== "claude-cli") return;
        const config = api.config;
        const agentId = managedTargetAgent(config);
        if (agentId === undefined || ctx.agentId !== agentId) return;
        try {
          const managed = readClaudeManagedContext(resolveAgentDir(config, agentId));
          if (!managed) return;
          const workspace = typeof ctx.workspaceDir === "string" && isAbsolute(ctx.workspaceDir) ? ctx.workspaceDir : resolveAgentWorkspaceDir(config, agentId);
          const { systemPrompt, skipped } = await buildClaudeSystemPrompt(managed, workspace, bootstrapMaxChars(config, agentId));
          for (const { path, reason } of skipped) {
            if (reportedSkips.has(`${path}\0${reason}`)) continue;
            reportedSkips.add(`${path}\0${reason}`);
            api.logger.warn(`${PLUGIN_ID}: ${path} is left out of the Claude CLI prompt: ${reason}`);
          }
          return { systemPrompt };
        } catch (error) {
          api.logger.error(`${PLUGIN_ID}: Claude CLI run for agent ${agentId} uses OpenClaw's prompt: ${errorMessage(error)}`);
          return;
        }
      });
    }

    api.registerCli(({ program, config }) => {
      const root = program.command("codex-prompt").description("Manage this agent's fleet prompt for Codex and Claude CLI (JSON output)");
      root.command("status").description("Inspect disk state without writing or claiming live adoption")
        .action(async () => {
          const target = await resolveTarget(config);
          const codex = codexEnrolled(await readEnrollment(target.agentDir));
          console.log(JSON.stringify({ ...await status(config), ...codex ? { catalog: await catalogStatus(target.agentDir),
            codexSkills: await codexSkillsStatus(target.agentDir, target.settings.disabledCodexSkills) } : {} }, null, 2));
        });
      root.command("refresh-catalog").description("Fetch fresh provider metadata and repair the managed instruction catalog")
        .action(async () => {
          const target = await resolveTarget(config);
          if (!target.settings.suppressExplicitDelegationPrompt) throw new Error("Enable suppressExplicitDelegationPrompt before refreshing the catalog");
          if (!codexEnrolled(await readEnrollment(target.agentDir))) throw new Error("The model catalog applies only to Codex enrollment");
          console.log(JSON.stringify(await refreshCatalog(target.agentDir), null, 2));
        });
      root.command("refresh").description("Refresh remote prompt, enabled catalog and codex skills without rereading frozen agent context")
        .action(async () => console.log(JSON.stringify(await refresh(await resolveTarget(config)), null, 2)));
      const sync = root.command("sync").description("Explicitly refresh the prompt snapshot, install the reviewed Codex adapter and enable the Claude CLI prompt for configured runtimes")
        .option("--adopt", "Take ownership of an existing custom prompt pointer")
        .option("--codex-plugin-dir <path>", "Verified official Codex package directory (required on first Codex sync)");
      sync.action(async () => {
        const target = await resolveTarget(config);
        const options = sync.opts<{ adopt?: boolean; codexPluginDir?: string }>();
        const enrollment = await readEnrollment(target.agentDir);
        const enrolled = enrollment?.active ? enrollment.runtimes : [];
        const detection = detectConfiguredRuntimes(config, target.settings.agentId, runtimePolicyResolver(api));
        // Configured policy and explicit flags propose components; active enrollment keeps them.
        const codex = detection.runtimes.has("codex") || options.codexPluginDir !== undefined || enrolled.includes("codex");
        const claude = detection.runtimes.has("claude-cli") || enrolled.includes("claude-cli");
        // A receipt retained by restore is rollback evidence, not ownership. Bytes this plugin
        // still holds (an interrupted restore) are never re-enrolled implicitly or orphaned.
        if (!codex && await codexAdapterOwnership(target.agentDir) === "patched") {
          throw new Error("The Codex adapter is still patched but Codex is neither enrolled nor configured; run openclaw codex-prompt restore to finish removing it");
        }
        if (!codex && !claude) {
          throw new Error(`No managed runtime detected for agent ${target.settings.agentId} (policy resolver ${detection.resolver}); configure a claude-cli runtime or pass --codex-plugin-dir for Codex`);
        }
        const hookProblem = claude ? promptHookProblem(config) : undefined;
        if (hookProblem) throw new Error(`Claude CLI management needs its prompt hook: ${hookProblem}`);
        // Validate every adapter before writing any prompt state.
        let codexPlan;
        if (codex) {
          assertCodexAppServer(config);
          // Captured import.meta.url paths expire with the CLI. Older hosts expose the
          // published dist/index.js via source; newer hosts select it via runtimeSource.
          const source = "runtimeSource" in api && typeof api.runtimeSource === "string" ? api.runtimeSource : api.source;
          if (!isAbsolute(source) || basename(source) !== "index.js") throw new Error("Frozen sync requires the packaged plugin runtime entry");
          codexPlan = await prepareAdapter(target.agentDir, target.settings.agentId, options.codexPluginDir, join(dirname(source), "runtime.js"));
        }
        // A 0.4 install patched OpenClaw core for Claude. Its restore is validated (files and
        // backups) here, before any write, and applied with this sync.
        let legacyClaude;
        try { legacyClaude = await planClaudeRestore(target.agentDir); }
        catch (error) { throw new Error(`Cannot remove the 0.4 Claude CLI core patch: ${errorMessage(error)}`); }
        // Every enrolled runtime's policy is fetched before anything is written: Codex without
        // `runtime` (any Worker version), Claude with runtime=claude. Claude-only never reads the
        // Codex artifact. Skills are not compiled: both runtimes get the session catalog live.
        const { compiled, remote, claudePolicy } = await fetchAndCompile({ codex, claude, promptUrl: target.settings.promptUrl, workspaceDir: target.workspaceDir });
        const runtimes: ManagedRuntime[] = [...codex ? ["codex" as const] : [], ...claude ? ["claude-cli" as const] : []];
        const result = await syncPrompt({ ...target, ...compiled }, { adopt: options.adopt === true, runtimes });
        const adapter = codexPlan ? await installAdapter(target.agentDir, codexPlan) : undefined;
        const legacyClaudeCoreRestored = legacyClaude.files.length ? await applyClaudeRestore(legacyClaude) : undefined;
        const catalog = codex && target.settings.suppressExplicitDelegationPrompt ? await refreshCatalog(target.agentDir) : undefined;
        const codexSkills = codex ? await refreshCodexSkills(target.agentDir, target.settings.disabledCodexSkills) : undefined;
        const activation = legacyClaudeCoreRestored
          ? `${result.activation} The 0.4 Claude CLI patch was removed from OpenClaw core: restart the Gateway to reload the restored core.`
          : result.activation;
        console.log(JSON.stringify({ ...result, activation, adapter, detection: { resolver: detection.resolver, models: detection.detections },
          ...remote ? { remotePrompt: remote } : {}, ...claudePolicy ? { claudePolicy } : {}, catalog, codexSkills,
          ...legacyClaudeCoreRestored ? { legacyClaudeCoreRestored, restartRequired: true } : {} }, null, 2));
      });
      root.command("restore").description("Restore owned prompt components; pause automatic management and retain files")
        .action(async () => {
          const target = await resolveTarget(config);
          const enrollment = await readEnrollment(target.agentDir);
          // Each plan validates its files and backups before any write, and is empty unless this
          // plugin's bytes are still installed: a receipt left by an earlier restore or superseded
          // by an update never blocks restoring the other runtime.
          const codexPlan = await planAdapterRestore(target.agentDir);
          const claudePlan = await planClaudeRestore(target.agentDir);
          if (!enrollment && !codexPlan.files.length && !claudePlan.files.length) throw new Error("This agent has no prompt enrollment to restore");
          // Pause enrollment (validating the prompt pointer) before changing anything else, so a
          // refusal leaves every component unchanged and no run sees a half-restored bridge.
          const prompt = enrollment ? await restorePrompt({ ...target, prompt: "" }) : { restored: false };
          if (codexEnrolled(enrollment)) {
            await restoreCatalog(target.agentDir);
            await removeCodexSkills(target.agentDir);
          }
          const codexAdapter = await applyAdapterRestore(codexPlan);
          const legacyClaudeCore = await applyClaudeRestore(claudePlan);
          console.log(JSON.stringify({ ...prompt, ...codexAdapter.ownership !== "none" ? { codexAdapter } : {}, ...legacyClaudeCore.ownership !== "none" ? { legacyClaudeCore } : {},
            ...legacyClaudeCore.restartRequired ? { activation: "The 0.4 Claude CLI patch was removed from OpenClaw core: restart the Gateway to reload the restored core." }
              : enrollment?.runtimes.includes("claude-cli") ? { activation: "The target agent's next Claude CLI turn uses OpenClaw's prompt." } : {} }, null, 2));
        });
    }, { descriptors: [{ name: "codex-prompt", description: "Manage an agent-scoped fleet prompt for Codex and Claude CLI", hasSubcommands: true }] });
  },
});
