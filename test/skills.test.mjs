import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverCodexSkills, refreshCodexSkills, removeCodexSkills, codexSkillsStatus } from "../dist/skills.js";
import { syncPrompt } from "../dist/manager.js";

async function skill(dir, name) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: "fixture"\n---\n\nBody.\n`);
}

// Mirrors a real Codex home: system skills plus bundled and remote plugins in the plugin cache.
async function fixture() {
  const agentDir = await mkdtemp(join(await realpath(tmpdir()), "codex-skills-"));
  const home = join(agentDir, "codex-home");
  await mkdir(home);
  await syncPrompt({ agentDir, prompt: "base\n" });
  await skill(join(home, "skills", ".system", "imagegen"), "imagegen");
  const plugin = async (marketplace, name, version, skills) => {
    const root = join(home, "plugins", "cache", marketplace, name, version);
    await mkdir(join(root, ".codex-plugin"), { recursive: true });
    await writeFile(join(root, ".codex-plugin", "plugin.json"), JSON.stringify({ name, skills: "./skills/" }));
    for (const entry of skills) await skill(join(root, "skills", entry), entry);
  };
  await plugin("openai-bundled", "computer-use", "1.0.1", ["computer-use"]);
  await plugin("openai-curated-remote", "pages", "0.1.18", ["write-page", "organize-space"]);
  await plugin("openai-curated-remote", "work-pets", "0.1.6", ["pets"]);
  const config = join(home, "config.toml");
  // User-authored rules and a trailing table must survive untouched.
  await writeFile(config, `${await readFile(config, "utf8")}\n[[skills.config]]\nname = "imagegen"\nenabled = true\n\n[plugins."computer-use@openai-bundled"]\nenabled = true\n`);
  return { agentDir, home, config, plugin };
}

test("disables listed plugins' skills by their Codex names, leaves the rest, and stays idempotent", async () => {
  const { agentDir, config, plugin } = await fixture();
  assert.deepEqual((await discoverCodexSkills(agentDir)).map(s => s.name),
    ["computer-use:computer-use", "imagegen", "pages:organize-space", "pages:write-page", "work-pets:pets"]);
  const before = await readFile(config, "utf8");
  const first = await refreshCodexSkills(agentDir, ["pages", "work-pets", "not-installed"]);
  assert.equal(first.changed, true);
  assert.equal(first.restartRequired, true);
  assert.deepEqual(first.disabled, ["pages:organize-space", "pages:write-page", "work-pets:pets"]);
  assert.deepEqual(first.notFound, ["not-installed"]);
  const after = await readFile(config, "utf8");
  assert.ok(after.startsWith(before), "user config is kept verbatim ahead of the managed block");
  assert.equal((await refreshCodexSkills(agentDir, ["pages", "work-pets", "not-installed"])).changed, false);
  // A remote plugin shipping a new skill is picked up on the next refresh.
  await plugin("openai-curated-remote", "pages", "0.1.18", ["maintain-space"]);
  assert.deepEqual((await refreshCodexSkills(agentDir, ["pages", "work-pets"])).disabled,
    ["pages:maintain-space", "pages:organize-space", "pages:write-page", "work-pets:pets"]);
  assert.deepEqual((await codexSkillsStatus(agentDir, ["pages", "work-pets"])).disabled,
    ["pages:maintain-space", "pages:organize-space", "pages:write-page", "work-pets:pets"]);
});

test("removal restores the original config; configs that cannot take the block are refused unchanged", async () => {
  const { agentDir, config } = await fixture();
  const original = await readFile(config, "utf8");
  await refreshCodexSkills(agentDir, ["pages"]);
  await removeCodexSkills(agentDir);
  assert.equal(await readFile(config, "utf8"), original);
  await refreshCodexSkills(agentDir, ["pages"]);
  assert.equal((await refreshCodexSkills(agentDir, [])).changed, true, "an empty list removes the block");
  assert.equal(await readFile(config, "utf8"), original);
  const inline = original.replace(/\n\[\[skills\.config\]\]\nname = "imagegen"\nenabled = true\n/u, "\nskills = { config = [{ name = \"imagegen\", enabled = true }] }\n");
  await writeFile(config, inline);
  await assert.rejects(refreshCodexSkills(agentDir, ["pages"]), /skills\.config defined inline/u);
  assert.equal(await readFile(config, "utf8"), inline);
});
