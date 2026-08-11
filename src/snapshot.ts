import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import * as ignoreModule from "ignore";
import { createTwoFilesPatch, structuredPatch } from "diff";
import type { FileChange, ChangeKind, Hunk } from "./types.js";

type Ignore = import("ignore").Ignore;
const ignore: (options?: import("ignore").Options) => Ignore = (
  ignoreModule as unknown as { default: (options?: import("ignore").Options) => Ignore }
).default;

export interface SnapshotEntry {
  hash: string;
  size: number;
  binary: boolean;
}

export interface Snapshot {
  root: string;
  entries: Map<string, SnapshotEntry>;
  /** Files that existed but were skipped (too big): we cannot restore them. */
  skipped: Set<string>;
}

export interface SnapshotOptions {
  sizeLimitBytes: number;
}

const DEFAULT_IGNORES = [
  ".git",
  ".hg",
  ".svn",
  ".opencode",
  ".idea",
  ".vscode",
  "node_modules",
  "dist",
  "build",
  "out",
  ".cache",
  "coverage",
  ".next",
  ".turbo",
  ".nuxt",
  ".venv",
  "venv",
  "__pycache__",
  ".DS_Store",
  "*.pyc",
];

function buildIgnore(root: string): Ignore {
  const ig = ignore().add(DEFAULT_IGNORES);
  try {
    const content = fsSync.readFileSync(path.join(root, ".gitignore"), "utf8");
    ig.add(content);
  } catch {
    // no .gitignore
  }
  try {
    const content = fsSync.readFileSync(path.join(root, ".opencode", "ignore"), "utf8");
    ig.add(content);
  } catch {
    // no opencode ignore
  }
  return ig;
}

