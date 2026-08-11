import * as vscode from "vscode";
import path from "node:path";
import type { FileChange } from "./types.js";
import { revertFileChange } from "./snapshot.js";

/** Custom scheme serving the original (before) content of a change. */
export const ORIGINAL_SCHEME = "opencode-review-original";

export interface Review {
  root: string;
  sessionID: string;
  messageID: string;
  reply: string;
  changes: Map<string, FileChange>;
  createdAt: number;
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

  get(root: string): Review | undefined {
    return this.reviews.get(root);
  }

  getActive(): Review | undefined {
    return this.reviews.values().next().value;
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
  log: (line: string) => void = () => {};

  constructor(private store: ReviewStore) {
    const update = () => void this.updateActiveContext();
    this.disposables.push(
      vscode.window.tabGroups.onDidChangeTabs(update),
      vscode.window.tabGroups.onDidChangeTabGroups(update),
      vscode.window.onDidChangeActiveTextEditor(update),
    );
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
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
}
