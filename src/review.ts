import * as vscode from "vscode";
import path from "node:path";
import type { FileChange, Hunk } from "./types.js";
import { applyHunkReject, computeHunks, mergeFileChanges, revertFileChange } from "./snapshot.js";

/** Custom scheme serving the original (before) content of a change. */
export const ORIGINAL_SCHEME = "opencode-review-original";

/** Theme color id of the pending-review badge in the Explorer. */
export const PENDING_FOREGROUND = "opencodeDiff.pendingForeground";

export interface Review {
  root: string;
  sessionID: string;
  messageID: string;
  reply: string;
  changes: Map<string, FileChange>;
  createdAt: number;
  /** True while an opencode run is still in progress (live updates). */
  running?: boolean;
}

/**
 * Shallow-clone a review (and its changes) so it can be restored unchanged
 * after an aborted run.
 */
export function cloneReview(review: Review): Review {
  return {
    ...review,
    changes: new Map(
      [...review.changes].map(([relPath, change]) => [
        relPath,
        { ...change, hunks: [...change.hunks], acceptedRanges: [...change.acceptedRanges] },
      ]),
    ),
  };
}

/**
 * Holds the pending reviews (one per workspace root) so the review list, the
 * diff editors and the accept/reject commands share the same state.
 */
export class ReviewStore {
  private reviews = new Map<string, Review>();
  private onDidChange = new vscode.EventEmitter<void>();

  readonly onDidChangeEvent = this.onDidChange.event;

  set(review: Review): void {
    this.reviews.set(review.root, review);
    this.onDidChange.fire();
  }

  /**
   * Store or merge a review for a root. When a review already holds changes
   * (e.g. from an earlier prompt), the incoming changes are merged on top of it
   * keeping the original `before`, so the +n−m indicators stay cumulative
   * across several prompts. Fires the change event.
   *
   * `opts.keepUntouched` decides whether files that are under review but were
   * not touched by this batch stay in the review (default: yes). Pass a
   * predicate restricted to the changes that predate the current run so that
   * files that only appeared during the run's live phase and were reverted are
   * dropped again.
   */
  merge(
    root: string,
    incoming: {
      sessionID: string;
      messageID: string;
      reply: string;
      changes: Map<string, FileChange>;
      createdAt: number;
      running?: boolean;
    },
    opts: { keepUntouched?: (relPath: string) => boolean } = {},
  ): Review {
    const existing = this.reviews.get(root);
    const incomingList = [...incoming.changes.values()];
    const mergedList = existing
      ? mergeFileChanges(existing.changes, incomingList, opts.keepUntouched)
      : incomingList;
    const changes = new Map(mergedList.map((change) => [change.relPath, change]));
    const review: Review = {
      root,
      sessionID: incoming.sessionID,
      messageID: incoming.messageID,
      reply: incoming.reply,
      changes,
      createdAt: incoming.createdAt,
      running: incoming.running,
    };
    this.reviews.set(root, review);
    this.onDidChange.fire();
    return review;
  }

  /** Flip the running flag of a review without touching its changes. */
  setRunning(root: string, running: boolean): void {
    const review = this.reviews.get(root);
    if (review && review.running !== running) {
      review.running = running;
      this.onDidChange.fire();
    }
  }

  get(root: string): Review | undefined {
    return this.reviews.get(root);
  }

  getActive(): Review | undefined {
    return this.reviews.values().next().value;
  }

  all(): Review[] {
    return [...this.reviews.values()];
  }

  /** Fire the change event without altering the data (used after a segment reject). */
  touch(root: string): void {
    if (this.reviews.has(root)) this.onDidChange.fire();
  }

  clear(root: string): void {
    this.reviews.delete(root);
    this.onDidChange.fire();
  }

  removeChange(root: string, relPath: string): void {
    this.reviews.get(root)?.changes.delete(relPath);
    this.onDidChange.fire();
  }

  hasAny(): boolean {
    return [...this.reviews.values()].some((r) => r.changes.size > 0);
  }
}

/**
 * Accept a whole file: the modification is kept on disk as-is (opencode already
 * applied it), the file just leaves the review.
 */
export async function acceptChange(store: ReviewStore, root: string, change: FileChange): Promise<void> {
  store.removeChange(root, change.relPath);
}

/** Reject a whole file: restore the original content and leave the review. */
export async function rejectChange(store: ReviewStore, root: string, change: FileChange): Promise<void> {
  await revertFileChange(change);
  store.removeChange(root, change.relPath);
}

