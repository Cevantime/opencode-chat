import * as vscode from "vscode";
import { startOpencodeServer, resolveOpencodeBinary } from "./opencode.js";
import type { ServerHandle } from "./opencode.js";
import { runOpencode } from "./runner.js";
import {
  ReviewStore,
  ReviewTreeProvider,
  ReviewEditorProvider,
  acceptAll,
  rejectAll,
  acceptChange,
  rejectChange,
} from "./review.js";

interface ExtConfig {
  opencodePath: string;
  model: string;
  agent: string;
  autoOpenReview: boolean;
  allowBash: boolean;
  webfetchPermission: "allow" | "deny";
  snapshotSizeLimitBytes: number;
}

function getConfig(): ExtConfig {
  const cfg = vscode.workspace.getConfiguration("opencodeDiff");
  return {
    opencodePath: cfg.get<string>("opencodePath", "opencode"),
    model: cfg.get<string>("model", ""),
    agent: cfg.get<string>("agent", ""),
    autoOpenReview: cfg.get<boolean>("autoOpenReview", true),
    allowBash: cfg.get<boolean>("allowBash", false),
    webfetchPermission: cfg.get<"allow" | "deny">("webfetchPermission", "allow"),
    snapshotSizeLimitBytes: cfg.get<number>("snapshotSizeLimitMb", 10) * 1024 * 1024,
  };
}

function parseModel(value: string): { providerID: string; modelID: string } | undefined {
  const idx = value.indexOf("/");
  if (idx <= 0) return undefined;
  return { providerID: value.slice(0, idx), modelID: value.slice(idx + 1) };
}

class ServerManager {
  private handles = new Map<string, ServerHandle>();
  private binary: string | undefined;

  async get(root: string): Promise<ServerHandle> {
    const existing = this.handles.get(root);
    if (existing) return existing;
    const cfg = getConfig();
    this.binary ??= await resolveOpencodeBinary(cfg.opencodePath);
    const handle = await startOpencodeServer({
      binary: this.binary,
      cwd: root,
      allowBash: cfg.allowBash,
      webfetchPermission: cfg.webfetchPermission,
    });
    this.handles.set(root, handle);
    return handle;
  }

  close(root: string): void {
    const handle = this.handles.get(root);
    if (handle) {
      handle.close();
      this.handles.delete(root);
    }
  }

  dispose(): void {
    for (const handle of this.handles.values()) handle.close();
    this.handles.clear();
  }
}

interface ChatEventState {
  textSeen: Map<string, number>;
}

