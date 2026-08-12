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

/** One answer choice proposed by opencode. */
export interface QuestionOption {
  label: string;
  description?: string;
}

/** A question opencode asks the user while a run is in progress. */
export interface AskedQuestion {
  question: string;
  header?: string;
  options: QuestionOption[];
  /** Allow several answers to be picked at once. */
  multiple?: boolean;
  /** Allow the user to type a custom answer instead of picking an option. */
  custom?: boolean;
}

/** A permission opencode asks for mid-run (edit, write, bash, webfetch…). */
export interface AskedPermission {
  id: string;
  tool: string;
  title: string;
  metadata: Record<string, unknown>;
}

/** Answer to a permission prompt: allow this once, always allow, or reject. */
export type PermissionResponse = "once" | "always" | "reject";

export interface RunOptions {
  workspaceRoot: string;
  /** Base URL of the opencode server (used to answer pending questions). */
  baseUrl: string;
  prompt: string;
  model?: { providerID: string; modelID: string };
  agent?: string;
  /** Reuse an existing opencode session (keeps the conversation context). */
  sessionID?: string;
  /**
   * Read-only run: after opencode finishes, any file it changed is restored to
   * the snapshot so the workspace ends up untouched (plan mode).
   */
  restoreOnComplete?: boolean;
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
