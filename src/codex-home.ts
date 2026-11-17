import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const CODEX_HOME_OWNER = ".unblock-codex-prompt-owner";
export const agentCodexHome = (agentDir: string) => join(resolve(agentDir), "codex-home");

/** undefined means OpenClaw's ordinary agent-scoped stdio home. */
export function configuredCodexHome(config: unknown) {
  const appServer = (config as { plugins?: { entries?: { codex?: { config?: { appServer?: unknown } } } } })?.plugins?.entries?.codex?.config?.appServer;
  if (appServer === undefined) return undefined;
  if (!appServer || typeof appServer !== "object" || Array.isArray(appServer)) throw new Error("Invalid Codex appServer config");
  if (("transport" in appServer && appServer.transport !== "stdio") ||
      ("homeScope" in appServer && appServer.homeScope !== "agent" && appServer.homeScope !== "user")) {
    throw new Error("Only local stdio Codex is supported");
  }
  if (!("homeScope" in appServer) || appServer.homeScope !== "user") return undefined;
  const home = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  if (!isAbsolute(home)) throw new Error("User-scoped Codex requires an absolute CODEX_HOME");
  return resolve(home);
}

/** Local stdio user homes are shared by default. An operator must reserve the actual home. */
export function assertDedicatedCodexHome(home: string, agentDir: string) {
  if (!isAbsolute(home) || resolve(home) !== home || dirname(home) === home || home === homedir()) {
    throw new Error("Expected an absolute dedicated Codex home");
  }
  const error = () => new Error(`User-scoped Codex requires a dedicated home: ${join(home, CODEX_HOME_OWNER)} must contain ${resolve(agentDir)}. Do not mark a shared home.`);
  try {
    for (let path = home; ; path = dirname(path)) {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || (path === home && (stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0))) throw error();
      if (dirname(path) === path) break;
    }
    const marker = join(home, CODEX_HOME_OWNER);
    const stat = lstatSync(marker);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0 || stat.size > 4096 ||
        readFileSync(marker, "utf8").trim() !== resolve(agentDir)) throw error();
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") throw error();
    throw cause;
  }
}
