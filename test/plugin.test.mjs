import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, realpath, readdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../dist/index.js";
import { readCodexBaseInstructions } from "../dist/runtime.js";
import { compilePrompt } from "../dist/compiler.js";
import { sha256, syncPrompt } from "../dist/manager.js";
import { readPromptPointer } from "../dist/toml.js";

const { Command } = createRequire(import.meta.resolve("openclaw/plugin-sdk/plugin-entry"))("commander");

test("registration declares a service and lazy CLI without running either or adding prompt hooks", () => {
  const registrations = [];
  plugin.register({
    registerService: (service) => registrations.push(["service", service]),
    registerCli: (handler, metadata) => registrations.push(["cli", handler, metadata]),
  });
  assert.equal(registrations.length, 2);
  assert.equal(registrations[0][1].id, "unblock-codex-prompt");
  assert.equal(registrations[1][2].descriptors[0].name, "codex-prompt");
});

test("automatic refresh logs every failing component safely while successful components still refresh", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  const root = await mkdtemp(join(await realpath(tmpdir()), "refresh-diagnostics-"));
  const url = "https://example.test/prompt";
  const initial = "INITIAL BASE";
  const compiled = await compilePrompt(initial, root);
  compiled.bundle.remotePrompt = { url, revision: sha256(initial), checkedAt: 0 };
  await syncPrompt({ agentDir: root, ...compiled });
  const home = join(root, "codex-home");
  const promptPath = join(home, "unblock-codex-prompt.md");
  let service;
  plugin.register({ registerService: value => { service = value; }, registerCli() {} });
  const logs = [];
  let nextError = Promise.withResolvers();
  const config = { agents: { list: [{ id: "main", agentDir: root, workspace: root }] }, plugins: { entries: {
    "unblock-codex-prompt": { enabled: true, config: { frozenContext: true, suppressExplicitDelegationPrompt: true, promptUrl: url } },
  } } };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("UPDATED BASE", { headers: { "content-type": "text/plain", "x-prompt-revision": sha256("UPDATED BASE") } });
  t.after(async () => { await service.stop(); globalThis.fetch = originalFetch; });
  await service.start({ config, logger: { info() {}, error: value => { logs.push(value); nextError.resolve(value); } } });
  t.mock.timers.tick(0);
  const first = await nextError.promise;
  assert.match(first, /catalog: Catalog refresh requires an explicit Codex provider/);
  assert.match(first, /retry at 1970-01-01T01:00:10.000Z/);
  assert.doesNotMatch(first, /shared prompt:|skills:/);
  const goodPrompt = await readFile(promptPath, "utf8");
  assert.match(goodPrompt, /^UPDATED BASE/);
  const goodBundle = await readFile(join(home, ".unblock-codex-prompt-bundle.json"), "utf8");
  await appendFile(join(home, "config.toml"), "\n# BEGIN unblock-codex-prompt codex skills (managed; replaced on refresh)\n");
  globalThis.fetch = async () => { throw new Error("Bearer TOP_SECRET response body"); };
  nextError = Promise.withResolvers();
  t.mock.timers.tick(60 * 60 * 1000);
  const second = await nextError.promise;
  assert.match(second, /catalog: Catalog refresh requires an explicit Codex provider/);
  assert.match(second, /shared prompt: Request or local-state validation failed/);
  assert.match(second, /skills: The managed codex skills block.*damaged/);
  assert.match(second, /retry at 1970-01-01T02:00:10.000Z/);
  assert.doesNotMatch(logs.join("\n"), /TOP_SECRET|Bearer|response body/);
  assert.equal(await readFile(promptPath, "utf8"), goodPrompt);
  assert.equal(await readFile(join(home, ".unblock-codex-prompt-bundle.json"), "utf8"), goodBundle);
});

