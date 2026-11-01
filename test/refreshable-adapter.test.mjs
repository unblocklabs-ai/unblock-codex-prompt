import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { patchAdapterSources, prepareAdapter, installAdapter, restoreAdapter, adapterStatus } from "../dist/adapter.js";
import * as runtime from "../dist/runtime.js";

const fixture = JSON.parse(await readFile(new URL("./fixtures/adapter-refreshable.json", import.meta.url), "utf8"));
const sources = Object.values(fixture.bundles);
const runtimePath = fileURLToPath(new URL("../dist/runtime.js", import.meta.url));

test("refreshable layout freezes producers across thread creation, reuse, parent-local inference and compaction", async () => {
  const patched = patchAdapterSources(sources, "/agent", "main", "/plugin/runtime.js");
  let policy = "FROZEN POLICY";
  let liveTag = "A";
  const handoffs = [];
  const globals = {
    unblockPromptCreateRequire: () => () => ({ ...runtime, readFrozenPolicy: () => {
      if (policy instanceof Error) throw policy;
      return policy;
    } }),
    joinPresentSections: (...parts) => parts.filter(part => part?.trim()).join("\n\n"),
    flattenCodexDynamicToolFunctions: specs => specs.flatMap(spec => spec.tools ?? [spec]),
    normalizeLowercaseStringOrEmpty: value => value?.toLowerCase() ?? "",
    shouldIncludeAgentHarnessRuntimeContext: () => true,
    isMessageOnlyCodexSourceReply: () => false,
    resolveAgentWorkspaceMemoryRouting: () => ({ memoryToolNames: ["memory_search"], memoryToolRouted: true }),
    prepareAgentWorkspaceContext: async () => ({
      bootstrapFiles: [], contextFiles: [], promptContextFiles: [], memoryReferenceFiles: [], memoryToolRoutedBootstrapFiles: [], personaFiles: [],
      instructionSnapshot: { files: ["AGENTS.md"], instructions: "NATIVE AGENTS" },
      personaInstructions: `LIVE PERSONA ${liveTag}`, sharedPersonaInstructions: `LIVE PERSONA ${liveTag}`,
      memoryRecallInstructions: `LIVE MEMORY ${liveTag}`,
    }),
    renderCodexWorkspaceBootstrapPromptContext: () => "OPERATIONAL CONTEXT",
    renderCodexWorkspaceMemoryInstructions: ({ memoryRecallInstructions }) => memoryRecallInstructions,
    CODEX_NATIVE_PROJECT_DOC_BASENAMES: new Set(["agents.md"]),
    CODEX_BOOTSTRAP_CONTEXT_ORDER: new Map(),
    embeddedAgentLog: { warn: (...args) => { throw new Error(JSON.stringify(args)); } },
    buildCodexRuntimeThreadConfigForRun: (_params, config) => config,
    resolveDirectOnlyToolNamespaces: () => [],
    resolveCodexThreadApprovalsReviewer: () => "user",
    codexThreadSandboxOrPermissions: () => ({ sandbox: "read-only" }),
    listRegisteredPluginAgentPromptGuidance: () => [],
    SKILL_WORKSHOP_TOOL_NAME: "skill_workshop",
    buildCredentialSafetyPrompt: () => "NATIVE CREDENTIAL GUIDANCE",
    resolveCodexAppServerRequestModelSelection: () => ({ model: "test-model" }),
    readCodexRuntimeModelId: () => "test-model",
    resolveCodexAppServerReasoningEffort: () => "medium",
    readCodexSupportedReasoningEfforts: () => [],
    injectCodexThreadDeveloperHandoff: async (_params, text) => handoffs.push(text),
  };
  const contexts = patched.map(source => {
    const context = vm.createContext({ ...globals });
    vm.runInContext(source.replace(/^import .*;\n/mu, "").replace("import.meta.url", '"file:///adapter.js"'), context);
    return context;
  });
  const owner = name => contexts.find(context => typeof context[name] === "function");
  const params = { agentId: "main", disableTools: true, extraSystemPrompt: "ROUTING", gitCoauthorPrompt: "COAUTHOR", config: { plugins: { entries: { "unblock-codex-prompt": { enabled: true, config: { frozenContext: true } } } } } };
  const render = async attempt => {
    const workspace = await owner("buildCodexWorkspaceBootstrapContext").buildCodexWorkspaceBootstrapContext({
      params: attempt, resolvedWorkspace: "/workspace", executionWorkspace: "/project", effectiveWorkspace: "/project", sessionAgentId: "main", tools: [],
    });
    const skills = owner("renderCodexSkillsInstructions").renderCodexSkillsInstructions({ attempt, skillsPrompt: `LIVE SKILLS ${liveTag}`, dynamicTools: [] });
    const refreshable = globals.joinPresentSections(skills, workspace.sharedPersonaInstructions, workspace.memoryInstructions) || undefined;
    const request = owner("buildCodexThreadConfiguration").buildCodexThreadConfiguration(attempt, {
      config: { keep: true }, cwd: "/project", appServer: { start: {}, approvalPolicy: "never" }, refreshableInstructions: refreshable,
    });
    const parent = owner("buildCodexParentLocalInstructions").buildCodexParentLocalInstructions(attempt, {
      personaInstructions: workspace.personaInstructions, skillsInstructions: skills, memoryInstructions: workspace.memoryInstructions,
    });
    return { workspace, refreshable, request, parent };
  };
  const initial = await render(params);
  assert.equal(initial.request.developerInstructions, "FROZEN POLICY\n\nCOAUTHOR\n\nROUTING");
  assert.equal(initial.refreshable, undefined);
  assert.equal(initial.parent, null);
  assert.equal(initial.workspace.threadDeveloperInstructions, "NATIVE AGENTS");
  assert.equal(initial.workspace.promptContext, "OPERATIONAL CONTEXT");
  assert.equal(initial.request.cwd, "/project");
  assert.equal(initial.request.approvalPolicy, "never");
  assert.equal(initial.request.sandbox, "read-only");
  const cron = await render({ ...params, trigger: "cron" });
  assert.match(cron.parent, /OpenClaw cron automation turn/);
  assert.doesNotMatch(cron.parent, /LIVE/);
  const mode = owner("buildTurnCollaborationMode");
  assert.match(mode.buildTurnCollaborationMode({ ...params, trigger: "cron" }).settings.developer_instructions, /Execute the cron payload directly/);
  assert.equal(mode.buildTurnCollaborationMode(params).settings.developer_instructions, null);

  liveTag = "B";
  const reused = await render(params);
  await owner("refreshCodexThreadInstructions").refreshCodexThreadInstructions({ refreshableInstructions: reused.refreshable });
  assert.match(handoffs.at(-1), /earlier OpenClaw-supplied skills, persona, and memory instructions are withdrawn/);
  const count = handoffs.length;
  const retained = { refreshableInstructions: reused.refreshable, nativeRefreshableInstructions: initial.refreshable };
  assert.equal(await owner("restoreCodexThreadInstructionsAfterCompaction").restoreCodexThreadInstructionsAfterCompaction({ ephemeralPolicy: retained }), retained);
  assert.equal(handoffs.length, count);

  for (const attempt of [{ ...params, agentId: "other" }, { ...params, config: { plugins: { enabled: false } } }]) {
    const ordinary = await render(attempt);
    assert.match(ordinary.refreshable, /LIVE PERSONA B/);
    assert.match(ordinary.refreshable, /LIVE SKILLS B/);
    assert.match(ordinary.refreshable, /LIVE MEMORY B/);
    assert.match(ordinary.parent, /LIVE/);
    assert.match(ordinary.request.developerInstructions, /NATIVE CREDENTIAL GUIDANCE/);
  }
  policy = null;
  assert.match((await render(params)).refreshable, /LIVE PERSONA B/);
  policy = new Error("Frozen prompt changed outside sync");
  await assert.rejects(render(params), /Frozen prompt changed outside sync/);
});

