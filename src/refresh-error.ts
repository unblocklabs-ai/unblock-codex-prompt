// Only plugin-owned diagnostics are safe to log. Transport errors and parser
// exceptions can contain credentials, configuration, or remote response bodies.
const SAFE_CAUSES = new Set([
  "Catalog refresh requires an explicit Codex provider",
  "Catalog refresh requires a provider base_url and existing env_key credential",
  "Configured catalog provider credential is unavailable in the plugin environment",
  "Managed Codex client version missing from its model cache",
  "Catalog request failed; installed catalog retained",
  "Catalog endpoint returned invalid JSON",
  "Upstream response is not a full Codex model catalog",
  "Invalid or duplicate Codex model metadata",
  "Invalid model_messages", "Invalid multi_agent metadata", "Invalid multi_agent mode metadata", "Invalid model message metadata",
  "Invalid Codex TOML", "Unsupported catalog provider URL", "Catalog response exceeds 8 MiB",
  "A different model_catalog_json is configured; refusing to replace it",
  "Unowned model catalog exists; recover its receipt first",
  "Managed prompt pointer missing or changed; refusing refresh",
  "Valid enrolled remote snapshot required; run codex-prompt sync",
  "Frozen context boundary is ambiguous; run codex-prompt sync",
  "Prompt endpoint must return plain text", "Prompt exceeds 256 KiB limit",
  "Prompt is empty or contains NUL bytes", "Prompt revision does not match response body",
  "The managed codex skills block in config.toml is damaged; restore its BEGIN/END markers or remove it",
  "config.toml would be invalid with the managed skills block; is skills.config defined inline?",
  "Managed skills rules did not parse as the last skills.config entries",
  "Invalid catalog receipt", "Invalid prompt enrollment state",
  "Invalid shared prompt revision", "Enrollment or configuration changed during refresh",
]);

export function refreshFailure(component: "catalog" | "shared prompt" | "skills", error: unknown) {
  const message = error instanceof Error ? error.message : "";
  const safe = SAFE_CAUSES.has(message) || /^(?:Catalog endpoint returned HTTP \d{3}|Prompt endpoint returned HTTP \d{3}; existing snapshot retained)$/u.test(message);
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const cause = safe ? message : error instanceof SyntaxError ? "Managed JSON state is invalid; inspect codex-prompt status"
    : error instanceof Error && error.name === "TimeoutError" ? "Endpoint request timed out"
    : error instanceof Error && message.startsWith("Prompt sync is locked:") ? "Prompt sync is locked; check for an active sync before recovery"
    : ["EACCES", "EPERM", "ENOENT", "ENOSPC"].includes(String(code))
    ? `Local state I/O failed (${code}); check managed files and access`
    : "Request or local-state validation failed; check the endpoint and managed state with codex-prompt status";
  return new Error(`${component}: ${cause}`);
}