function chatEventHandler(
  stream: vscode.ChatResponseStream,
  state: ChatEventState,
): (event: unknown) => void {
  return (raw) => {
    const wrapped = raw as { payload?: unknown } | null | undefined;
    const event = wrapped && typeof wrapped === "object" && "payload" in wrapped ? wrapped.payload : raw;
    const ev = event as { type?: string; properties?: Record<string, unknown> } | null | undefined;
    const type = ev?.type ?? "";
    const props = ev?.properties ?? {};
    if (type === "message.part.updated") {
      const part = props.part as { id: string; type?: string; text?: string; tool?: string; state?: { status?: string } } | undefined;
      if (!part) return;
      if (part.type === "text" && part.text) {
        const seen = state.textSeen.get(part.id) ?? 0;
        if (part.text.length > seen) {
          stream.markdown(part.text.slice(seen));
          state.textSeen.set(part.id, part.text.length);
        }
      } else if (part.type === "tool" && part.tool) {
        const status = part.state?.status ?? "";
        const label = `${part.tool}${status === "completed" ? " (terminé)" : status === "error" ? " (erreur)" : status === "running" ? "…" : ""}`;
        stream.progress(label);
      }
    }
  };
}

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("OpenCode Diff");
  log.appendLine("[activate] extension activée");
  const store = new ReviewStore();
  store.log = (line) => log.appendLine(`[store] ${line}`);
  const serverManager = new ServerManager();
  let currentRun: AbortController | undefined;

  const updateContext = () => {
    void vscode.commands.executeCommand("setContext", "opencodeDiff.hasReview", store.hasAny());
  };

  const reviewTree = new ReviewTreeProvider(store);
  reviewTree.log = (line) => log.appendLine(`[tree] ${line}`);
  const editorProvider = new ReviewEditorProvider(store);
  editorProvider.log = (line) => log.appendLine(`[editor] ${line}`);
  const treeView = vscode.window.createTreeView("opencodeDiff.review", {
    treeDataProvider: reviewTree,
    showCollapseAll: false,
  });
  context.subscriptions.push(
    treeView,
    store.onDidChangeEvent(() => {
      updateContext();
      reviewTree.refresh();
      editorProvider.refresh();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("opencodeDiff.openChange", (root: string, relPath: string) => {
      editorProvider.open(root, relPath);
    }),
    vscode.commands.registerCommand("opencodeDiff.acceptChange", async (root: string, relPath: string) => {
      const change = store.get(root)?.changes.get(relPath);
      if (change) {
        await acceptChange(store, root, change);
        updateContext();
      }
    }),
    vscode.commands.registerCommand("opencodeDiff.rejectChange", async (root: string, relPath: string) => {
      const change = store.get(root)?.changes.get(relPath);
      if (change) {
        await rejectChange(store, root, change);
        updateContext();
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("opencodeDiff.acceptAll", async () => {
      const review = store.getActive();
      if (!review) return;
      const count = await acceptAll(store, review.root);
      updateContext();
      vscode.window.showInformationMessage(`OpenCode Diff : ${count} modification(s) appliquée(s).`);
    }),
    vscode.commands.registerCommand("opencodeDiff.rejectAll", async () => {
      const review = store.getActive();
      if (!review) return;
      const count = await rejectAll(store, review.root);
      updateContext();
      vscode.window.showInformationMessage(`OpenCode Diff : ${count} modification(s) rejetée(s).`);
    }),
    vscode.commands.registerCommand("opencodeDiff.clearReview", async () => {
      const review = store.getActive();
      if (review) {
        const count = await rejectAll(store, review.root);
        log.appendLine(`[command] opencodeDiff.clearReview → ${count} modification(s) rejetée(s)`);
        updateContext();
        if (count > 0) vscode.window.showInformationMessage(`OpenCode Diff : ${count} modification(s) annulée(s).`);
      }
    }),
    vscode.commands.registerCommand("opencodeDiff.focusReview", () => {
      log.appendLine("[command] opencodeDiff.focusReview");
      void vscode.commands.executeCommand("workbench.view.extension.opencodeDiff");
      void vscode.commands.executeCommand("opencodeDiff.review.focus");
      reviewTree.refresh();
    }),
    vscode.commands.registerCommand("opencodeDiff.abort", () => {
      currentRun?.abort();
    }),
  );

  const participant = vscode.chat.createChatParticipant(
    "opencodeDiff.chat",
    async (request, _context, stream, token) => {
      const workspace = vscode.workspace.workspaceFolders?.[0];
      if (!workspace) {
        stream.markdown("Ouvrez d'abord un dossier (workspace) dans VS Code.");
        return { metadata: {} };
      }
      if (!request.prompt.trim()) {
        stream.markdown("Décrivez la tâche à confier à opencode, par exemple : « ajoute un formulaire de connexion ».");
        return { metadata: {} };
      }
      if (currentRun) {
        stream.markdown("Une exécution opencode est déjà en cours dans ce workspace. Annulez-la d'abord.");
        return { metadata: {} };
      }

      const cfg = getConfig();
      const root = workspace.uri.fsPath;
      log.appendLine(`[run] workspace=${root}`);
      log.appendLine(`[run] config=${JSON.stringify(cfg)}`);
      log.appendLine(`[run] prompt=${request.prompt.slice(0, 120)}`);
      const controller = new AbortController();
      currentRun = controller;
      token.onCancellationRequested(() => controller.abort());
      const status = vscode.window.setStatusBarMessage("OpenCode : exécution en cours…");

      await vscode.workspace.saveAll(false);
      stream.markdown("**OpenCode** — j'exécute votre demande ; les modifications seront proposées en diff pour validation.\n");

      try {
        const server = await serverManager.get(root);
        log.appendLine("[run] serveur opencode démarré");
        const result = await runOpencode(
          server.client,
          {
            workspaceRoot: root,
            prompt: request.prompt,
            model: cfg.model ? parseModel(cfg.model) : undefined,
            agent: cfg.agent || undefined,
            snapshotSizeLimitBytes: cfg.snapshotSizeLimitBytes,
            allowBash: cfg.allowBash,
            webfetchPermission: cfg.webfetchPermission,
            signal: controller.signal,
          },
          {
            onProgress: (label) => {
              log.appendLine(`[progress] ${label}`);
              stream.progress(label);
            },
            onEvent: chatEventHandler(stream, { textSeen: new Map() }),
          },
        );
        log.appendLine(`[run] terminé : ${result.changes.length} changement(s), ${result.unrestorable.length} non restauré(s), reply=${result.reply.length} chars`);

        if (controller.signal.aborted) {
          stream.markdown("\n\nDemande annulée. Le workspace a été restauré dans son état initial.");
          return { metadata: { aborted: true } };
        }

        if (result.changes.length > 0) {
          store.set({
            root,
            sessionID: result.sessionID,
            messageID: result.messageID,
            reply: result.reply,
            changes: new Map(result.changes.map((c) => [c.relPath, c])),
            createdAt: Date.now(),
          });
          log.appendLine(`[review] ${result.changes.length} changement(s) stockés pour ${root}`);
          log.appendLine(`[review] fichiers : ${result.changes.map((c) => c.relPath).join(", ")}`);
          updateContext();

          const lines = result.changes.map(
            (c) => `- \`${c.relPath}\` ${c.kind === "added" ? "(nouveau)" : c.kind === "deleted" ? "(supprimé)" : ""} +${c.additions} −${c.deletions}`,
          );
          stream.markdown(
            [
              `\n\n**${result.changes.length} fichier(s) modifié(s)** (sur le disque — à accepter ou rejeter) :`,
              ...lines,
            ].join("\n"),
          );
          if (result.unrestorable.length > 0) {
            stream.markdown(
              `\n\n⚠️ Fichiers modifiés mais **non restaurés** (trop volumineux ou ignorés) : ${result.unrestorable.join(", ")}.`,
            );
          }
          stream.button({ command: "opencodeDiff.focusReview", title: "Ouvrir la revue des modifications" });
          if (cfg.autoOpenReview) {
            const first = result.changes[0];
            log.appendLine(`[run] autoOpenReview → ouverture au centre de ${first.relPath}`);
            editorProvider.open(root, first.relPath);
          }
        } else {
          log.appendLine("[run] aucune modification détectée");
          const reply = (result.reply || "").trim();
          stream.markdown(
            reply ? `\n\nOpencode n'a apporté **aucune modification**.\n\n> ${reply.replace(/\n/g, "\n> ")}` : "\n\nOpencode n'a apporté aucune modification.",
          );
        }
        return { metadata: { changes: result.changes.length } };
      } catch (err) {
        const aborted = controller.signal.aborted;
        log.appendLine(`[run] ERREUR${aborted ? " (annulé)" : ""} : ${err instanceof Error ? err.message : String(err)}`);
        if (err instanceof Error && err.stack) log.appendLine(err.stack);
        stream.markdown(aborted ? "\n\nDemande annulée." : `\n\n**Erreur** : ${err instanceof Error ? err.message : String(err)}`);
        return { metadata: { error: true } };
      } finally {
        currentRun = undefined;
        status.dispose();
      }
    },
  );
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.svg");

  const workspaceFoldersHandler = vscode.workspace.onDidChangeWorkspaceFolders((event) => {
    for (const removed of event.removed) {
      store.clear(removed.uri.fsPath);
      serverManager.close(removed.uri.fsPath);
    }
    updateContext();
  });

  context.subscriptions.push(participant, workspaceFoldersHandler, serverManager);
  updateContext();
}

export function deactivate(): void {
  // serverManager is disposed via context.subscriptions
}