test("a Claude-only enrollment schedules its daily refresh from the oldest enrolled checkedAt, not immediately on every start", { timeout: 20_000 }, async t => {
  const DAY = 24 * 60 * 60 * 1000;
  const HOUR = 60 * 60 * 1000;
  const now = 10 * DAY;
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now });
  const root = await mkdtemp(join(await realpath(tmpdir()), "claude-schedule-"));
  const url = "https://example.test/prompt";
  // Checked one hour ago: the next refresh is due 23 hours from now.
  const compiled = await compilePrompt(null, root, { text: "CLAUDE A", url: `${url}?runtime=claude`, revision: sha256("CLAUDE A"), checkedAt: now - HOUR });
  await syncPrompt({ agentDir: root, ...compiled }, { runtimes: ["claude-cli"] });
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async target => {
    requests.push(String(target));
    return new Response("CLAUDE B", { headers: { "content-type": "text/plain", "x-prompt-revision": sha256("CLAUDE B"), "x-prompt-runtime": "claude" } });
  };
  let service;
  plugin.register({ registerService: value => { service = value; }, registerCli() {} });
  t.after(async () => { await service?.stop(); globalThis.fetch = originalFetch; });
  const logs = [];
  let refreshed = Promise.withResolvers();
  const log = value => { logs.push(value); if (/daily refresh/.test(value)) refreshed.resolve(value); };
  const config = { agents: { list: [{ id: "main", agentDir: root, workspace: root }] }, plugins: { entries: {
    "unblock-codex-prompt": { enabled: true, hooks: { allowConversationAccess: true }, config: { frozenContext: true, promptUrl: url } },
  } } };
  await service.start({ config, logger: { info: log, error: log } });
  assert.ok(logs.some(line => line.includes("daily prompt/catalog refresh scheduled")));
  const settle = () => new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(0); await settle();
  assert.deepEqual(requests, [], "a fresh Claude policy is not refreshed at startup");
  t.mock.timers.tick(DAY - HOUR - 1); await settle();
  assert.deepEqual(requests, []);
  t.mock.timers.tick(1);
  assert.match(await refreshed.promise, /daily refresh \{.*"claudeRevision"/);
  assert.deepEqual(requests, [`${url}?runtime=claude`]);
  // Once refreshed, the next one is a full day after it.
  refreshed = Promise.withResolvers();
  await settle();
  t.mock.timers.tick(DAY - 1); await settle();
  assert.equal(requests.length, 1);
  t.mock.timers.tick(1);
  await refreshed.promise;
  assert.equal(requests.length, 2);
});

test("service accepts operator-selected launchers and args without enrolling; unsupported Codex homes/transports do not block an unenrolled start", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "prompt-launchers-"));
  const cases = [
    { appServer: {} },
    { appServer: { command: "/operator/bin/codex" } },
    { appServer: { args: ["app-server", "--listen", "stdio://"] } },
    { appServer: { command: "/operator/bin/codex", args: ["app-server", "-c", "service_tier=\"fast\""] } },
    // Sync validates these once it selects Codex; nothing is managed here yet.
    { appServer: { transport: "websocket" } },
    { appServer: { homeScope: "user" } },
  ];
  for (const { appServer } of cases) {
    let service;
    plugin.register({ registerService: value => { service = value; }, registerCli() {} });
    const logs = [];
    const config = {
      agents: { list: [{ id: "main", agentDir: join(root, "agent"), workspace: root }] },
      plugins: { entries: {
        codex: { config: { appServer } },
        "unblock-codex-prompt": { enabled: true, config: { frozenContext: true, promptUrl: "https://example.test/prompt" } },
      } },
    };
    const before = structuredClone(config);
    await service.start({ config, logger: { info: value => logs.push(value), error: value => logs.push(value) } });
    assert.equal(JSON.parse(logs[0].slice("unblock-codex-prompt: ".length)).enrolled, false);
    assert.equal(logs.length, 1);
    await service.stop();
    assert.deepEqual(config, before);
    assert.deepEqual(await readdir(root), []);
  }
});

