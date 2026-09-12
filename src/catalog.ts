import { join, resolve } from "node:path";
import { parseTOML, getStaticTOMLValue } from "toml-eslint-parser";
import { readOptional, replaceFile, sha256, withLock } from "./manager.js";
import { readPromptPointer, setPromptPointer } from "./toml.js";

export const CATALOG_REFRESH_MS = 24 * 60 * 60 * 1000;
const KEY = "model_catalog_json";
type JsonRecord = Record<string, unknown>;
type Receipt = { schema: 1; active: boolean; previousPointer: string | null; refreshedAt: number; sha256: string; sourceSha256: string; modelCount: number };
function record(value: unknown): value is JsonRecord { return value !== null && typeof value === "object" && !Array.isArray(value); }
function files(agentDir: string) {
  const home = join(resolve(agentDir), "codex-home");
  return { home, config: join(home, "config.toml"), catalog: join(home, "unblock-codex-models.json"), receipt: join(home, ".unblock-codex-catalog.json") };
}

function parseReceipt(source: string | null): Receipt | null {
  if (source === null) return null;
  const value: unknown = JSON.parse(source);
  if (!record(value) || value.schema !== 1 || typeof value.active !== "boolean" ||
      (value.previousPointer !== null && typeof value.previousPointer !== "string") ||
      typeof value.refreshedAt !== "number" || !Number.isFinite(value.refreshedAt) ||
      typeof value.sha256 !== "string" || typeof value.sourceSha256 !== "string" || typeof value.modelCount !== "number") {
    throw new Error("Invalid catalog receipt");
  }
  return { schema: 1, active: value.active, previousPointer: value.previousPointer, refreshedAt: value.refreshedAt,
    sha256: value.sha256, sourceSha256: value.sourceSha256, modelCount: value.modelCount };
}

export function patchCatalog(value: unknown) {
  if (!record(value) || !Array.isArray(value.models) || value.models.length === 0) throw new Error("Upstream response is not a full Codex model catalog");
  const seen = new Set<string>();
  const models = value.models.map((model: unknown) => {
    if (!record(model) || typeof model.slug !== "string" || !model.slug || seen.has(model.slug) ||
        typeof model.base_instructions !== "string" || !Array.isArray(model.supported_reasoning_levels)) {
      throw new Error("Invalid or duplicate Codex model metadata");
    }
    seen.add(model.slug);
    const messages = model.model_messages ?? {};
    if (!record(messages)) throw new Error("Invalid model_messages");
    const multi = messages.multi_agent ?? {};
    if (!record(multi)) throw new Error("Invalid multi_agent metadata");
    const mode = multi.mode ?? {};
    if (!record(mode)) throw new Error("Invalid multi_agent mode metadata");
    return { ...model, model_messages: { ...messages, multi_agent: { ...multi, mode: { ...mode, explicit: "" } } } };
  });
  return { ...value, models };
}

/** Use the configured provider, not the override file or its refreshable cache. */
export async function fetchUpstreamCatalog(agentDir: string, configText: string, request: typeof fetch = fetch) {
  let config: unknown;
  try { config = getStaticTOMLValue(parseTOML(configText)); } catch { throw new Error("Invalid Codex TOML"); }
  if (!record(config) || typeof config.model_provider !== "string" || !record(config.model_providers)) throw new Error("Catalog refresh requires an explicit Codex provider");
  const provider = config.model_providers[config.model_provider];
  if (!record(provider) || typeof provider.base_url !== "string" || typeof provider.env_key !== "string") {
    throw new Error("Catalog refresh requires a provider base_url and existing env_key credential");
  }
  // Never resolve arbitrary auth commands, copy credentials, or fall back to another endpoint.
  const token = process.env[provider.env_key];
  if (!token) throw new Error("Configured catalog provider credential is unavailable in the plugin environment");
  const url = new URL(provider.base_url.replace(/\/$/u, "") + "/models");
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error("Unsupported catalog provider URL");
  const cached: unknown = JSON.parse(await readOptional(join(files(agentDir).home, "models_cache.json")) ?? "null");
  if (!record(cached) || typeof cached.client_version !== "string" || !/^\d+\.\d+\.\d+$/u.test(cached.client_version)) throw new Error("Managed Codex client version missing from its model cache");
  url.searchParams.set("client_version", cached.client_version);
  let response: Response;
  try { response = await request(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    redirect: "error", signal: AbortSignal.timeout(15_000) }); }
  catch { throw new Error("Catalog request failed; installed catalog retained"); }
  if (!response.ok || !response.body) throw new Error(`Catalog endpoint returned HTTP ${response.status}`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8 * 1024 * 1024) throw new Error("Catalog response exceeds 8 MiB");
      chunks.push(value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown; }
  catch { throw new Error("Catalog endpoint returned invalid JSON"); }
}

