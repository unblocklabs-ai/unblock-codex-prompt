import { validatePromptUrl } from "./config.js";
import { sha256 } from "./manager.js";

const MAX_BYTES = 256 * 1024;

export const WORKER_RUNTIME_HINT = "deploy the fleet-prompt Worker with runtime support first";

/**
 * Explicit sync and daily shared-prompt refresh validate before changing local state.
 * Without `runtime` the configured URL is fetched exactly as written (the Codex artifact, which
 * every Worker version serves). `runtime: "claude"` adds the parameter with the URL API, keeping
 * `channel` and any other parameters, and requires the Worker to confirm it in X-Prompt-Runtime.
 */
export async function fetchPrompt(url: string, request: typeof fetch = fetch, options: { runtime?: "claude" } = {}) {
  const target = validatePromptUrl(url);
  if (options.runtime) target.searchParams.set("runtime", options.runtime);
  const response = await request(target, {
    redirect: "error",
    credentials: "omit",
    signal: AbortSignal.timeout(10_000),
    headers: { Accept: "text/plain", "Cache-Control": "no-cache" },
  });
  // Workers before runtime support reject the unknown parameter with 400.
  if (!response.ok && response.status === 400 && options.runtime) throw new Error(`Prompt endpoint returned HTTP 400 for runtime=${options.runtime}; ${WORKER_RUNTIME_HINT}`);
  if (!response.ok) throw new Error(`Prompt endpoint returned HTTP ${response.status}; existing snapshot retained`);
  if (options.runtime && response.headers.get("x-prompt-runtime") !== options.runtime) {
    throw new Error(`Prompt endpoint did not confirm runtime=${options.runtime}; ${WORKER_RUNTIME_HINT}`);
  }
  const type = response.headers.get("content-type")?.split(";")[0]?.trim();
  if (type !== "text/plain" || !response.body) throw new Error("Prompt endpoint must return plain text");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error("Prompt exceeds 256 KiB limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const prompt = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  if (!prompt.trim() || prompt.includes("\0")) throw new Error("Prompt is empty or contains NUL bytes");
  const revision = sha256(prompt);
  if (response.headers.get("x-prompt-revision") !== revision) throw new Error("Prompt revision does not match response body");
  return { prompt, source: { url: options.runtime ? target.href : url, revision } };
}

/** Per-runtime fetchers for one configured promptUrl; Codex never sends `runtime`. */
export function policyFetchers(url: string, request?: typeof fetch) {
  return { codex: () => fetchPrompt(url, request), claude: () => fetchPrompt(url, request, { runtime: "claude" }) };
}
