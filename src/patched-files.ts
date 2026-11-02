import { readOptional, replaceFile, sha256 } from "./manager.js";

/**
 * The patched-file-set lifecycle both adapters share: receipt ownership, prepare, install,
 * status and restore. Each adapter keeps its own discovery, fingerprints, patch rendering,
 * receipt format and install identity (Codex package or OpenClaw root).
 */

/** A receipt's file entry; the field names are the on-disk receipt format. */
export type PatchedFile = { path: string; originalSha256: string; patchedSha256: string; previousPatchedSha256?: string };

/**
 * What a receipt's files show on disk. Only "patched" (any recorded file still holding this
 * adapter's bytes, including a partial restore) is ownership. "restored" (every file original)
 * and "superseded" (every non-original file gone, or the recorded install version replaced)
 * leave only rollback evidence. "changed" is anything else.
 */
export type Ownership = "none" | "patched" | "restored" | "superseded" | "changed";
export type PatchedFilesState = "absent" | "patched" | "partial" | "original" | "missing" | "changed";

/** A parsed receipt, reduced to what the shared lifecycle needs. */
export type RecordedFiles = {
  /** Install identity recorded at patch time: the Codex package or the OpenClaw root. */
  root: string;
  /** Install version recorded at patch time; receipts before 0.4 may lack it. */
  version?: string;
  files: PatchedFile[];
  /** Where this receipt kept a file's original bytes. */
  backupPath(file: PatchedFile): string;
};

export type PatchedFileSet = {
  receiptPath: string;
  parseReceipt(source: string): RecordedFiles;
  /** The version installed at a recorded root now; null when it cannot be read. */
  installedVersion(root: string): Promise<string | null>;
  /** Where a new install keeps a file's original bytes. */
  backupPath(path: string): string;
  messages: {
    installChanged: string; changed: string; missing: string; prepareBackupInvalid: string; moved: string;
    foreignBackup: string; concurrent: string; foreignEdit: string; backupInvalid: string;
  };
};

type Observed = { file: PatchedFile; current: string | null; hash: string | null };

async function observe(recorded: RecordedFiles): Promise<Observed[]> {
  return Promise.all(recorded.files.map(async file => {
    const current = await readOptional(file.path);
    return { file, current, hash: current === null ? null : sha256(current) };
  }));
}
const holdsPatched = ({ file, hash }: Observed) => hash !== null && (hash === file.patchedSha256 || hash === file.previousPatchedSha256);
const holdsOriginal = ({ file, hash }: Observed) => hash === file.originalSha256;

/** An update replaced the recorded install: only receipts that recorded a version can say so. */
async function versionChanged(set: PatchedFileSet, recorded: RecordedFiles) {
  return recorded.version !== undefined && await set.installedVersion(recorded.root) !== recorded.version;
}

async function ownershipOf(set: PatchedFileSet, recorded: RecordedFiles, observed: Observed[]): Promise<Ownership> {
  if (observed.some(holdsPatched)) return "patched";
  if (observed.every(holdsOriginal)) return "restored";
  // Updates rename hashed bundles (old files missing) or replace a recorded version.
  if (observed.every(entry => holdsOriginal(entry) || entry.current === null) || await versionChanged(set, recorded)) return "superseded";
  return "changed";
}

async function load(set: PatchedFileSet) {
  const source = await readOptional(set.receiptPath);
  return { source, recorded: source === null ? null : set.parseReceipt(source) };
}

export async function patchedFilesOwnership(set: PatchedFileSet): Promise<Ownership> {
  const { recorded } = await load(set);
  return recorded ? ownershipOf(set, recorded, await observe(recorded)) : "none";
}

/** The previous receipt, its ownership, and the root a new install may default to. */
export async function openPatchedFiles(set: PatchedFileSet) {
  const { source, recorded } = await load(set);
  const ownership = recorded ? await ownershipOf(set, recorded, await observe(recorded)) : "none";
  return { previousReceipt: source, recorded, ownership };
}

export type PreparedFile = { path: string; current: string; original: string; patched: string };

/**
 * Start a patch at `root`. A restored or superseded receipt counts as cleared: any root is
 * allowed and its backups may be replaced. Otherwise every recorded file must still hold this
 * adapter's bytes (an interrupted re-patch is recognized by previousPatchedSha256) unless it
 * is missing or the recorded version was replaced; the adapter then reads originals through
 * `read` (backups for owned files) and hands its patched sources to `finish`.
 */
