import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG_REFRESH_MS, patchCatalog, fetchUpstreamCatalog, refreshCatalog, restoreCatalog, catalogStatus, startCatalogRefresh } from "../dist/catalog.js";
import { syncPrompt } from "../dist/manager.js";
import { readPromptPointer } from "../dist/toml.js";

const catalog = { extra: "keep", models: [{ slug: "fixture", base_instructions: "keep", supported_reasoning_levels: [], custom: { keep: true }, model_messages: { multi_agent: { role: { root: "mechanics" }, mode: { explicit: "restrictive", proactive: "keep proactive", hint_text: "keep hint" } } } }] };
async function fixture() {
  const agentDir = await mkdtemp(join(await realpath(tmpdir()), "catalog-refresh-"));
  const home = join(agentDir, "codex-home");
  await mkdir(home);
  await syncPrompt({ agentDir, prompt: "base\n" });
  return { agentDir, home };
}

test("catalog cleanup preserves unrelated modes, permission policies and model metadata", () => {
  const expected = structuredClone(catalog);
  const messages = expected.models[0].model_messages;
  messages.multi_agent.mode.explicit = "";
  messages.multi_agent.role = { root: "You are `/root`, the primary agent.", subagent: "You are a child agent. Your final response is delivered to your parent. Your task address identifies you." };
  messages.collaboration_modes = { default: "" };
  messages.permissions = { danger_full_access: "Native execution: filesystem unrestricted; network {{ network_access }}." };
  messages.approvals = { never: "Approval escalation unavailable; omit sandbox_permissions." };
  assert.deepEqual(patchCatalog(catalog), expected);
  assert.equal(catalog.models[0].model_messages.multi_agent.mode.explicit, "restrictive");
  assert.equal(patchCatalog({ models: [{ ...catalog.models[0], model_messages: null }] }).models[0].model_messages.multi_agent.mode.explicit, "");
  const enriched = structuredClone(catalog);
  Object.assign(enriched.models[0].model_messages, { collaboration_modes: { plan: "PLAN" }, permissions: { workspace_write: "WRITE", read_only: "READ" }, approvals: { on_request: "ASK", unless_trusted: "TRUST" } });
  const patched = patchCatalog(enriched).models[0].model_messages;
  assert.equal(patched.collaboration_modes.plan, "PLAN");
  assert.equal(patched.permissions.workspace_write, "WRITE");
  assert.equal(patched.permissions.read_only, "READ");
  assert.equal(patched.approvals.on_request, "ASK");
  assert.equal(patched.approvals.unless_trusted, "TRUST");
  for (const invalid of [{ models: [] }, { data: [] }, { models: [catalog.models[0], catalog.models[0]] }, { models: [{ slug: "missing" }] }, { models: [{ ...catalog.models[0], model_messages: { permissions: "invalid" } }] }]) assert.throws(() => patchCatalog(invalid));
});

