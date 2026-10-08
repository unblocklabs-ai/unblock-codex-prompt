import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../dist/index.js";

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

test("service accepts operator-selected stdio launchers and args without enrolling; rejects homes/transports it cannot manage", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "prompt-launchers-"));
  const cases = [
    { appServer: {} },
    { appServer: { command: "/operator/bin/codex" } },
    { appServer: { args: ["app-server", "--listen", "stdio://"] } },
    { appServer: { command: "/operator/bin/codex", args: ["app-server", "-c", "service_tier=\"fast\""] } },
    { appServer: { transport: "websocket" }, error: /agent-scoped local stdio/ },
    { appServer: { homeScope: "user" }, error: /agent-scoped local stdio/ },
  ];
  for (const { appServer, error } of cases) {
    let service;
    plugin.register({ registerService: value => { service = value; }, registerCli() {} });
    const logs = [];
    const config = {
      agents: { list: [{ id: "main", agentDir: join(root, "agent"), workspace: root }] },
      plugins: { entries: { codex: { config: { appServer } } } },
    };
    const before = structuredClone(config);
    const start = service.start({ config, logger: { info: value => logs.push(value), error: value => logs.push(value) } });
    if (error) await assert.rejects(start, error);
    else {
      await start;
      assert.equal(JSON.parse(logs[0].slice("unblock-codex-prompt: ".length)).enrolled, false);
      await service.stop();
    }
    assert.deepEqual(config, before);
    assert.deepEqual(await readdir(root), []);
  }
});