test("managed request assembly removes only reviewed additions and preserves per-turn delivery and execution facts", async () => {
  const operational = JSON.parse(await readFile(new URL("./fixtures/adapter-operational.json", import.meta.url), "utf8"));
  const producers = JSON.parse(await readFile(new URL("./fixtures/openclaw-additions.json", import.meta.url), "utf8"));
  const patched = patchAdapterSources([...sources, Object.values(operational.functions).join("\n")], "/agent", "main", "/plugin/runtime.js");
  const handoffs = [];
  const context = vm.createContext({
    unblockPromptCreateRequire: () => () => ({ ...runtime, readFrozenPolicy: () => "" }),
    normalizeOptionalLowercaseString: value => value?.toLowerCase(),
    normalizeGroupActivation: value => value,
    normalizeChatChannelId: value => value,
    getLoadedChannelPluginForRead: () => ({ messaging: { defaultMarkdownTableMode: "block" } }),
    resolveProviderLabel: () => "Slack",
    normalizeChatType: value => value,
    normalizePromptMetadataString: value => value,
    resolveInboundChannel: () => "slack",
    buildDeliveryFormatPrompt: () => undefined,
    resolveCodexAppServerRequestModelSelection: () => ({ model: "fixture" }),
    resolveCodexAppServerReasoningEffort: () => "medium",
    readCodexSupportedReasoningEfforts: () => [],
    buildTemporalContextText: () => "Current date: 2026-11-01\nTimezone: America/New_York\nFor the exact current time, use `session_status`.",
    readCodexCurrentSender: () => ({ id: "U123", name: "Bek" }),
    buildCodexUserInput: text => [{ type: "text", text }],
    codexSandboxPolicyForTurn: sandbox => ({ type: sandbox }),
    CODEX_NATIVE_PERSONALITY_NONE: "none",
    CRON_COLLABORATION_INSTRUCTIONS: "Execute the cron payload directly.",
    injectCodexThreadDeveloperHandoff: async (_params, text) => handoffs.push(text),
  });
  vm.runInContext(Object.values(producers.functions).join("\n"), context);
  // Only request/operational functions are needed here; the other carriers have
  // their lifecycle coverage above. All bytes come from the published package.
  const operationalSource = patched.at(-1);
  const modeSource = sources.find(source => source.includes("function buildTurnCollaborationMode"));
  vm.runInContext(modeSource + "\n" + operationalSource.replace(/^import .*;\n/gmu, "").replace("import.meta.url", '"file:///adapter.js"'), context);
  const params = { agentId: "main", trigger: "user", modelId: "fixture", prompt: "CURRENT REQUEST",
    config: { plugins: { entries: { "unblock-codex-prompt": { enabled: true, config: { frozenContext: true } } } } },
    hostCapabilities: { activeComputerContext: () => "Current active computer: someone else's Mac" },
  };
  const options = { threadId: "thread", cwd: "/project", appServer: { start: {}, sandbox: "danger-full-access", approvalPolicy: "never" }, messageToolAvailable: true, requireExplicitMessageTarget: false, historyProvenancePrefix: "" };
  for (const mode of ["automatic", "message_tool_only"]) {
    const current = { ...params, sourceReplyDeliveryMode: mode };
    const request = context.buildTurnStartParams(current, options);
    assert.equal(request.additionalContext.openclaw_active_computer, undefined);
    assert.match(request.additionalContext.openclaw_temporal_context.value, /2026-11-01\nTimezone: America\/New_York/);
    assert.doesNotMatch(request.additionalContext.openclaw_temporal_context.value, /session_status/);
    const delivery = request.additionalContext.openclaw_source_delivery.value;
    assert.match(delivery, mode === "automatic" ? /automatically delivered/ : /private.*message/);
    assert.match(delivery, /Commentary.*hidden/);
    assert.doesNotMatch(delivery, /pending|then continue|final=false|Do not repeat/);
    assert.equal(request.approvalPolicy, "never");
    assert.equal(request.sandboxPolicy.type, "danger-full-access");
    assert.equal(request.collaborationMode.mode, "default");
    assert.equal(request.collaborationMode.settings.developer_instructions, null);
    assert.equal(JSON.parse(request.additionalContext.openclaw_current_sender.value).sender.id, "U123");
    assert.equal(request.input[0].text, "CURRENT REQUEST");
    const reused = context.buildTurnStartParams(current, options);
    assert.equal(JSON.stringify(reused), JSON.stringify(request));
    const unrelated = context.buildTurnStartParams({ ...current, agentId: "other" }, options);
    assert.match(unrelated.additionalContext.openclaw_active_computer.value, /someone else's Mac/);
    assert.match(unrelated.additionalContext.openclaw_source_delivery.value, /still-pending/);
  }
  assert.match(context.buildTurnStartParams({ ...params, trigger: "cron" }, options).collaborationMode.settings.developer_instructions, /cron payload/);
  const noTool = context.buildTurnStartParams({ ...params, sourceReplyDeliveryMode: "message_tool_only" }, { ...options, messageToolAvailable: false });
  assert.match(noTool.additionalContext.openclaw_source_delivery.value, /No source-conversation reply can be sent/);
  const explicitTarget = context.buildTurnStartParams(params, { ...options, requireExplicitMessageTarget: true });
  assert.match(explicitTarget.additionalContext.openclaw_source_delivery.value, /target required this turn/);
  const group = context.buildGroupChatContext({ sessionCtx: { Provider: "slack", ChatType: "channel" } });
  const metadata = context.buildInboundMetaSystemPrompt({ ChatType: "channel", AccountId: "account", Provider: "slack", Surface: "slack" }, {});
  const active = context.buildGroupIntro({ activation: "mention" });
  const steadyExec = context.buildExecOverridePromptHint({ elevatedLevel: "on" });
  const routedExec = context.buildExecOverridePromptHint({ elevatedLevel: "on", execOverrides: { node: "fleet-node", security: "full" } });
  const incognito = "This chat is incognito; do not store its conversation content in memory files or long-term notes.";
  const clean = runtime.normalizeOpenClawAdditions([group, metadata, active, steadyExec, routedExec, producers.progressCard, incognito, "## Unknown policy\nKEEP EXACT"].join("\n\n"));
  assert.doesNotMatch(clean, /mostly lurk|only when explicitly mentioned|Write like a human|Current elevated level|Current Exec Session State|delegate.*early|Create a card with progress_card/);
  assert.match(clean, /OpenClaw Gateway exec override: node=fleet-node security=full\.|OpenClaw Gateway exec override: security=full node=fleet-node\./);
  assert.match(clean, /OpenClaw supplies routing metadata/);
  assert.match(clean, /"account_id": "account"/);
  assert.ok(clean.includes(incognito));
  assert.ok(clean.includes("## Unknown policy\nKEEP EXACT"));
  const quoted = '```json\n{"body":"' + active + '"}\n```';
  assert.equal(runtime.normalizeOpenClawAdditions(quoted), quoted);
  const renderer = { schema: "openclaw.delivery_format.v1", channel: "slack", response_format: { rules: [
    "Bold uses **double asterisks**; *single asterisks* or _underscores_ produce italics.",
    "Use presentation table blocks for tabular data; Markdown pipe tables are not auto-promoted.",
    "Only raw Block Kit or presentation text fields use Slack mrkdwn directly: *bold*, _italic_, ~strike~, and <url|label> links. Avoid Markdown headings or pipe tables in those fields.",
    "CUSTOM RENDERER RULE",
  ] } };
  const renderContext = "### Delivery Format\nGenerated by OpenClaw.\n\n```json\n" + JSON.stringify(renderer, null, 2) + "\n```";
  const rendered = runtime.normalizeOpenClawAdditions(renderContext);
  const retained = JSON.parse(rendered.split("```json\n")[1].split("\n```")[0]);
  assert.deepEqual(retained.response_format.rules, renderer.response_format.rules.slice(1));
  const unfamiliarExec = steadyExec + "\nUNREVIEWED EXEC CONTEXT";
  assert.equal(runtime.normalizeOpenClawAdditions(unfamiliarExec), unfamiliarExec);
  await context.refreshCodexThreadPolicy({ unblockManaged: true, developerInstructions: "" });
  assert.equal(handoffs.at(-1), "Current OpenClaw generic policy replaces all earlier OpenClaw generic policy; removed sections are withdrawn.\n\n");
  await context.refreshCodexThreadPolicy({ developerInstructions: "OTHER POLICY" });
  assert.match(handoffs.at(-1), /Independently supplied native/);
  for (const name of Object.keys(operational.functions)) {
    const changed = Object.values(operational.functions).join("\n").replace(`function ${name}(`, `function renamed_${name}(`);
    assert.throws(() => patchAdapterSources([...sources, changed], "/agent", "main", "/plugin/runtime.js"), /Unsupported Codex operational context/);
  }
});

test("refreshable bundles install idempotently, reject upstream/foreign changes and restore exact originals", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "adapter-refreshable-"));
  const agentDir = join(root, "agent");
  const packageDir = join(root, "codex");
  await mkdir(join(agentDir, "codex-home"), { recursive: true });
  await mkdir(join(packageDir, "dist", ".setup"), { recursive: true });
  await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: "@openclaw/codex", version: "2026.10.8" }));
  const paths = Object.keys(fixture.bundles).map(name => join(packageDir, "dist", ".setup", name));
  for (const [i, path] of paths.entries()) await writeFile(path, sources[i]);
  const plan = await prepareAdapter(agentDir, "main", packageDir, runtimePath);
  await installAdapter(agentDir, plan);
  assert.equal((await adapterStatus(agentDir)).installed, true);
  assert.equal((await installAdapter(agentDir, await prepareAdapter(agentDir, "main", undefined, runtimePath))).adapterChanged, false);
  const operations = JSON.parse(await readFile(new URL("./fixtures/adapter-operational.json", import.meta.url), "utf8"));
  const newPath = join(packageDir, "dist", ".setup", "thread-lifecycle-operations-reviewed.mjs");
  const newSource = Object.values(operations.functions).join("\n");
  await writeFile(newPath, newSource);
  const expanded = await prepareAdapter(agentDir, "main", undefined, runtimePath);
  await installAdapter(agentDir, expanded);
  assert.equal((await adapterStatus(agentDir)).installed, true);
  assert.ok(expanded.files.some(file => file.path === newPath));
  const first = plan.files[0];
  await writeFile(first.path, first.patched + "// foreign edit");
  await assert.rejects(restoreAdapter(agentDir), /Foreign adapter edit/);
  await writeFile(first.path, first.patched);
  await restoreAdapter(agentDir);
  assert.deepEqual(await Promise.all(paths.map(path => readFile(path, "utf8"))), sources);
  assert.equal(await readFile(newPath, "utf8"), newSource);
  for (const name of ["buildCodexWorkspaceBootstrapContext", "renderCodexSkillsInstructions", "prepareCodexAttemptContext", "buildCodexParentLocalInstructions", "buildCodexThreadConfiguration", "refreshCodexThreadInstructions", "restoreCodexThreadInstructionsAfterCompaction"]) {
    const changed = sources.map(source => source.replace(`function ${name}(`, `function ${name}(/* changed upstream */`));
    assert.throws(() => patchAdapterSources(changed, agentDir, "main", runtimePath), /Unsupported Codex context assembly/);
  }
});