test("refresh overwrites manual generated-file edits from fresh source; failure retains the last good copy", async () => {
  const { agentDir, home } = await fixture();
  const config = join(home, "config.toml");
  const before = await readFile(config, "utf8");
  let calls = 0;
  const fetchCatalog = async () => { calls++; return catalog; };
  const initial = await refreshCatalog(agentDir, { fetchCatalog, now: 1000 });
  assert.equal(initial.restartRequired, true);
  assert.equal(initial.newSessionRequired, true);
  const path = join(home, "unblock-codex-models.json");
  assert.equal(readPromptPointer(await readFile(config, "utf8"), "model_catalog_json"), path);
  const good = await readFile(path, "utf8");
  await writeFile(path, "MANUAL_EDIT");
  assert.equal((await catalogStatus(agentDir)).contentMatches, false);
  const repaired = await refreshCatalog(agentDir, { fetchCatalog, now: 2000 });
  assert.equal(repaired.catalogChanged, true);
  assert.equal(repaired.restartRequired, false);
  assert.equal(repaired.newSessionRequired, true);
  assert.equal(calls, 2);
  assert.equal(await readFile(path, "utf8"), good);
  const receipt = await readFile(join(home, ".unblock-codex-catalog.json"), "utf8");
  await assert.rejects(refreshCatalog(agentDir, { fetchCatalog: async () => { throw new Error("offline"); } }), /offline/);
  assert.equal(await readFile(path, "utf8"), good);
  assert.equal(await readFile(join(home, ".unblock-codex-catalog.json"), "utf8"), receipt);
  assert.equal((await catalogStatus(agentDir)).nextRefreshAt, 2000 + CATALOG_REFRESH_MS);
  await restoreCatalog(agentDir);
  assert.equal(readPromptPointer(await readFile(config, "utf8"), "model_catalog_json"), null);
  assert.equal((await readFile(config, "utf8")).trim(), before.trim());
  assert.equal((await refreshCatalog(agentDir, { automatic: true, fetchCatalog })).skipped, true);
  assert.equal(calls, 2);
});

test("foreign catalog pointers and malformed upstream data never become enrolled", async () => {
  const { agentDir, home } = await fixture();
  await assert.rejects(refreshCatalog(agentDir, { fetchCatalog: async () => ({ models: [] }) }), /full Codex/);
  assert.equal((await catalogStatus(agentDir)).enabled, false);
  await writeFile(join(home, "config.toml"), 'model_catalog_json = "/foreign.json"\n');
  await assert.rejects(refreshCatalog(agentDir, { fetchCatalog: async () => catalog }), /different/);
});

test("source fetch uses provider auth and client version, never the generated override", async () => {
  const { agentDir, home } = await fixture();
  await writeFile(join(home, "models_cache.json"), JSON.stringify({ client_version: "0.153.4", models: [] }));
  process.env.UNBLOCK_CATALOG_FIXTURE_KEY = "fixture-only";
  const config = 'model_provider="fixture"\nmodel_catalog_json="/do-not-read.json"\n[model_providers.fixture]\nbase_url="https://example.test/backend-api/codex"\nenv_key="UNBLOCK_CATALOG_FIXTURE_KEY"\n';
  try {
    const result = await fetchUpstreamCatalog(agentDir, config, async (url, options) => {
      assert.equal(String(url), "https://example.test/backend-api/codex/models?client_version=0.153.4");
      assert.equal(options.headers.Authorization, "Bearer fixture-only");
      assert.equal(options.redirect, "error");
      return Response.json(catalog);
    });
    assert.deepEqual(result, catalog);
    await assert.rejects(fetchUpstreamCatalog(agentDir, config, async () => { throw new Error("sensitive transport detail"); }), /^Error: Catalog request failed; installed catalog retained$/);
  } finally { delete process.env.UNBLOCK_CATALOG_FIXTURE_KEY; }
});

test("daily timer catches up on startup, retries failures hourly and stops cleanly", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  let calls = 0;
  const errors = [];
  const failure = new Error("offline");
  const stop = startCatalogRefresh(async () => { calls++; if (calls === 2) throw failure; }, 0, (error, retryAt) => errors.push({ error, retryAt }));
  const flush = () => new Promise(setImmediate);
  t.mock.timers.tick(0); await flush();
  assert.equal(calls, 1);
  t.mock.timers.tick(CATALOG_REFRESH_MS - 1); await flush(); assert.equal(calls, 1);
  t.mock.timers.tick(1); await flush(); assert.equal(calls, 2);
  assert.deepEqual(errors, [{ error: failure, retryAt: Date.now() + 60 * 60 * 1000 }]);
  t.mock.timers.tick(60 * 60 * 1000); await flush(); assert.equal(calls, 3);
  await stop(); t.mock.timers.tick(CATALOG_REFRESH_MS); await flush(); assert.equal(calls, 3);
});