test("remote-only CLI sync installs both prompt replacements; refresh and restore preserve their contracts", async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "remote-only-cli-"));
  const agentDir = join(root, "agent");
  const workspace = join(root, "workspace");
  const packageDir = join(root, "codex");
  await mkdir(workspace);
  await mkdir(join(packageDir, "dist"), { recursive: true });
  await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: "@openclaw/codex", version: "2026.10.8" }));
  await writeFile(join(workspace, "SOUL.md"), "AGENT IDENTITY A");
  const fixture = JSON.parse(await readFile(new URL("./fixtures/adapter-refreshable.json", import.meta.url), "utf8"));
  for (const [name, source] of Object.entries(fixture.bundles)) {
    await writeFile(join(packageDir, "dist", name), source + (name.startsWith("thread-requests-") ? "\nexport { buildDeveloperInstructions };\n" : ""));
  }
  const settings = { frozenContext: true, promptUrl: "https://example.test/prompt", agentName: "Legacy name" };
  const config = { agents: { list: [{ id: "main", agentDir, workspace }] }, plugins: { entries: {
    "unblock-codex-prompt": { enabled: true, config: settings },
  } } };
  let registerCli;
  plugin.register({ source: fileURLToPath(new URL("../dist/index.js", import.meta.url)), registerService() {}, registerCli: handler => { registerCli = handler; } });
  const run = async (...args) => {
    const program = new Command();
    registerCli({ program, config });
    await program.parseAsync(["node", "fixture", "codex-prompt", ...args]);
  };
  t.mock.method(console, "log", () => {});
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let remoteText = "REMOTE A\nKeep literal {{identity}}.";
  globalThis.fetch = async url => {
    assert.equal(String(url), settings.promptUrl);
    return new Response(remoteText, { headers: { "content-type": "text/plain", "x-prompt-revision": sha256(remoteText) } });
  };
  await run("sync", "--codex-plugin-dir", packageDir);
  const home = join(agentDir, "codex-home");
  const promptPath = join(home, "unblock-codex-prompt.md");
  assert.equal(readPromptPointer(await readFile(join(home, "config.toml"), "utf8")), promptPath);
  const prompt = await readFile(promptPath, "utf8");
  // The base file carries the fleet policy; identity reaches Codex live, never through it.
  assert.ok(prompt.startsWith(remoteText));
  assert.doesNotMatch(prompt, /AGENT IDENTITY A|Legacy name/);
  assert.equal(readCodexBaseInstructions(agentDir), prompt);
  const adapter = await import(pathToFileURL(join(packageDir, "dist", "thread-requests-reviewed.mjs")));
  assert.equal(adapter.buildDeveloperInstructions({ agentId: "main", config }), "");
  assert.equal(adapter.buildDeveloperInstructions({ agentId: "main", config, extraSystemPrompt: "ROUTING FACT" }), "ROUTING FACT");
  await writeFile(join(workspace, "SOUL.md"), "AGENT IDENTITY B");
  remoteText = "REMOTE B";
  await run("refresh");
  const updated = await readFile(promptPath, "utf8");
  assert.equal(updated, "REMOTE B" + prompt.slice(prompt.indexOf("\n\n## Agent context\n")));
  // The patched thread requests send this file as base instructions on the next start/resume.
  assert.equal(readCodexBaseInstructions(agentDir), updated);
  globalThis.fetch = async () => { throw new Error("offline"); };
  await assert.rejects(run("refresh"), /Refresh incomplete/);
  assert.equal(await readFile(promptPath, "utf8"), updated);
  await run("restore");
  assert.equal(readPromptPointer(await readFile(join(home, "config.toml"), "utf8")), null);
  for (const [name, source] of Object.entries(fixture.bundles)) {
    assert.equal(await readFile(join(packageDir, "dist", name), "utf8"), source + (name.startsWith("thread-requests-") ? "\nexport { buildDeveloperInstructions };\n" : ""));
  }
});
