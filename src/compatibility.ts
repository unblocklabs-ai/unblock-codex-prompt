export const MINIMUM_OPENCLAW = "2026.9.2";

export function assertSupportedVersion(version: unknown, product: string) {
  const match = typeof version === "string" ? /^(\d+)\.(\d+)\.(\d+)(?:-\d+)?$/u.exec(version) : null;
  const supported = match && (Number(match[1]) > 2026 ||
    (Number(match[1]) === 2026 && (Number(match[2]) > 9 ||
      (Number(match[2]) === 9 && Number(match[3]) >= 2))));
  if (!supported) throw new Error(`Frozen bridge requires ${product} >=${MINIMUM_OPENCLAW} (stable release)`);
}
