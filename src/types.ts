export type ChangeKind = "added" | "deleted" | "modified" | "binary";

/** A changed segment (hunk) within a file, with 1-based line ranges. */
export interface Hunk {
  /** Start line (1-based) in the before content. */
  oldStart: number;
  /** Number of lines in the before content covered by the hunk. */
  oldLines: number;
  /** Start line (1-based) in the after content. */
  newStart: number;
  /** Number of lines in the after content covered by the hunk. */
  newLines: number;
}

export interface FileChange {
  /** Absolute path on disk. */
  path: string;
  /** Path relative to the workspace root, using forward slashes. */
  relPath: string;
  kind: ChangeKind;
  before: Buffer;
  after: Buffer;
  additions: number;
  deletions: number;
  /** Changed segments; empty for binary changes. */
  hunks: Hunk[];
  /**
   * Segments already accepted (kept in the file, so the disk content is left
   * unchanged), identified by their stable before-region (oldStart/oldLines)
   * so they survive recomputation after other segments are rejected.
   */
  acceptedRanges: { oldStart: number; oldLines: number }[];
}

export interface RunOptions {
  workspaceRoot: string;
  prompt: string;
  model?: { providerID: string; modelID: string };
  agent?: string;
  /** Called for each SSE event coming from the opencode server. */
  onEvent?: (event: unknown) => void;
  /** Called to surface user-facing progress strings (tool calls, permissions…). */
  onProgress?: (label: string) => void;
  signal?: AbortSignal;
  snapshotSizeLimitBytes: number;
  allowBash: boolean;
  webfetchPermission: "allow" | "deny";
}

export interface RunResult {
  sessionID: string;
  messageID: string;
  /** Assistant reply text (raw). */
  reply: string;
  changes: FileChange[];
  /** Files that opencode modified but that we could not restore. */
  unrestorable: string[];
  /** True if the run was aborted (cancellation). */
  aborted: boolean;
}