export async function acceptAll(store: ReviewStore, root: string): Promise<number> {
  const review = store.get(root);
  if (!review) return 0;
  const count = review.changes.size;
  store.clear(root);
  return count;
}

export async function rejectAll(store: ReviewStore, root: string): Promise<number> {
  const review = store.get(root);
  if (!review) return 0;
  const changes = [...review.changes.values()];
  for (const change of changes) {
    await revertFileChange(change);
  }
  store.clear(root);
  return changes.length;
}

/** Segments of a change that have not been explicitly accepted yet. */
export function pendingHunks(change: FileChange): Hunk[] {
  return change.hunks.filter(
    (h) => !change.acceptedRanges.some((r) => r.oldStart === h.oldStart && r.oldLines === h.oldLines),
  );
}

function isPending(change: FileChange, hunk: Hunk): boolean {
  return !change.acceptedRanges.some((r) => r.oldStart === hunk.oldStart && r.oldLines === hunk.oldLines);
}

/**
 * Accept one segment: the file stays as-is on disk, the segment is marked as
 * accepted. When every segment has been accepted the file leaves the review.
 */
export async function acceptSegment(store: ReviewStore, root: string, change: FileChange, hunkIndex: number): Promise<void> {
  const hunk = change.hunks[hunkIndex];
  if (!hunk || !isPending(change, hunk)) return;
  change.acceptedRanges.push({ oldStart: hunk.oldStart, oldLines: hunk.oldLines });
  if (pendingHunks(change).length === 0) store.removeChange(root, change.relPath);
  else store.touch(root);
}

/**
 * Reject one segment: the file on disk is rewritten with that segment reverted
 * to its original content. When no segment remains the file leaves the review.
 */
export async function rejectSegment(store: ReviewStore, root: string, change: FileChange, hunkIndex: number): Promise<void> {
  const hunk = change.hunks[hunkIndex];
  if (!hunk || !isPending(change, hunk)) return;
  const after = applyHunkReject(change.before, change.after, hunk);
  await vscode.workspace.fs.writeFile(vscode.Uri.file(change.path), after);
  change.after = after;
  change.hunks = computeHunks(change.before, after);
  change.acceptedRanges = [];
  if (change.hunks.length === 0) store.removeChange(root, change.relPath);
  else store.touch(root);
}

/**
 * Identity of a change embedded in an "original" URI. The root and relative
 * path are base64url-encoded so they survive Uri parsing untouched; the real
 * basename is appended so the diff editor picks up the language and shows a
 * readable label on the left pane.
 */
export function originalUriFor(root: string, relPath: string): vscode.Uri {
  const key = Buffer.from(`${root}\u0000${relPath}`, "utf8").toString("base64url");
  const basename = path.basename(relPath);
  return vscode.Uri.parse(`${ORIGINAL_SCHEME}://diff/${key}/${basename}`);
}

export function decodeOriginalUri(uri: vscode.Uri): { root: string; relPath: string } | undefined {
  if (uri.scheme !== ORIGINAL_SCHEME || uri.authority !== "diff") return undefined;
  const key = uri.path.slice(1).split("/", 1)[0];
  if (!key) return undefined;
  try {
    const raw = Buffer.from(key, "base64url").toString("utf8");
    const idx = raw.indexOf("\u0000");
    if (idx < 0) return undefined;
    return { root: raw.slice(0, idx), relPath: raw.slice(idx + 1) };
  } catch {
    return undefined;
  }
}

/** Find the FileChange whose absolute path on disk is `fsPath`, across all reviews. */
export function changeForPath(store: ReviewStore, fsPath: string): { root: string; relPath: string; change: FileChange } | undefined {
  for (const review of store.all()) {
    const relPath = path.relative(review.root, fsPath).split(path.sep).join("/");
    const change = review.changes.get(relPath);
    if (change) return { root: review.root, relPath, change };
  }
  return undefined;
}

/**
 * Serves the original content of a reviewed change as a virtual document, so
 * the native diff editor (the same view as "Compare to") can show before/after.
 */
export class OriginalDocumentProvider implements vscode.TextDocumentContentProvider {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(private readonly lookup: (root: string, relPath: string) => Buffer | undefined) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    const key = decodeOriginalUri(uri);
    if (!key) return "";
    const buffer = this.lookup(key.root, key.relPath);
    return buffer ? buffer.toString("utf8") : "";
  }
}

/**
 * The review list (side panel): a native tree of the changed files with
 * click-to-open navigation and per-file accept/reject (context menu + title
 * commands). The actual diff lives in the center editor.
 */
