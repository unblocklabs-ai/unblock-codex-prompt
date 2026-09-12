import { validatePromptUrl } from "./config.js";
import { sha256 } from "./manager.js";

const MAX_BYTES = 256 * 1024;

// The operating policy lives in the downloaded base, not in a second policy copy.
export const REMOTE_POLICY = "The shared operating instructions and frozen agent context are provided in the base instructions. Current tool schemas, permissions and session routing remain separate.";

/** Explicit sync and daily shared-prompt refresh validate before changing local state. */
export async function fetchPrompt(url: string, request: typeof fetch = fetch) {
  const response = await request(validatePromptUrl(url), {
    redirect: "error",
    credentials: "omit",
    signal: AbortSignal.timeout(10_000),
    headers: { Accept: "text/plain", "Cache-Control": "no-cache" },
  });
  if (!response.ok) throw new Error(`Prompt endpoint returned HTTP ${response.status}; existing snapshot retained`);
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
  return { prompt, source: { url, revision } };
}