function isBinary(buffer: Buffer): boolean {
  const len = Math.min(buffer.length, 8000);
  for (let i = 0; i < len; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function isDir(file: fsSync.Dirent, full: string): Promise<boolean> {
  if (file.isDirectory()) return true;
  if (file.isSymbolicLink()) {
    try {
      return (await fs.stat(full)).isDirectory();
    } catch {
      return false;
    }
  }
  return false;
}

/** Recursively walk the workspace, storing content of each eligible file keyed by hash. */
export async function createSnapshot(
  root: string,
  storeDir: string,
  opts: SnapshotOptions,
): Promise<Snapshot> {
  const ig = buildIgnore(root);
  const entries = new Map<string, SnapshotEntry>();
  const skipped = new Set<string>();
  const rootAbs = path.resolve(root);

  const walk = async (dir: string): Promise<void> => {
    let items: fsSync.Dirent[];
    try {
      items = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const full = path.join(dir, item.name);
      const rel = path.relative(rootAbs, full).split(path.sep).join("/");
      if (ig.ignores(rel)) continue;
      if (await isDir(item, full)) {
        await walk(full);
        continue;
      }
      if (!item.isFile()) continue;
      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }
      if (stat.size > opts.sizeLimitBytes) {
        skipped.add(rel);
        continue;
      }
      if (stat.size === 0) {
        entries.set(rel, { hash: "empty", size: 0, binary: false });
        continue;
      }
      let buffer: Buffer;
      try {
        buffer = await fs.readFile(full);
      } catch {
        continue;
      }
      const hash = sha256(buffer);
      await fs.writeFile(path.join(storeDir, hash), buffer).catch(() => {});
      entries.set(rel, { hash, size: buffer.length, binary: isBinary(buffer) });
    }
  };

  await walk(rootAbs);
  return { root: rootAbs, entries, skipped };
}

export interface RawChange {
  relPath: string;
  kind: ChangeKind;
  before?: Buffer;
  after?: Buffer;
  /** True when the file is either too big to have been snapshotted or lives in an ignored folder. */
  unrestorable?: boolean;
}

/** Compare the current tree against a snapshot and gather per-file changes. */
export async function computeChanges(
  snapshot: Snapshot,
  storeDir: string,
): Promise<RawChange[]> {
  const changes: RawChange[] = [];
  const root = snapshot.root;
  const seen = new Set<string>();
  const ig = buildIgnore(root);

  const readStore = async (hash: string): Promise<Buffer> => {
    if (hash === "empty") return Buffer.alloc(0);
    return fs.readFile(path.join(storeDir, hash));
  };

  const walk = async (dir: string): Promise<void> => {
    let items: fsSync.Dirent[];
    try {
      items = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const full = path.join(dir, item.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (ig.ignores(rel)) continue;
      if (await isDir(item, full)) {
        await walk(full);
        continue;
      }
      if (!item.isFile()) continue;
      seen.add(rel);
      const before = snapshot.entries.get(rel);
      let after: Buffer | undefined;
      try {
        after = await fs.readFile(full);
      } catch {
        after = undefined;
      }
      if (before) {
        const hash = sha256(after ?? Buffer.alloc(0));
        if (hash === before.hash) continue;
        const beforeBuffer = await readStore(before.hash);
        changes.push({
          relPath: rel,
          kind: "binary",
          before: beforeBuffer,
          after,
          unrestorable: beforeBuffer.length === 0 && before.size > 0,
        });
      } else if (snapshot.skipped.has(rel)) {
        // Pre-existing file that was too big to snapshot; we cannot restore it.
        changes.push({ relPath: rel, kind: "modified", before: undefined, after, unrestorable: true });
      } else {
        // New file, not present in the snapshot.
        changes.push({ relPath: rel, kind: "added", before: Buffer.alloc(0), after });
      }
    }
  };

  await walk(root);

  // Files that were in the snapshot but no longer exist → deleted by opencode.
  for (const [rel, entry] of snapshot.entries) {
    if (seen.has(rel)) continue;
    const beforeBuffer = await readStore(entry.hash);
    changes.push({
      relPath: rel,
      kind: "deleted",
      before: beforeBuffer,
      after: Buffer.alloc(0),
      unrestorable: beforeBuffer.length === 0 && entry.size > 0,
    });
  }

  // Refine kinds: a changed file that is not binary is "modified" (or "added"
  // is already set for new files, "deleted" for removed ones).
  for (const change of changes) {
    if (change.kind === "binary") {
      const isBinaryNow = change.after ? isBinary(change.after) : false;
      const wasBinary = change.before ? isBinary(change.before) : false;
      change.kind = isBinaryNow || wasBinary ? "binary" : "modified";
    }
  }

  return changes;
}

/** Restore the working tree to the state captured in the snapshot. */
export async function restoreSnapshot(
  snapshot: Snapshot,
  storeDir: string,
  changes: RawChange[],
): Promise<{ unrestorable: string[] }> {
  const unrestorable: string[] = [];
  const readStore = async (hash: string): Promise<Buffer> => {
    if (hash === "empty") return Buffer.alloc(0);
    return fs.readFile(path.join(storeDir, hash));
  };

  for (const change of changes) {
    if (change.unrestorable) {
      unrestorable.push(change.relPath);
      continue;
    }
    const full = path.join(snapshot.root, ...change.relPath.split("/"));
    if (change.kind === "added" && (change.before?.length ?? 0) === 0) {
      // opencode created this file → remove it to restore.
      await fs.rm(full, { force: true }).catch(() => {});
      continue;
    }
    const beforeEntry = snapshot.entries.get(change.relPath);
    let content: Buffer;
    if (beforeEntry) {
      content = await readStore(beforeEntry.hash);
    } else {
      content = change.before ?? Buffer.alloc(0);
    }
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }

  return { unrestorable };
}

/** Apply a reviewed change to disk: write the proposed content (accept). */
export async function applyFileChange(change: FileChange): Promise<void> {
  if (change.kind === "deleted") {
    await fs.rm(change.path, { force: true });
    return;
  }
  await fs.mkdir(path.dirname(change.path), { recursive: true });
  await fs.writeFile(change.path, change.after);
}

/** Revert a reviewed change on disk: restore the original content (reject). */
export async function revertFileChange(change: FileChange): Promise<void> {
  if (change.kind === "added" && change.before.length === 0) {
    await fs.rm(change.path, { force: true });
    return;
  }
  await fs.mkdir(path.dirname(change.path), { recursive: true });
  await fs.writeFile(change.path, change.before);
}

/**
 * Compute the changed segments (hunks) between before and after, with 1-based
 * line ranges. Used to drive per-segment accept/reject in the diff editor.
 */
export function computeHunks(before: Buffer, after: Buffer): Hunk[] {
  if (before.length === 0 && after.length === 0) return [];
  try {
    const patch = structuredPatch("a", "b", before.toString("utf8"), after.toString("utf8"), "", "", {
      context: 0,
    });
    return patch.hunks
      .filter((h) => h.oldLines > 0 || h.newLines > 0)
      .map((h) => ({
        oldStart: h.oldStart,
        oldLines: h.oldLines,
        newStart: h.newStart,
        newLines: h.newLines,
      }));
  } catch {
    return [];
  }
}

/**
 * Return the after content with a single segment (hunk) rejected, i.e. the
 * after lines covered by the hunk are replaced by the corresponding before
 * lines. Does not mutate anything.
 */
export function applyHunkReject(before: Buffer, after: Buffer, hunk: Hunk): Buffer {
  const beforeLines = before.toString("utf8").split("\n");
  const afterLines = after.toString("utf8").split("\n");
  const from = hunk.newStart - 1;
  const replacement = beforeLines.slice(hunk.oldStart - 1, hunk.oldStart - 1 + hunk.oldLines);
  const merged = [...afterLines.slice(0, from), ...replacement, ...afterLines.slice(from + hunk.newLines)];
  return Buffer.from(merged.join("\n"), "utf8");
}

export interface DiffLine {
  /** "context" (unchanged), "add" (only in after), "del" (only in before). */
  kind: "context" | "add" | "del";
  text: string;
  /** Index of the segment (hunk) this line belongs to, or -1 for context lines. */
  hunkIndex: number;
  /** 1-based line number in the before content, 0 for pure additions. */
  oldLine: number;
  /** 1-based line number in the after content, 0 for pure deletions. */
  newLine: number;
}

function contentLines(buf: Buffer): string[] {
  if (buf.length === 0) return [];
  const lines = buf.toString("utf8").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Render-ready, line-level diff between before and after. Every line is tagged
 * with its kind and the segment (hunk) it belongs to, so a review view can show
 * additions (green), deletions (red) and per-segment accept/reject actions.
 */
export function buildDiffLines(before: Buffer, after: Buffer): DiffLine[] {
  return diffLinesFromHunks(before, after, computeHunks(before, after));
}

/**
 * Same as buildDiffLines but restricted to an explicit list of hunks (e.g. the
 * segments of a change that are still pending review). Each line's hunkIndex is
 * its position within the provided hunks array.
 */
export function diffLinesFromHunks(before: Buffer, after: Buffer, hunks: Hunk[]): DiffLine[] {
  const b = contentLines(before);
  const a = contentLines(after);
  const out: DiffLine[] = [];
  let oldPos = 1;
  let newPos = 1;
  const pushContext = (count: number): void => {
    for (let j = 0; j < count && newPos <= a.length; j++) {
      out.push({ kind: "context", text: a[newPos - 1], hunkIndex: -1, oldLine: oldPos, newLine: newPos });
      oldPos++;
      newPos++;
    }
  };
  for (let i = 0; i < hunks.length; i++) {
    const h = hunks[i];
    pushContext(h.newStart - newPos);
    for (let j = 0; j < h.oldLines && oldPos <= b.length; j++) {
      out.push({ kind: "del", text: b[oldPos - 1], hunkIndex: i, oldLine: oldPos, newLine: 0 });
      oldPos++;
    }
    for (let j = 0; j < h.newLines && newPos <= a.length; j++) {
      out.push({ kind: "add", text: a[newPos - 1], hunkIndex: i, oldLine: 0, newLine: newPos });
      newPos++;
    }
  }
  pushContext(Number.MAX_SAFE_INTEGER);
  return out;
}

/** Compute line-level addition/deletion counts from two buffers. */
export function diffStat(before: Buffer, after: Buffer): { additions: number; deletions: number } {
  if (before.length === 0) {
    const lines = after.toString("utf8").split("\n");
    return { additions: after.length === 0 ? 0 : lines.filter((l) => l.length > 0).length, deletions: 0 };
  }
  if (after.length === 0) {
    const lines = before.toString("utf8").split("\n");
    return { additions: 0, deletions: before.length === 0 ? 0 : lines.filter((l) => l.length > 0).length };
  }
  try {
    const patch = createTwoFilesPatch("a", "b", before.toString("utf8"), after.toString("utf8"), "", "", {
      context: 0,
    });
    let additions = 0;
    let deletions = 0;
    for (const line of patch.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions++;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }
    return { additions, deletions };
  } catch {
    return { additions: 0, deletions: 0 };
  }
}

export async function toFileChanges(changes: RawChange[]): Promise<FileChange[]> {
  const result: FileChange[] = [];
  for (const c of changes) {
    if (c.kind === "binary") continue;
    if (c.unrestorable) continue;
    const stats = diffStat(c.before ?? Buffer.alloc(0), c.after ?? Buffer.alloc(0));
    result.push({
      path: "", // filled by caller
      relPath: c.relPath,
      kind: c.kind,
      before: c.before ?? Buffer.alloc(0),
      after: c.after ?? Buffer.alloc(0),
      additions: stats.additions,
      deletions: stats.deletions,
      hunks: computeHunks(c.before ?? Buffer.alloc(0), c.after ?? Buffer.alloc(0)),
      acceptedRanges: [],
    });
  }
  return result;
}