export async function catalogStatus(agentDir: string) {
  const path = files(agentDir);
  const receipt = parseReceipt(await readOptional(path.receipt));
  const text = await readOptional(path.catalog);
  return { enabled: receipt?.active === true, catalogPath: path.catalog, pointerMatches: readPromptPointer(await readOptional(path.config) ?? "", KEY) === path.catalog,
    contentMatches: receipt !== null && text !== null && sha256(text) === receipt.sha256,
    refreshedAt: receipt?.refreshedAt ?? null, nextRefreshAt: receipt ? receipt.refreshedAt + CATALOG_REFRESH_MS : null, modelCount: receipt?.modelCount ?? 0 };
}

export async function refreshCatalog(agentDir: string, options: { automatic?: boolean; now?: number; fetchCatalog?: typeof fetchUpstreamCatalog } = {}) {
  return withLock({ agentDir, prompt: "" }, async () => {
    const path = files(agentDir);
    const config = await readOptional(path.config) ?? "";
    const previousReceipt = await readOptional(path.receipt);
    const receipt = parseReceipt(previousReceipt);
    const enrollment: unknown = JSON.parse(await readOptional(join(path.home, ".unblock-codex-prompt.json")) ?? "null");
    if (!record(enrollment) || enrollment.active !== true || (options.automatic && receipt?.active === false)) return { skipped: true, changed: false };
    const pointer = readPromptPointer(config, KEY);
    if (pointer !== null && pointer !== path.catalog) throw new Error("A different model_catalog_json is configured; refusing to replace it");
    const previous = await readOptional(path.catalog);
    if (!receipt && (previous !== null || pointer === path.catalog)) throw new Error("Unowned model catalog exists; recover its receipt first");
    // Deliberate edits to this generated file are overwritten from upstream; never reuse it as source.
    const upstream = await (options.fetchCatalog ?? fetchUpstreamCatalog)(agentDir, config);
    const patched = patchCatalog(upstream);
    const contents = `${JSON.stringify(patched, null, 2)}\n`;
    const next: Receipt = { schema: 1, active: true, previousPointer: receipt?.active ? receipt.previousPointer : pointer,
      refreshedAt: options.now ?? Date.now(), sha256: sha256(contents), sourceSha256: sha256(JSON.stringify(upstream)), modelCount: patched.models.length };
    await replaceFile(path.receipt, previousReceipt, `${JSON.stringify(next, null, 2)}\n`);
    const catalogChanged = await replaceFile(path.catalog, previous, contents);
    const configChanged = await replaceFile(path.config, config, setPromptPointer(config, path.catalog, KEY));
    // The pinned managed Codex reloads catalog contents for fresh sessions. A new
    // config pointer still requires activation; existing conversations are not reset.
    return { changed: catalogChanged || configChanged, catalogChanged, configChanged, modelCount: next.modelCount, refreshedAt: next.refreshedAt, sha256: next.sha256, restartRequired: configChanged, newSessionRequired: catalogChanged || configChanged };
  });
}

export async function restoreCatalog(agentDir: string) {
  return withLock({ agentDir, prompt: "" }, async () => {
    const path = files(agentDir);
    const source = await readOptional(path.receipt);
    const receipt = parseReceipt(source);
    if (!receipt) return;
    const config = await readOptional(path.config) ?? "";
    const pointer = readPromptPointer(config, KEY);
    if (pointer !== path.catalog && pointer !== receipt.previousPointer) throw new Error("Foreign catalog pointer; refusing restore");
    await replaceFile(path.receipt, source, `${JSON.stringify({ ...receipt, active: false }, null, 2)}\n`);
    await replaceFile(path.config, config, setPromptPointer(config, receipt.previousPointer, KEY));
  });
}

/** Start promptly if overdue, persist successful refresh time, retry failures hourly. */
export function startCatalogRefresh(run: () => Promise<void>, nextAt: number, onError: () => void) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  let pending: Promise<void> | undefined;
  const schedule = (delay: number) => {
    timer = setTimeout(() => {
      pending = (async () => {
        let next = CATALOG_REFRESH_MS;
        try { await run(); } catch { onError(); next = 60 * 60 * 1000; }
        if (!stopped) schedule(next);
      })();
    }, Math.max(0, delay));
    timer.unref();
  };
  schedule(nextAt - Date.now());
  return async () => { stopped = true; clearTimeout(timer); await pending; };
}
