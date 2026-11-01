// The reviewed live-persona carriers first ship in OpenClaw/@openclaw/codex 2026.10.5.
export const MINIMUM_OPENCLAW = "2026.10.5";

export function assertSupportedVersion(version: unknown, product: string) {
  const match = typeof version === "string" ? /^(\d+)\.(\d+)\.(\d+)(?:-\d+)?$/u.exec(version) : null;
  const supported = match && (Number(match[1]) > 2026 ||
    (Number(match[1]) === 2026 && (Number(match[2]) > 10 ||
      (Number(match[2]) === 10 && Number(match[3]) >= 5))));
  if (!supported) throw new Error(`Frozen bridge requires ${product} >=${MINIMUM_OPENCLAW} (stable release)`);
}