export class ReviewTreeItem extends vscode.TreeItem {
  constructor(
    public readonly root: string,
    public readonly change: FileChange,
  ) {
    super(change.relPath, vscode.TreeItemCollapsibleState.None);
    const kind = change.kind === "added" ? "new" : change.kind === "deleted" ? "deleted" : "";
    this.description = `${kind}${kind ? "  ·  " : ""}+${change.additions} −${change.deletions}`;
    this.iconPath = new vscode.ThemeIcon(
      change.kind === "added" ? "file-add" : change.kind === "deleted" ? "file-delete" : "file-code",
    );
    this.contextValue = "opencodeDiff.reviewFile";
    this.command = {
      command: "opencodeDiff.openChange",
      title: "Ouvrir la revue",
      arguments: [root, change.relPath],
    };
  }
}

export class ReviewTreeProvider implements vscode.TreeDataProvider<ReviewTreeItem> {
  private changeEmitter = new vscode.EventEmitter<ReviewTreeItem | undefined | void | ReviewTreeItem[] | null>();
  log: (line: string) => void = () => {};

  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(private store: ReviewStore) {}

  refresh(): void {
    this.changeEmitter.fire(undefined);
  }

  getTreeItem(element: ReviewTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ReviewTreeItem): ReviewTreeItem[] {
    if (element) return [];
    const review = this.store.getActive();
    if (!review) return [];
    return [...review.changes.values()]
      .sort((a, b) => a.relPath.localeCompare(b.relPath))
      .map((change) => new ReviewTreeItem(review.root, change));
  }

  /** The first (alphabetically) change of the active review, for auto-selection. */
  firstItem(): ReviewTreeItem | undefined {
    const review = this.store.getActive();
    if (!review) return undefined;
    const first = [...review.changes.values()].sort((a, b) => a.relPath.localeCompare(b.relPath))[0];
    return first ? new ReviewTreeItem(review.root, first) : undefined;
  }
}

/**
 * The center diff shown in the editor area: one native diff tab per file,
 * rendered by VS Code itself (exactly the "Compare to" view, like Copilot).
 * The left side is the original content served through {@link ORIGINAL_SCHEME},
 * the right side is the real file on disk (opencode already applied it), so the
 * diff stays live if the file is edited afterwards.
 *
 * Accept/reject are available both from the review list and as actions in the
 * diff editor title (context key `opencodeDiff.activeDiff`).
 */
