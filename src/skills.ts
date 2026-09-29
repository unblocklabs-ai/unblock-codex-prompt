import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getStaticTOMLValue, parseTOML } from "toml-eslint-parser";
import { readOptional, replaceFile, withLock } from "./manager.js";

// Codex loads every discovered skill unless a [[skills.config]] rule turns it off, and remote
// plugins can add skills at any time. This block disables the listed skills and plugins by name,
// the selector Codex applies to plugin skills (`plugin:skill`) as well as system skills.
const BEGIN = "# BEGIN unblock-codex-prompt codex skills (managed; replaced on refresh)";
const END = "# END unblock-codex-prompt codex skills";

export type CodexSkill = { name: string; plugin: string | null };

function files(agentDir: string) {
  const home = join(resolve(agentDir), "codex-home");
  return { home, config: join(home, "config.toml"), state: join(home, ".unblock-codex-prompt.json") };
}

function isMissing(error: unknown) {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

async function directories(path: string) {
  try {
    return (await readdir(path, { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.name.startsWith("."));
  } catch (error) { if (isMissing(error)) return []; throw error; }
}

async function readText(path: string) {
  try { return await readFile(path, "utf8"); } catch (error) { if (isMissing(error)) return null; throw error; }
}

/** Codex names a skill by its SKILL.md frontmatter `name`, falling back to the directory name. */
function skillName(doc: string, directory: string) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(doc)?.[1] ?? "";
  return /^name:\s*["']?(.+?)["']?\s*$/mu.exec(frontmatter)?.[1]?.trim() || directory;
}

async function skillsUnder(root: string, depth: number): Promise<string[]> {
  const names: string[] = [];
  for (const entry of await directories(root)) {
    const directory = join(root, entry.name);
    const doc = await readText(join(directory, "SKILL.md"));
    if (doc !== null) names.push(skillName(doc, entry.name));
    else if (depth > 1) names.push(...await skillsUnder(directory, depth - 1));
  }
  return names;
}

/** Skills Codex loads from this agent's home: system, user and cached plugin skills (`plugin:skill`). */
export async function discoverCodexSkills(agentDir: string): Promise<CodexSkill[]> {
  const { home } = files(agentDir);
  const found: CodexSkill[] = [];
  for (const name of await skillsUnder(join(home, "skills", ".system"), 1)) found.push({ name, plugin: null });
  for (const name of await skillsUnder(join(home, "skills"), 1)) found.push({ name, plugin: null });
  // Cache layout: plugins/cache/<marketplace>/<plugin>/<version>/.codex-plugin/plugin.json
  const cache = join(home, "plugins", "cache");
  for (const marketplace of await directories(cache)) {
    for (const plugin of await directories(join(cache, marketplace.name))) {
      for (const version of await directories(join(cache, marketplace.name, plugin.name))) {
        const root = join(cache, marketplace.name, plugin.name, version.name);
        const manifestText = await readText(join(root, ".codex-plugin", "plugin.json"));
        if (manifestText === null) continue;
        let manifest: unknown;
        try { manifest = JSON.parse(manifestText); } catch { continue; }
        const record = manifest && typeof manifest === "object" ? manifest as Record<string, unknown> : {};
        const namespace = typeof record.name === "string" && record.name ? record.name : plugin.name;
        const roots = typeof record.skills === "string" ? [record.skills]
          : Array.isArray(record.skills) ? record.skills.filter((path): path is string => typeof path === "string") : ["./skills/"];
        for (const skillsRoot of roots) {
          for (const name of await skillsUnder(resolve(root, skillsRoot), 3)) found.push({ name: `${namespace}:${name}`, plugin: namespace });
        }
      }
    }
  }
  const unique = new Map(found.map(skill => [skill.name, skill]));
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** A list entry names a skill exactly, or a plugin to disable all of its skills. */
export function isListed(skill: CodexSkill, list: readonly string[]) {
  return list.includes(skill.name) || (skill.plugin !== null && list.includes(skill.plugin));
}

/** `null` when nothing discovered is listed, so the config carries no empty block. */
export function renderSkillsBlock(skills: readonly CodexSkill[], disable: readonly string[]) {
  const rules = skills.filter(skill => isListed(skill, disable))
    .map(skill => `[[skills.config]]\nname = ${JSON.stringify(skill.name)}\nenabled = false\n`);
  return rules.length ? [BEGIN, `# Disabled: ${disable.join(", ")}`, ...rules, END].join("\n") + "\n" : null;
}

function locateBlock(source: string) {
  const begin = source.indexOf(BEGIN);
  const end = source.indexOf(END);
  if ((begin === -1) !== (end === -1) || end < begin || source.indexOf(BEGIN, begin + 1) !== -1) {
    throw new Error("The managed codex skills block in config.toml is damaged; restore its BEGIN/END markers or remove it");
  }
  return begin === -1 ? null : { begin, end: end + END.length };
}

function skillRules(source: string) {
  let config: unknown;
  try { config = getStaticTOMLValue(parseTOML(source, { tomlVersion: "1.0" })); } catch {
    // Parser messages can include source snippets from credential-bearing TOML.
    throw new Error("config.toml would be invalid with the managed skills block; is skills.config defined inline?");
  }
  const skills = config && typeof config === "object" ? (config as Record<string, unknown>).skills : undefined;
  const rules = skills && typeof skills === "object" ? (skills as Record<string, unknown>).config : undefined;
  return Array.isArray(rules) ? rules as { name?: unknown; enabled?: unknown }[] : [];
}

/** Replace, append or (with `null`) remove the managed block, always leaving it last in the file. */
export function setSkillsBlock(source: string, block: string | null) {
  const found = locateBlock(source);
  let rest = source;
  if (found) {
    const after = source.slice(found.end).replace(/^\r?\n/u, "");
    const before = source.slice(0, found.begin).replace(/\n+$/u, "\n");
    rest = before === "\n" ? after : before + after;
  }
  const result = block === null ? rest : `${rest === "" ? "" : `${rest.replace(/\n*$/u, "\n")}\n`}${block}`;
  if (block !== null) {
    const expected = [...block.matchAll(/^name = (".*")\nenabled = (true|false)$/gmu)].map(match => `${JSON.parse(match[1]!)}=${match[2]}`);
    const actual = skillRules(result).slice(-expected.length).map(rule => `${String(rule.name)}=${String(rule.enabled)}`);
    if (expected.length && actual.join("\n") !== expected.join("\n")) throw new Error("Managed skills rules did not parse as the last skills.config entries");
  }
  return result;
}

async function enrolled(agentDir: string) {
  const source = await readOptional(files(agentDir).state);
  if (source === null) return false;
  const state: unknown = JSON.parse(source);
  return !!state && typeof state === "object" && "active" in state && state.active === true;
}

/** Disable the listed skills in this agent's Codex home. New plugin skills are caught on the next refresh. */
export async function refreshCodexSkills(agentDir: string, disable: readonly string[]) {
  return withLock({ agentDir, prompt: "" }, async () => {
    if (!await enrolled(agentDir)) return { skipped: true, changed: false };
    const path = files(agentDir).config;
    const current = await readOptional(path) ?? "";
    const skills = await discoverCodexSkills(agentDir);
    const changed = await replaceFile(path, current, setSkillsBlock(current, renderSkillsBlock(skills, disable)));
    return {
      changed,
      // Codex reads skills config when its app-server starts; running sessions keep their list.
      restartRequired: changed,
      disabled: skills.filter(skill => isListed(skill, disable)).map(skill => skill.name),
      notFound: disable.filter(entry => !skills.some(skill => isListed(skill, [entry]))),
    };
  });
}

export async function removeCodexSkills(agentDir: string) {
  return withLock({ agentDir, prompt: "" }, async () => {
    const path = files(agentDir).config;
    const current = await readOptional(path);
    if (current === null) return { changed: false };
    return { changed: await replaceFile(path, current, setSkillsBlock(current, null)) };
  });
}

export async function codexSkillsStatus(agentDir: string, disable: readonly string[]) {
  const source = await readOptional(files(agentDir).config) ?? "";
  const found = locateBlock(source);
  const managed = found ? source.slice(found.begin, found.end) : "";
  const disabled = [...managed.matchAll(/^name = (".*")\nenabled = false$/gmu)].map(match => JSON.parse(match[1]!) as string);
  return { managed: found !== null, configured: disable, disabled };
}
