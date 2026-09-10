import assert from "node:assert/strict";
import test from "node:test";
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