export class ReviewEditorProvider implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private activeDiffContext = false;
  private activeSegmentContext = false;
  log: (line: string) => void = () => {};

  constructor(private store: ReviewStore) {
    const update = () => void this.updateActiveContext();
    this.disposables.push(
      vscode.window.tabGroups.onDidChangeTabs(update),
      vscode.window.tabGroups.onDidChangeTabGroups(update),
      vscode.window.onDidChangeActiveTextEditor(update),
      vscode.window.onDidChangeTextEditorSelection(update),
      vscode.window.tabGroups.onDidChangeTabs((e) => this.redirectOpenedTabs(e)),
    );
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }

  /**
   * Open the native diff instead of the plain file whenever a file under
   * review is opened in the Explorer (or anywhere else). Only tabs that are
   * plain text files (not already diffs), non-binary, and not dirty are
   * redirected, so the file can always be edited or previewed normally.
   */
  private redirectOpenedTabs(e: vscode.TabChangeEvent): void {
    const config = vscode.workspace.getConfiguration("opencodeDiff");
    if (!config.get<boolean>("openDiffOnClick", true)) return;
    for (const tab of e.opened) {
      const target = this.diffTargetForTab(tab);
      if (!target) continue;
      this.log(`[diff] redirecting ${target.relPath} to the diff view`);
      void this.open(target.root, target.relPath);
      void vscode.window.tabGroups.close(tab, true);
    }
  }

  /**
   * Convert every already-open plain-file tab of a newly created review into a
   * diff tab (Copilot-like: pending changes surface as diffs).
   */
  convertExistingTabs(root: string): void {
    const config = vscode.workspace.getConfiguration("opencodeDiff");
    if (!config.get<boolean>("openDiffOnClick", true)) return;
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of [...group.tabs]) {
        if (!(tab.input instanceof vscode.TabInputText)) continue;
        if (!tab.input.uri.fsPath.startsWith(root)) continue;
        const target = this.diffTargetForTab(tab);
        if (!target) continue;
        this.log(`[diff] converting ${target.relPath} to the diff view`);
        void this.open(target.root, target.relPath);
        void vscode.window.tabGroups.close(tab, true);
      }
    }
  }

  /**
   * Resolve the reviewed change behind a plain-file tab, or undefined when the
   * tab is not a plain text file, not under review, binary, or dirty.
   */
  private diffTargetForTab(tab: vscode.Tab): { root: string; relPath: string } | undefined {
    if (!(tab.input instanceof vscode.TabInputText)) return undefined;
    const target = changeForPath(this.store, tab.input.uri.fsPath);
    if (!target || target.change.kind === "binary") return undefined;
    if (tab.isDirty) return undefined;
    return { root: target.root, relPath: target.relPath };
  }

  private isOurs(tab: vscode.Tab): boolean {
    return tab.input instanceof vscode.TabInputTextDiff && decodeOriginalUri(tab.input.original) !== undefined;
  }

  private async updateActiveContext(): Promise<void> {
    const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const ours = activeTab ? this.isOurs(activeTab) : false;
    if (ours !== this.activeDiffContext) {
      this.activeDiffContext = ours;
      await vscode.commands.executeCommand("setContext", "opencodeDiff.activeDiff", ours);
    }
    const inSegment = ours ? this.activeSegment() !== undefined : false;
    if (inSegment !== this.activeSegmentContext) {
      this.activeSegmentContext = inSegment;
      await vscode.commands.executeCommand("setContext", "opencodeDiff.activeSegment", inSegment);
    }
  }

  /** Open (or reveal if already open) the native diff of one change. */
  async open(root: string, relPath: string): Promise<void> {
    const change = this.store.get(root)?.changes.get(relPath);
    if (!change) return;
    const original = originalUriFor(root, relPath);
    const modified = vscode.Uri.file(change.path);
    const title = `${path.basename(relPath)} (proposed changes)`;
    this.log(`[diff] opening ${relPath}`);
    try {
      await vscode.commands.executeCommand("vscode.diff", original, modified, title, {
        preview: false,
      });
    } catch (err) {
      this.log(`[diff] open failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    void this.updateActiveContext();
  }

  /** Close the diff tabs of changes that are no longer in the review. */
  refresh(): void {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of [...group.tabs]) {
        if (!(tab.input instanceof vscode.TabInputTextDiff)) continue;
        const key = decodeOriginalUri(tab.input.original);
        if (!key) continue;
        const change = this.store.get(key.root)?.changes.get(key.relPath);
        if (!change) {
          this.log(`[diff] closing ${key.relPath} (no longer under review)`);
          void vscode.window.tabGroups.close(tab, true);
        }
      }
    }
    void this.updateActiveContext();
  }

  private activeChange(): { root: string; relPath: string; change: FileChange } | undefined {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (!tab || !this.isOurs(tab)) return undefined;
    const key = decodeOriginalUri((tab.input as vscode.TabInputTextDiff).original);
    if (!key) return undefined;
    const change = this.store.get(key.root)?.changes.get(key.relPath);
    if (!change) return undefined;
    return { root: key.root, relPath: key.relPath, change };
  }

  /** Accept the change displayed in the active diff tab, then move to the next. */
  async acceptActive(): Promise<void> {
    const target = this.activeChange();
    if (!target) return;
    this.log(`[diff] accepting ${target.relPath}`);
    await acceptChange(this.store, target.root, target.change);
    await this.openNext(target.root);
  }

  /** Reject the change displayed in the active diff tab, then move to the next. */
  async rejectActive(): Promise<void> {
    const target = this.activeChange();
    if (!target) return;
    this.log(`[diff] rejecting ${target.relPath}`);
    await rejectChange(this.store, target.root, target.change);
    await this.openNext(target.root);
  }

  private async openNext(root: string): Promise<void> {
    const review = this.store.get(root);
    if (!review || review.changes.size === 0) return;
    const next = [...review.changes.values()].sort((a, b) => a.relPath.localeCompare(b.relPath))[0];
    await this.open(root, next.relPath);
  }

  /**
   * The pending segment (hunk) under the cursor in the active diff tab, if any.
   * `hunkIndex` is the index of the segment within {@link pendingHunks}.
   */
  private activeSegment(): { root: string; relPath: string; change: FileChange; hunkIndex: number } | undefined {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (!tab || !this.isOurs(tab)) return undefined;
    const key = decodeOriginalUri((tab.input as vscode.TabInputTextDiff).original);
    if (!key) return undefined;
    const change = this.store.get(key.root)?.changes.get(key.relPath);
    if (!change) return undefined;
    const line = vscode.window.activeTextEditor?.selection.active.line;
    if (line === undefined) return undefined;
    const hunks = pendingHunks(change);
    const hunkIndex = hunks.findIndex((h) => h.newStart - 1 <= line && line < h.newStart - 1 + h.newLines);
    if (hunkIndex < 0) return undefined;
    return { root: key.root, relPath: key.relPath, change, hunkIndex };
  }

  /** Accept the segment under the cursor in the active diff tab. */
  async acceptActiveSegment(): Promise<void> {
    const target = this.activeSegment();
    if (!target) return;
    this.log(`[diff] accepting segment in ${target.relPath}`);
    await acceptSegment(this.store, target.root, target.change, target.hunkIndex);
  }

  /** Reject the segment under the cursor in the active diff tab. */
  async rejectActiveSegment(): Promise<void> {
    const target = this.activeSegment();
    if (!target) return;
    this.log(`[diff] rejecting segment in ${target.relPath}`);
    await rejectSegment(this.store, target.root, target.change, target.hunkIndex);
  }
}

/**
 * Marks files under review in the Explorer: a yellow "R" badge next to the file
 * name, exactly like the pending-edit marker shown by agent tools. The badge
 * disappears as soon as the file leaves the review.
 */
export class ReviewFileDecorationProvider implements vscode.FileDecorationProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  private decorations = new Map<string, vscode.FileDecoration>();

  constructor(store: ReviewStore) {
    store.onDidChangeEvent(() => this.sync(store));
    this.sync(store);
  }

  private sync(store: ReviewStore): void {
    const next = new Map<string, vscode.FileDecoration>();
    for (const review of store.all()) {
      for (const change of review.changes.values()) {
        next.set(
          vscode.Uri.file(change.path).toString(),
          new vscode.FileDecoration(
            "R",
            "Modified by opencode (pending review)",
            new vscode.ThemeColor(PENDING_FOREGROUND),
          ),
        );
      }
    }
    const changed = [...new Set([...this.decorations.keys(), ...next.keys()])];
    this.decorations = next;
    if (changed.length > 0) this.emitter.fire(changed.map((s) => vscode.Uri.parse(s)));
  }

  provideFileDecoration(uri: vscode.Uri): vscode.ProviderResult<vscode.FileDecoration> {
    return this.decorations.get(uri.toString());
  }
}

/**
 * A native Source Control instance per workspace root. Files under review show
 * up in the Source Control view with the diff editor opening on click (the
 * built-in "working tree" experience, without requiring git). The
 * {@link QuickDiffProvider} makes VS Code render inline gutter diffs when the
 * file is opened normally.
 */
export class OpencodeReviewSourceControl implements vscode.Disposable {
  private readonly scm: vscode.SourceControl;
  private readonly group: vscode.SourceControlResourceGroup;
  private readonly disposables: vscode.Disposable[] = [];

  log: (line: string) => void = () => {};

  constructor(
    private readonly store: ReviewStore,
    readonly root: string,
  ) {
    this.scm = vscode.scm.createSourceControl("opencodeDiff", "OpenCode Diff", vscode.Uri.file(root));
    this.scm.quickDiffProvider = {
      provideOriginalResource: (uri) => {
        const change = this.changeForUri(uri);
        return change ? originalUriFor(root, change.relPath) : undefined;
      },
    };
    this.group = this.scm.createResourceGroup("changes", "Changes");
    this.group.hideWhenEmpty = true;
    this.group.contextValue = "opencodeDiff.reviewGroup";
    this.disposables.push(
      this.scm,
      this.group,
      store.onDidChangeEvent(() => this.sync()),
    );
    this.sync();
  }

  private changeForUri(uri: vscode.Uri): FileChange | undefined {
    const review = this.store.get(this.root);
    if (!review) return undefined;
    const relPath = path.relative(this.root, uri.fsPath).split(path.sep).join("/");
    return review.changes.get(relPath);
  }

  private sync(): void {
    const review = this.store.get(this.root);
    const changes = review
      ? [...review.changes.values()].sort((a, b) => a.relPath.localeCompare(b.relPath))
      : [];
    this.group.resourceStates = changes.map((change) => ({
      resourceUri: vscode.Uri.file(change.path),
      command: {
        command: "opencodeDiff.openChange",
        title: "Open Diff",
        arguments: [this.root, change.relPath],
      },
      contextValue: "opencodeDiff.reviewFile",
      decorations: {
        tooltip: `Modified by opencode (+${change.additions} −${change.deletions})`,
        light: { iconPath: new vscode.ThemeIcon("file-code") },
        dark: { iconPath: new vscode.ThemeIcon("file-code") },
      },
    }));
    this.scm.count = changes.length;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