export async function beginPatch(set: PatchedFileSet, opened: Awaited<ReturnType<typeof openPatchedFiles>>, root: string) {
  const { previousReceipt, recorded, ownership } = opened;
  const cleared = ownership === "restored" || ownership === "superseded";
  const kept = cleared ? null : recorded;
  if (kept && kept.root !== root) throw new Error(set.messages.installChanged);
  const owned = new Map<string, PatchedFile>();
  const superseded: PatchedFile[] = [];
  if (kept) {
    const updated = await versionChanged(set, kept);
    for (const entry of await observe(kept)) {
      if (holdsPatched(entry) || holdsOriginal(entry)) owned.set(entry.file.path, entry.file);
      else if (entry.current === null || updated) superseded.push(entry.file);
      else throw new Error(set.messages.changed);
    }
  }
  const originals = new Map<string, { current: string; original: string }>();
  const read = async (path: string) => {
    const current = await readOptional(path);
    if (current === null) throw new Error(set.messages.missing);
    const file = owned.get(path);
    const original = file ? await readOptional(kept!.backupPath(file)) : current;
    if (original === null || (file && sha256(original) !== file.originalSha256)) throw new Error(set.messages.prepareBackupInvalid);
    originals.set(path, { current, original });
    return original;
  };
  /** `patched` maps each changed path (read through `read`) to its patched source, in receipt order. */
  const finish = (patched: Map<string, string>) => {
    if ([...owned.keys()].some(path => !patched.has(path))) throw new Error(set.messages.moved);
    const files: PreparedFile[] = [...patched].map(([path, contents]) => {
      const source = originals.get(path);
      if (!source) throw new Error(set.messages.missing);
      return { path, ...source, patched: contents };
    });
    const entries: PatchedFile[] = files.map(file => ({
      path: file.path, originalSha256: sha256(file.original), patchedSha256: sha256(file.patched),
      // Receipt-first upgrades must remain recoverable if source swapping is interrupted.
      ...file.current !== file.original && file.current !== file.patched ? { previousPatchedSha256: sha256(file.current) } : {},
    }));
    // Backups of a cleared receipt, or of files an update superseded, may be replaced; any other is foreign.
    const staleBackups = new Set((cleared ? recorded!.files : superseded).map(file => file.originalSha256));
    return { files, entries, previousReceipt, staleBackups };
  };
  return { read, finish };
}

export type PatchPlan = { files: PreparedFile[]; previousReceipt: string | null; staleBackups: Set<string> };

/** Validates every target before any change; keeps exact original backups, then the receipt, then the files. */
export async function installPatch(set: PatchedFileSet, plan: PatchPlan, receipt: string) {
  const backups = await Promise.all(plan.files.map(async file => {
    const path = set.backupPath(file.path);
    const backup = await readOptional(path);
    if (backup !== null && backup !== file.original && !plan.staleBackups.has(sha256(backup))) throw new Error(set.messages.foreignBackup);
    if (await readOptional(file.path) !== file.current) throw new Error(set.messages.concurrent);
    return { path, backup, original: file.original };
  }));
  for (const backup of backups) await replaceFile(backup.path, backup.backup, backup.original);
  await replaceFile(set.receiptPath, plan.previousReceipt, receipt);
  let adapterChanged = false;
  for (const file of plan.files) adapterChanged = await replaceFile(file.path, file.current, file.patched) || adapterChanged;
  return { adapterChanged, restartRequired: true };
}

/** Disk state of every recorded file; distinguishes missing files (an update) from foreign edits. */
export async function patchedFilesStatus(set: PatchedFileSet) {
  const { recorded } = await load(set);
  if (!recorded) return null;
  const states = (await observe(recorded)).map(entry => entry.current === null ? "missing" : entry.hash === entry.file.patchedSha256 ? "patched"
    : holdsPatched(entry) ? "stale" : holdsOriginal(entry) ? "original" : "changed");
  const state: PatchedFilesState = states.every(value => value === "patched") ? "patched" : states.includes("changed") ? "changed"
    : states.includes("missing") ? "missing" : states.some(value => value === "patched" || value === "stale") ? "partial" : "original";
  return { recorded, state, installed: state === "patched", paths: recorded.files.map(file => file.path) };
}

/**
 * Validates the whole restore before any write, and plans nothing unless this adapter's bytes
 * are installed. Files holding them are restored; missing files are superseded; foreign bytes
 * are superseded only after the recorded version was replaced, otherwise refused. Backups are
 * checked only for files that will be written.
 */
export type RestorePlan = { ownership: Ownership; files: { path: string; current: string; original: string }[]; superseded: string[] };

export async function planPatchedRestore(set: PatchedFileSet): Promise<RestorePlan> {
  const { recorded } = await load(set);
  if (!recorded) return { ownership: "none", files: [], superseded: [] };
  const observed = await observe(recorded);
  const ownership = await ownershipOf(set, recorded, observed);
  if (ownership !== "patched") return { ownership, files: [], superseded: [] };
  const updated = await versionChanged(set, recorded);
  const ours: Observed[] = [];
  const superseded: string[] = [];
  for (const entry of observed) {
    if (holdsOriginal(entry)) continue;
    if (holdsPatched(entry)) ours.push(entry);
    else if (entry.current === null || updated) superseded.push(entry.file.path);
    else throw new Error(set.messages.foreignEdit);
  }
  const files = await Promise.all(ours.map(async ({ file, current }) => {
    const original = await readOptional(recorded.backupPath(file));
    if (original === null || sha256(original) !== file.originalSha256) throw new Error(set.messages.backupInvalid);
    return { path: file.path, current: current!, original };
  }));
  return { ownership, files, superseded };
}

export async function applyPatchedRestore(plan: RestorePlan) {
  for (const file of plan.files) await replaceFile(file.path, file.current, file.original);
  return { ownership: plan.ownership, files: plan.files.map(file => file.path), superseded: plan.superseded, restartRequired: plan.files.length > 0 };
}
