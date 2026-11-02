import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { isManagedTarget, managedTargetSource } from "../dist/managed-target.js";

// The gates each bridge inlined before they shared one generated predicate (0.4 pre-release).
const previousCodex = `function previous(params) {
  const plugins = params.config?.plugins;
  const entry = plugins?.entries?.["unblock-codex-prompt"];
  if (plugins?.enabled === false || entry?.enabled !== true || entry.config?.frozenContext !== true ||
      (Array.isArray(plugins.allow) && !plugins.allow.includes("unblock-codex-prompt"))) return null;
  const target = entry.config?.agentId ?? "main";
  if (params.agentId !== target) return null;
  if (target !== "main") throw new Error("Frozen bridge target changed; restore and reinstall the adapter");
  return "";
}`;
const previousClaude = `function previous(params) {
  const plugins = params.config?.plugins;
  const entry = plugins?.entries?.["unblock-codex-prompt"];
  if (plugins?.enabled === false || entry?.enabled !== true || entry.config?.frozenContext !== true ||
      (Array.isArray(plugins.allow) && !plugins.allow.includes("unblock-codex-prompt"))) return void 0;
  const target = entry.config?.agentId ?? "main";
  if (params.agentId !== target || typeof params.modelDisplay !== "string" || !params.modelDisplay.startsWith("claude-cli/")) return void 0;
  if (target !== "main") throw new Error("Claude bridge target changed; restore and re-sync");
  return "MANAGED";
}`;
const eligible = 'typeof params.modelDisplay === "string" && params.modelDisplay.startsWith("claude-cli/")';
const outcome = fn => { try { return { value: fn() }; } catch (error) { return { error: error.message }; } };

test("the generated managed-target predicate behaves exactly like each bridge's previous inline gate", () => {
  const codex = vm.runInNewContext(`${managedTargetSource({ name: "gate", agentId: "main", targetChanged: "Frozen bridge target changed; restore and reinstall the adapter" })}
    ${previousCodex}; ({ current: params => gate(params) ? "" : null, previous })`);
  const claude = vm.runInNewContext(`${managedTargetSource({ name: "gate", agentId: "main", targetChanged: "Claude bridge target changed; restore and re-sync", eligible })}
    ${previousClaude}; ({ current: params => gate(params) ? "MANAGED" : void 0, previous })`);
  const entries = [undefined, { enabled: false, config: { frozenContext: true } }, { enabled: true }, { enabled: true, config: { frozenContext: false } },
    { enabled: true, config: { frozenContext: true } }, { enabled: true, config: { frozenContext: true, agentId: "main" } },
    { enabled: true, config: { frozenContext: true, agentId: "other" } }];
  const plugins = entry => [undefined, {}, { enabled: false }, { allow: ["unblock-codex-prompt"] }, { allow: ["something-else"] }, { allow: "not-a-list" }]
    .map(base => base === undefined ? (entry ? { entries: { "unblock-codex-prompt": entry } } : undefined) : { ...base, entries: { "unblock-codex-prompt": entry } });
  let cases = 0;
  for (const entry of entries) for (const pluginConfig of plugins(entry)) for (const agentId of ["main", "other", undefined])
    for (const modelDisplay of ["claude-cli/claude-opus-5", "anthropic/claude-opus-5", undefined, 7]) {
      const params = { config: pluginConfig === undefined ? {} : { plugins: pluginConfig }, agentId, modelDisplay };
      for (const bridge of [codex, claude]) assert.deepEqual(outcome(() => bridge.current(params)), outcome(() => bridge.previous(params)), JSON.stringify(params));
      cases++;
    }
  assert.ok(cases > 300);
  // Claude checks its model route before the retarget error, as before.
  const retargeted = { config: { plugins: { entries: { "unblock-codex-prompt": { enabled: true, config: { frozenContext: true, agentId: "other" } } } } }, agentId: "other" };
  assert.throws(() => codex.current(retargeted), /Frozen bridge target changed/);
  assert.equal(claude.current({ ...retargeted, modelDisplay: "anthropic/claude-opus-5" }), undefined);
  assert.throws(() => claude.current({ ...retargeted, modelDisplay: "claude-cli/claude-opus-5" }), /Claude bridge target changed/);
});

test("the Claude prompt hook's managed-target predicate keeps the inline gate's semantics", () => {
  // Managed means the previous gate managed the run, or found the configured target and refused it
  // only because the installed bridge was for another agent; the hook reads that target's enrollment.
  const previous = vm.runInNewContext(`${previousCodex}; previous`);
  const entries = [undefined, { enabled: false, config: { frozenContext: true } }, { enabled: true }, { enabled: true, config: { frozenContext: false } },
    { enabled: true, config: { frozenContext: true } }, { enabled: true, config: { frozenContext: true, agentId: "main" } },
    { enabled: true, config: { frozenContext: true, agentId: "other" } }, { enabled: true, config: { frozenContext: true, agentId: 7 } }];
  let cases = 0;
  for (const entry of entries) for (const base of [undefined, {}, { enabled: false }, { allow: ["unblock-codex-prompt"] }, { allow: ["something-else"] }, { allow: "not-a-list" }])
    for (const agentId of ["main", "other", undefined]) {
      const plugins = base === undefined ? (entry ? { entries: { "unblock-codex-prompt": entry } } : undefined) : { ...base, entries: { "unblock-codex-prompt": entry } };
      const config = plugins === undefined ? {} : { plugins };
      const gate = outcome(() => previous({ config, agentId }));
      assert.equal(isManagedTarget(config, agentId), gate.value === "" || /target changed/u.test(gate.error ?? ""), JSON.stringify({ config, agentId }));
      cases++;
    }
  assert.ok(cases > 100);
});
