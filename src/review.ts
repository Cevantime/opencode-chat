import * as vscode from "vscode";
import path from "node:path";
import { promises as fs } from "node:fs";
import type { FileChange, Hunk } from "./types.js";
import {
  revertFileChange,
  applyHunkReject,
  diffStat,
  computeHunks,
  diffLinesFromHunks,
  type DiffLine,
} from "./snapshot.js";

export const REVIEW_EDITOR_VIEW_TYPE = "opencodeDiff.reviewEditor";

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
 * custom diff editors and the accept/reject commands share the same state.
 */
export class ReviewStore {
  private reviews = new Map<string, Review>();
  private onDidChange = new vscode.EventEmitter<void>();
  log: (line: string) => void = () => {};

  readonly onDidChangeEvent = this.onDidChange.event;

  emitLog(line: string): void {
    this.log(line);
  }

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

  /** Fire the change event after an in-place mutation of a change model. */
  touch(): void {
    this.onDidChange.fire();
  }

  hasAny(): boolean {
    return [...this.reviews.values()].some((r) => r.changes.size > 0);
  }
}

/** Hunks still awaiting review (not already accepted). */
export function pendingHunks(change: FileChange): Hunk[] {
  return change.hunks.filter(
    (h) => !change.acceptedRanges.some((r) => r.oldStart === h.oldStart && r.oldLines === h.oldLines),
  );
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
 * Accept a single segment: the modification is kept on disk, its before-region
 * is recorded so it disappears from the review. Returns true when the file has
 * no pending segment left and should be dropped from the review.
 */
export async function acceptChangeSection(
  store: ReviewStore,
  root: string,
  change: FileChange,
  hunk: Hunk,
): Promise<boolean> {
  change.acceptedRanges.push({ oldStart: hunk.oldStart, oldLines: hunk.oldLines });
  store.touch();
  return pendingHunks(change).length === 0;
}

/**
 * Reject a single segment: rewrite the file on disk without that segment and
 * recompute the change model. Returns true when the file became identical to
 * its original content and should be dropped from the review.
 */
export async function rejectChangeSection(
  store: ReviewStore,
  root: string,
  change: FileChange,
  hunk: Hunk,
): Promise<boolean> {
  const newAfter = applyHunkReject(change.before, change.after, hunk);
  if (newAfter.equals(change.before)) {
    await revertFileChange(change);
    store.touch();
    return true;
  }
  change.after = newAfter;
  if (change.kind === "deleted" && newAfter.length > 0) change.kind = "modified";
  const stats = diffStat(change.before, change.after);
  change.additions = stats.additions;
  change.deletions = stats.deletions;
  change.hunks = computeHunks(change.before, change.after);
  await fs.mkdir(path.dirname(change.path), { recursive: true });
  await fs.writeFile(change.path, newAfter);
  store.touch();
  return pendingHunks(change).length === 0;
}

export interface SerializedFile {
  relPath: string;
  kind: string;
  additions: number;
  deletions: number;
  /** Still-pending hunks; a line's hunkIndex refers to this array. */
  hunks: Hunk[];
  lines: DiffLine[];
}

/** Build the JSON payload describing a change for a diff webview. */
export function serializeChange(change: FileChange): SerializedFile {
  const hunks = pendingHunks(change);
  return {
    relPath: change.relPath,
    kind: change.kind,
    additions: change.additions,
    deletions: change.deletions,
    hunks,
    lines: diffLinesFromHunks(change.before, change.after, hunks),
  };
}

/** Build the JSON payload for the review list webview. */
export function serializeReview(review: Review): { files: SerializedFile[] } {
  const files = [...review.changes.values()]
    .sort((a, b) => a.relPath.localeCompare(b.relPath))
    .map(serializeChange);
  return { files };
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
    const kind = change.kind === "added" ? "nouveau" : change.kind === "deleted" ? "supprimé" : "";
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
 * The center diff shown in the editor area: one tab per file, rendered like the
 * VS Code diff editor (unified): line numbers, additions in green, deletions in
 * red, hunk headers with per-segment accept/reject buttons on hover.
 * Implemented with plain WebviewPanels so it opens reliably in the active
 * editor group without extra contributions.
 */
export class ReviewEditorProvider {
  private panels = new Map<string, vscode.WebviewPanel>();
  log: (line: string) => void = () => {};

  constructor(private store: ReviewStore) {}

  private key(root: string, relPath: string): string {
    return `${root}\u0000${relPath}`;
  }

  /** Open (or reveal if already open) the diff of one change in the center. */
  open(root: string, relPath: string): void {
    const change = this.store.get(root)?.changes.get(relPath);
    if (!change) return;
    const k = this.key(root, relPath);
    const existing = this.panels.get(k);
    if (existing) {
      existing.reveal(vscode.ViewColumn.Active);
      this.render(existing, change);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      REVIEW_EDITOR_VIEW_TYPE,
      path.basename(relPath),
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panels.set(k, panel);
    panel.webview.html = this.html();
    panel.onDidDispose(() => this.panels.delete(k));
    panel.onDidChangeViewState(() => {
      const latest = this.store.get(root)?.changes.get(relPath);
      if (latest && panel.active) this.render(panel, latest);
    });
    panel.webview.onDidReceiveMessage((msg) => {
      void this.handle(panel, root, relPath, msg as Record<string, unknown>);
    });
    this.log(`[editor] ouvert ${relPath}`);
    this.render(panel, change);
  }

  refresh(): void {
    for (const [k, panel] of [...this.panels]) {
      const sep = k.indexOf("\u0000");
      const root = k.slice(0, sep);
      const relPath = k.slice(sep + 1);
      const change = this.store.get(root)?.changes.get(relPath);
      if (!change) {
        panel.dispose();
        continue;
      }
      this.render(panel, change);
    }
  }

  private render(panel: vscode.WebviewPanel, change: FileChange): void {
    this.log(`[editor] render ${change.relPath} (${pendingHunks(change).length} segment(s))`);
    try {
      void panel.webview.postMessage({ type: "state", file: serializeChange(change) });
    } catch (err) {
      this.log(`[editor] postMessage a échoué : ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handle(
    panel: vscode.WebviewPanel,
    root: string,
    relPath: string,
    msg: Record<string, unknown>,
  ): Promise<void> {
    const review = this.store.get(root);
    const change = review?.changes.get(relPath);
    if (!change) return;
    this.log(`[editor] message reçu : ${String(msg.type)} (${relPath})`);
    switch (msg.type) {
      case "ready":
        this.render(panel, change);
        break;
      case "acceptSection": {
        const hunk = pendingHunks(change)[Number(msg.index)];
        if (hunk) {
          const done = await acceptChangeSection(this.store, root, change, hunk);
          if (done) {
            this.store.removeChange(root, relPath);
            void vscode.window.showInformationMessage(`OpenCode Diff : modification conservée — ${relPath}`);
          }
        }
        break;
      }
      case "rejectSection": {
        const hunk = pendingHunks(change)[Number(msg.index)];
        if (hunk) {
          const done = await rejectChangeSection(this.store, root, change, hunk);
          if (done) {
            this.store.removeChange(root, relPath);
            void vscode.window.showInformationMessage(`OpenCode Diff : modification rejetée — ${relPath}`);
          }
        }
        break;
      }
      case "acceptFile": {
        await acceptChange(this.store, root, change);
        void vscode.window.showInformationMessage(`OpenCode Diff : modification conservée — ${relPath}`);
        break;
      }
      case "rejectFile": {
        await rejectChange(this.store, root, change);
        void vscode.window.showInformationMessage(`OpenCode Diff : modification rejetée — ${relPath}`);
        break;
      }
    }
  }

  private html(): string {
    const nonce = "n" + Math.random().toString(36).slice(2);
    return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body{margin:0;padding:0;font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background);}
.empty{padding:24px;color:var(--vscode-descriptionForeground);}
.head{display:flex;align-items:center;gap:10px;padding:8px 16px;border-bottom:1px solid var(--vscode-diffEditor-border,#444);background:var(--vscode-editorWidget-background);}
.path{font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--vscode-editor-font-family);}
.stats{font-size:12px;white-space:nowrap;}
.add{color:var(--vscode-gitDecoration-addedResourceForeground);}
.del{color:var(--vscode-gitDecoration-deletedResourceForeground);margin-left:8px;}
.toolbar{display:flex;gap:6px;padding:8px 16px;border-bottom:1px solid var(--vscode-diffEditor-border,#444);background:var(--vscode-editorWidget-background);}
.btn{border:none;border-radius:3px;padding:3px 12px;cursor:pointer;background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-size:12px;}
.btn:hover{background:var(--vscode-button-hoverBackground);}
.btn.danger{background:transparent;color:var(--vscode-foreground);border:1px solid var(--vscode-widget-border,#555);}
.btn.danger:hover{background:var(--vscode-button-hoverBackground);color:var(--vscode-button-foreground);}
.diff{font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size);line-height:1.55;padding-bottom:24px;}
.ln{display:flex;align-items:center;min-height:1.55em;}
.ln-no{flex:0 0 auto;min-width:3.2em;padding:0 12px 0 4px;text-align:right;font-size:0.92em;color:var(--vscode-editorLineNumber-foreground);user-select:none;background:var(--vscode-editorGutter-background);}
.ln pre{margin:0;padding:0;flex:1;font-family:inherit;white-space:pre-wrap;word-break:break-word;}
.ln.ctx{background:var(--vscode-editor-background);}
.ln.add{background:var(--vscode-diffEditor-insertedLineBackground,#0f2a1c);}
.ln.add .ln-no{color:var(--vscode-diffEditor-insertedLineForeground,var(--vscode-gitDecoration-addedResourceForeground));}
.ln.del{background:var(--vscode-diffEditor-removedLineBackground,#3a1217);}
.ln.del .ln-no{color:var(--vscode-diffEditor-removedLineForeground,var(--vscode-gitDecoration-deletedResourceForeground));}
.hunk{border-top:1px solid var(--vscode-diffEditor-border,#444);}
.hunk-head{display:flex;align-items:center;gap:8px;padding:3px 10px;background:var(--vscode-editorWidget-background);border-bottom:1px solid var(--vscode-diffEditor-border,#444);font-size:12px;}
.range{font-family:var(--vscode-editor-font-family);color:var(--vscode-descriptionForeground);flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.hunk-actions{display:flex;gap:4px;opacity:0;transition:opacity .15s ease;}
.hunk:hover .hunk-actions,.hunk-head:focus-within .hunk-actions{opacity:1;}
.mini{border:none;border-radius:3px;padding:2px 10px;cursor:pointer;font-size:12px;line-height:1.7;}
.mini.ok{background:var(--vscode-button-background);color:var(--vscode-button-foreground);}
.mini.ok:hover{background:var(--vscode-button-hoverBackground);}
.mini.danger{background:transparent;color:var(--vscode-foreground);border:1px solid var(--vscode-widget-border,#555);}
.mini.danger:hover{background:var(--vscode-button-hoverBackground);color:var(--vscode-button-foreground);}
</style>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}">
(function(){
  var vscode=acquireVsCodeApi();
  var state=null;
  function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
  function rangeLabel(h){
    var o=(h.oldLines>0?'-'+h.oldStart+','+h.oldLines:'-'+h.oldStart+',0');
    var n=(h.newLines>0?'+'+h.newStart+','+h.newLines:'+'+h.newStart+',0');
    return '@@ '+o+' '+n+' @@';
  }
  function lineRow(l){
    var oldNo=l.oldLine>0?l.oldLine:'';
    var newNo=l.newLine>0?l.newLine:'';
    return '<div class="ln '+l.kind+'"><span class="ln-no">'+oldNo+'</span><span class="ln-no">'+newNo+'</span><pre>'+esc(l.text)+'</pre></div>';
  }
  function render(){
    var app=document.getElementById('app');
    if(!state){app.innerHTML='<div class="empty">Ouvrez un fichier depuis la revue pour voir ses modifications.</div>';return;}
    var html='<div class="head"><span class="path">'+esc(state.relPath)+'</span><span class="stats"><span class="add">+'+state.additions+'</span><span class="del">-'+state.deletions+'</span></span></div>';
    html+='<div class="toolbar"><button class="btn" data-act="acceptFile" title="Conserver toutes les modifications de ce fichier">&#10003; Accepter le fichier</button><button class="btn danger" data-act="rejectFile" title="Annuler toutes les modifications de ce fichier">&#8617; Rejeter le fichier</button></div>';
    html+='<div class="diff">';
    if(state.lines.length===0){html+='<div class="empty">Ce fichier ne contient plus de modification en attente.</div>';}
    for(var i=0;i<state.lines.length;i++){
      var ln=state.lines[i];
      if(ln.hunkIndex<0){
        html+=lineRow(ln);
      }else{
        var hunk=ln.hunkIndex;
        html+='<div class="hunk"><div class="hunk-head"><span class="range">'+esc(rangeLabel(state.hunks[hunk]))+'</span><span class="hunk-actions"><button class="mini ok" data-act="acceptSection" data-h="'+hunk+'" title="Conserver ce segment">&#10003;</button><button class="mini danger" data-act="rejectSection" data-h="'+hunk+'" title="Annuler ce segment">&#8617;</button></span></div>';
        while(i<state.lines.length&&state.lines[i].hunkIndex===hunk){
          html+=lineRow(state.lines[i]);
          i++;
        }
        html+='</div>';
        i--;
      }
    }
    html+='</div>';
    app.innerHTML=html;
  }
  window.addEventListener('message',function(e){
    if(e.data.type==='state'){state=e.data.file;render();}
  });
  document.body.addEventListener('click',function(e){
    var btn=e.target.closest('button[data-act]');
    if(!btn)return;
    var act=btn.dataset.act;
    if(act==='acceptFile'){vscode.postMessage({type:'acceptFile'});return;}
    if(act==='rejectFile'){vscode.postMessage({type:'rejectFile'});return;}
    if(act==='acceptSection'){vscode.postMessage({type:'acceptSection',index:Number(btn.dataset.h)});}
    else if(act==='rejectSection'){vscode.postMessage({type:'rejectSection',index:Number(btn.dataset.h)});}
  });
  render();
  vscode.postMessage({type:'ready'});
})();
</script>
</body>
</html>`;
  }
}
