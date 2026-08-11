import * as vscode from "vscode";
import { startOpencodeServer, resolveOpencodeBinary } from "./opencode.js";
import type { ServerHandle } from "./opencode.js";
import { runOpencode } from "./runner.js";
import { OpencodeModelProvider, OPENCODE_VENDOR } from "./models.js";
import {
  ReviewStore,
  ReviewTreeProvider,
  ReviewEditorProvider,
  OriginalDocumentProvider,
  ORIGINAL_SCHEME,
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

  async resolveBinary(): Promise<string> {
    if (!this.binary) {
      this.binary = await resolveOpencodeBinary(getConfig().opencodePath);
    }
    return this.binary;
  }

  async get(root: string): Promise<ServerHandle> {
    const existing = this.handles.get(root);
    if (existing) return existing;
    const cfg = getConfig();
    const binary = await this.resolveBinary();
    const handle = await startOpencodeServer({
      binary,
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
  /** messageID → role ("user" | "assistant" | …) gathered from message.updated events. */
  roles: Map<string, string>;
  /** text part id → number of characters already streamed. */
  textSeen: Map<string, number>;
  /** reasoning part id → number of characters already shown as progress. */
  reasoningSeen: Map<string, number>;
  /** tool call ids already reported (as a persistent step line). */
  toolDone: Set<string>;
}

/** Human-friendly label for a tool call, e.g. `edit src/math.js` or `bash npm test`. */
function toolLabel(part: {
  tool?: string;
  state?: Record<string, unknown>;
}): string {
  const tool = part.tool ?? "";
  const input = (part.state?.input ?? {}) as Record<string, unknown>;
  switch (tool) {
    case "edit":
    case "write":
    case "read": {
      const file = input.filepath ?? input.filePath ?? input.path;
      return file ? `${tool} \`${String(file)}\`` : tool;
    }
    case "bash": {
      const cmd = String(input.command ?? "").replace(/\s+/g, " ").trim();
      return cmd ? `bash \`${cmd.length > 80 ? cmd.slice(0, 80) + "…" : cmd}\`` : "bash";
    }
    case "webfetch":
      return input.url ? `webfetch \`${String(input.url)}\`` : "webfetch";
    case "list":
      return "list";
    default:
      return (part.state?.title as string | undefined) || tool || "tool";
  }
}

/**
 * Forward opencode's event stream into the chat response: assistant text is
 * streamed verbatim, reasoning drives the status line, and tool calls become a
 * persistent step list (like the opencode TUI / Copilot).
 * The echoed user prompt is filtered out via the message role.
 */
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

    if (type === "message.updated") {
      const info = props.info as { id?: string; role?: string } | undefined;
      if (info?.id && info.role) state.roles.set(info.id, info.role);
      return;
    }
    if (type !== "message.part.updated") return;

    const part = props.part as
      | {
          id?: string;
          messageID?: string;
          type?: string;
          text?: string;
          tool?: string;
          state?: { status?: string; error?: string };
        }
      | undefined;
    if (!part) return;

    // Only surface the assistant's own output, never the echoed user prompt.
    const role = part.messageID ? state.roles.get(part.messageID) : undefined;
    if (role && role !== "assistant") return;

    if (part.type === "text" && part.text) {
      const seen = state.textSeen.get(part.id ?? "") ?? 0;
      if (part.text.length > seen) {
        stream.markdown(part.text.slice(seen));
        state.textSeen.set(part.id ?? "", part.text.length);
      }
    } else if (part.type === "reasoning" && part.text) {
      const seen = state.reasoningSeen.get(part.id ?? "") ?? 0;
      if (part.text.length > seen) {
        const delta = part.text.slice(seen).replace(/\s+/g, " ").trim();
        state.reasoningSeen.set(part.id ?? "", part.text.length);
        if (delta) stream.progress(`Thinking… ${delta.slice(0, 90)}`);
      }
    } else if (part.type === "tool" && part.tool) {
      const label = toolLabel(part);
      const status = part.state?.status ?? "";
      const id = part.id ?? "";
      if (status === "running") {
        stream.progress(`${label}…`);
      } else if (status === "completed" && !state.toolDone.has(id)) {
        state.toolDone.add(id);
        stream.markdown(`- ${label}`);
      } else if (status === "error" && !state.toolDone.has(id)) {
        state.toolDone.add(id);
        stream.markdown(`- ${label} (error${part.state?.error ? `: ${String(part.state.error)}` : ""})`);
      }
    }
  };
}

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("OpenCode Diff");
  log.appendLine("[activate] extension activated");
  const store = new ReviewStore();
  const serverManager = new ServerManager();
  const modelProvider = new OpencodeModelProvider({
    resolveBinary: () => serverManager.resolveBinary(),
    getServer: (root) => serverManager.get(root),
  });
  let currentRun: AbortController | undefined;

  const updateContext = () => {
    void vscode.commands.executeCommand("setContext", "opencodeDiff.hasReview", store.hasAny());
  };

  const reviewTree = new ReviewTreeProvider(store);
  reviewTree.log = (line) => log.appendLine(`[tree] ${line}`);
  const editorProvider = new ReviewEditorProvider(store);
  editorProvider.log = (line) => log.appendLine(`[editor] ${line}`);
  const originalProvider = new OriginalDocumentProvider((root, relPath) => store.get(root)?.changes.get(relPath)?.before);
  const treeView = vscode.window.createTreeView("opencodeDiff.review", {
    treeDataProvider: reviewTree,
    showCollapseAll: false,
  });
  context.subscriptions.push(
    treeView,
    editorProvider,
    vscode.workspace.registerTextDocumentContentProvider(ORIGINAL_SCHEME, originalProvider),
    vscode.lm.registerLanguageModelChatProvider(OPENCODE_VENDOR, modelProvider),
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
    vscode.commands.registerCommand("opencodeDiff.acceptActiveDiff", () => {
      void editorProvider.acceptActive();
    }),
    vscode.commands.registerCommand("opencodeDiff.rejectActiveDiff", () => {
      void editorProvider.rejectActive();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("opencodeDiff.acceptAll", async () => {
      const review = store.getActive();
      if (!review) return;
      const count = await acceptAll(store, review.root);
      updateContext();
      vscode.window.showInformationMessage(`OpenCode Diff: ${count} change(s) applied.`);
    }),
    vscode.commands.registerCommand("opencodeDiff.rejectAll", async () => {
      const review = store.getActive();
      if (!review) return;
      const count = await rejectAll(store, review.root);
      updateContext();
      vscode.window.showInformationMessage(`OpenCode Diff: ${count} change(s) rejected.`);
    }),
    vscode.commands.registerCommand("opencodeDiff.clearReview", async () => {
      const review = store.getActive();
      if (review) {
        const count = await rejectAll(store, review.root);
        log.appendLine(`[command] opencodeDiff.clearReview → ${count} change(s) rejected`);
        updateContext();
        if (count > 0) vscode.window.showInformationMessage(`OpenCode Diff: ${count} change(s) discarded.`);
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
    vscode.commands.registerCommand("opencodeDiff.refreshModels", async () => {
      await modelProvider.refresh();
      log.appendLine("[command] opencodeDiff.refreshModels → models refreshed");
      vscode.window.showInformationMessage("OpenCode Diff: model list refreshed.");
    }),
  );

  const participant = vscode.chat.createChatParticipant(
    "opencodeDiff.chat",
    async (request, _context, stream, token) => {
      const workspace = vscode.workspace.workspaceFolders?.[0];
      if (!workspace) {
        stream.markdown("Open a folder (workspace) in VS Code first.");
        return { metadata: {} };
      }
      if (!request.prompt.trim()) {
        stream.markdown("Describe the task for opencode, e.g. “add a login form”.");
        return { metadata: {} };
      }
      if (currentRun) {
        stream.markdown("An opencode run is already in progress in this workspace. Cancel it first.");
        return { metadata: {} };
      }

      const cfg = getConfig();
      const root = workspace.uri.fsPath;
      log.appendLine(`[run] workspace=${root}`);
      log.appendLine(`[run] config=${JSON.stringify(cfg)}`);
      log.appendLine(`[run] prompt=${request.prompt.slice(0, 120)}`);
      const requestModel = request.model;
      log.appendLine(`[run] request.model=${requestModel ? `${requestModel.id} (vendor=${requestModel.vendor}, name=${requestModel.name})` : "none"}`);
      let model: { providerID: string; modelID: string } | undefined;
      let modelSource: "opencode" | "mapped" | "config" | "none" = "none";
      if (requestModel && requestModel.vendor === OPENCODE_VENDOR) {
        model = parseModel(requestModel.id) ?? { providerID: OPENCODE_VENDOR, modelID: requestModel.id };
        modelSource = "opencode";
      } else if (requestModel) {
        model = await modelProvider.resolveOpenCodeModel(requestModel.id);
        if (model) modelSource = "mapped";
      }
      if (!model && cfg.model) {
        model = parseModel(cfg.model);
        modelSource = "config";
      }
      const modelLabel = model ? `${model.providerID}/${model.modelID}` : "default";
      log.appendLine(`[run] model=${modelLabel} (source=${modelSource})`);
      if (requestModel && modelSource === "opencode") {
        stream.markdown(`> **Model:** ${modelLabel}\n\n`);
      } else if (requestModel && modelSource === "mapped") {
        stream.markdown(`> **Model:** ${modelLabel} (picked “${requestModel.name ?? requestModel.id}”)\n\n`);
      } else if (requestModel && modelSource === "none") {
        stream.markdown(
          `> **Model:** “${requestModel.name ?? requestModel.id}” (${requestModel.vendor}) is not available in opencode — running with **${modelLabel}**. Pick an opencode model in the picker (top of the chat).\n\n`,
        );
      } else if (modelSource === "config") {
        stream.markdown(`> **Model:** ${modelLabel} (from opencodeDiff.model)\n\n`);
      } else {
        stream.markdown(
          `> Running with opencode's **default** model. Pick an opencode model in the picker (top of the chat) to change it.\n\n`,
        );
      }
      const controller = new AbortController();
      currentRun = controller;
      token.onCancellationRequested(() => controller.abort());
      const status = vscode.window.setStatusBarMessage("OpenCode: running…");

      await vscode.workspace.saveAll(false);

      try {
        const server = await serverManager.get(root);
        log.appendLine("[run] opencode server started");
        const result = await runOpencode(
          server.client,
          {
            workspaceRoot: root,
            prompt: request.prompt,
            model,
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
            onEvent: chatEventHandler(stream, {
              roles: new Map(),
              textSeen: new Map(),
              reasoningSeen: new Map(),
              toolDone: new Set(),
            }),
          },
        );
        log.appendLine(
          `[run] done: ${result.changes.length} change(s), ${result.unrestorable.length} unrestorable, reply=${result.reply.length} chars`,
        );

        if (controller.signal.aborted) {
          stream.markdown("\n\nRequest cancelled. The workspace has been restored to its original state.");
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
          log.appendLine(`[review] ${result.changes.length} change(s) stored for ${root}`);
          log.appendLine(`[review] files: ${result.changes.map((c) => c.relPath).join(", ")}`);
          updateContext();

          const lines = result.changes.map(
            (c) => `- \`${c.relPath}\` ${c.kind === "added" ? "(new)" : c.kind === "deleted" ? "(deleted)" : ""} +${c.additions} −${c.deletions}`,
          );
          stream.markdown(
            [
              `\n\n**${result.changes.length} file(s) changed** (on disk — accept or reject below):`,
              ...lines,
            ].join("\n"),
          );
          if (result.unrestorable.length > 0) {
            stream.markdown(
              `\n\n⚠️ Files changed but **not restorable** (too large or ignored): ${result.unrestorable.join(", ")}.`,
            );
          }
          stream.button({ command: "opencodeDiff.focusReview", title: "Review changes" });
          if (cfg.autoOpenReview) {
            const first = result.changes[0];
            log.appendLine(`[run] autoOpenReview → opening ${first.relPath} in the diff editor`);
            await editorProvider.open(root, first.relPath);
          }
        } else {
          log.appendLine("[run] no changes detected");
          const reply = (result.reply || "").trim();
          stream.markdown(
            reply
              ? `\n\nOpencode made **no changes**.\n\n> ${reply.replace(/\n/g, "\n> ")}`
              : "\n\nOpencode made no changes.",
          );
        }
        return { metadata: { changes: result.changes.length } };
      } catch (err) {
        const aborted = controller.signal.aborted;
        log.appendLine(`[run] ERROR${aborted ? " (cancelled)" : ""}: ${err instanceof Error ? err.message : String(err)}`);
        if (err instanceof Error && err.stack) log.appendLine(err.stack);
        stream.markdown(aborted ? "\n\nRequest cancelled." : `\n\n**Error**: ${err instanceof Error ? err.message : String(err)}`);
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
