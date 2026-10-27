import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { patchAdapterSources, prepareAdapter, installAdapter, restoreAdapter, adapterStatus } from "../dist/adapter.js";

const fixture = JSON.parse(await readFile(new URL("./fixtures/adapter-refreshable.json", import.meta.url), "utf8"));
const sources = Object.values(fixture.bundles);
const runtimePath = fileURLToPath(new URL("../dist/runtime.js", import.meta.url));

test("refreshable layout freezes producers across thread creation, reuse, parent-local inference and compaction", async () => {
  const patched = patchAdapterSources(sources, "/agent", "main", "/plugin/runtime.js");
  let policy = "FROZEN POLICY";
  let liveTag = "A";
  const handoffs = [];
  const globals = {
    unblockPromptCreateRequire: () => () => ({ readFrozenPolicy: () => {
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
  const first = plan.files[0];
  await writeFile(first.path, first.patched + "// foreign edit");
  await assert.rejects(restoreAdapter(agentDir), /Foreign adapter edit/);
  await writeFile(first.path, first.patched);
  await restoreAdapter(agentDir);
  assert.deepEqual(await Promise.all(paths.map(path => readFile(path, "utf8"))), sources);
  for (const name of ["buildCodexWorkspaceBootstrapContext", "renderCodexSkillsInstructions", "prepareCodexAttemptContext", "buildCodexParentLocalInstructions", "buildCodexThreadConfiguration", "refreshCodexThreadInstructions", "restoreCodexThreadInstructionsAfterCompaction"]) {
    const changed = sources.map(source => source.replace(`function ${name}(`, `function ${name}(/* changed upstream */`));
    assert.throws(() => patchAdapterSources(changed, agentDir, "main", runtimePath), /Unsupported Codex context assembly/);
  }
});
