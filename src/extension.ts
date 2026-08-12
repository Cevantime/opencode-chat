import * as vscode from "vscode";
import { createHash } from "node:crypto";
import path from "node:path";
import { startOpencodeServer, resolveOpencodeBinary } from "./opencode.js";
import type { ServerHandle } from "./opencode.js";
import { runOpencode } from "./runner.js";
import type { AskedQuestion, AskedPermission, FileChange, PermissionResponse } from "./types.js";
import { OpencodeModelProvider, OPENCODE_VENDOR } from "./models.js";
import {
  ReviewStore,
  ReviewTreeProvider,
  ReviewEditorProvider,
  OriginalDocumentProvider,
  ORIGINAL_SCHEME,
  ReviewFileDecorationProvider,
  OpencodeReviewSourceControl,
  acceptAll,
  rejectAll,
  acceptChange,
  rejectChange,
  cloneReview,
} from "./review.js";

interface ExtConfig {
  opencodePath: string;
  model: string;
  agent: string;
  mode: "auto" | "build" | "plan";
  autoOpenReview: boolean;
  newSession: boolean;
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
    mode: cfg.get<"auto" | "build" | "plan">("mode", "auto"),
    autoOpenReview: cfg.get<boolean>("autoOpenReview", true),
    newSession: cfg.get<boolean>("newSession", true),
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

/** Mode instructions VS Code attaches to a chat request when a chat mode
 * (e.g. the built-in Agent mode or a custom agent like Plan) is active. The
 * field exists at runtime but is not part of the published typings. */
interface ChatModeInstructions {
  name?: string;
  isBuiltin?: boolean;
}

/**
 * Decide whether opencode should run in plan (read-only) mode. Precedence:
 * explicit `opencodeDiff.mode` setting, then the `/plan` chat command, then the
 * mode selected in the VS Code chat window (`modeInstructions2.name`).
 */
function resolvePlanMode(request: {
  command?: string;
  modeInstructions2?: ChatModeInstructions;
}, cfgMode: ExtConfig["mode"]): boolean {
  if (cfgMode === "plan") return true;
  if (cfgMode === "build") return false;
  if (request.command === "plan") return true;
  const modeName = (request as { modeInstructions2?: ChatModeInstructions }).modeInstructions2?.name;
  return (modeName ?? "").toLowerCase() === "plan";
}

class ServerManager {
  private handles = new Map<string, ServerHandle>();
  private binary: string | undefined;

  log: (line: string) => void = () => {};

  constructor(private readonly dataDirFor: (root: string) => string) {}

  async resolveBinary(): Promise<string> {
    if (!this.binary) {
      this.binary = await resolveOpencodeBinary(getConfig().opencodePath);
    }
    return this.binary;
  }

  async get(root: string): Promise<ServerHandle> {
    const existing = this.handles.get(root);
    if (existing && !existing.died) return existing;
    if (existing) {
      this.log(`[server] restarting a dead server for ${root}`);
      existing.close();
      this.handles.delete(root);
    }
    const cfg = getConfig();
    const binary = await this.resolveBinary();
    const handle = await startOpencodeServer({
      binary,
      cwd: root,
      allowBash: cfg.allowBash,
      webfetchPermission: cfg.webfetchPermission,
      dataDir: this.dataDirFor(root),
    });
    handle.onExit = (code) => {
      this.log(`[server] opencode server exited (code ${code}) — will restart on next run`);
    };
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
        state.reasoningSeen.set(part.id ?? "", part.text.length);
        const whole = part.text.replace(/\s+/g, " ").trim();
        if (whole) stream.progress(`Thinking… ${whole}`);
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

/** A pending opencode question, answered by clicking a chat button. */
interface PendingQuestion {
  requestID: string;
  questionText: string;
  stream: vscode.ChatResponseStream;
  /** Selected labels so far (multi-select questions). */
  selected: Set<string>;
  settled: boolean;
  resolve: (answers: string[] | null) => void;
}

const pendingQuestions = new Map<string, PendingQuestion>();
let questionSeq = 0;

/** Resolve (or reject with `null`) a pending question from a button click. */
function settleQuestion(requestID: string, answers: string[] | null): void {
  const pending = pendingQuestions.get(requestID);
  if (!pending || pending.settled) return;
  if (answers && answers.length > 0) {
    pending.stream.markdown(`> **Your answer:** ${answers.join(", ")}\n`);
  }
  pending.resolve(answers);
}

/**
 * Ask the user for an answer to an opencode question. The question is streamed
 * into the chat and answered with inline buttons (one per option, plus a custom
 * entry and a skip), so nothing is truncated and the exchange stays in the chat
 * conversation. Resolves with the picked labels, or `null` on skip/abort.
 */
async function askQuestion(
  question: AskedQuestion,
  stream: vscode.ChatResponseStream,
  signal: AbortSignal,
): Promise<string[] | null> {
  const requestID = `ocx-q-${Date.now().toString(36)}-${(questionSeq++).toString(36)}`;
  const title = question.header || "OpenCode";
  const options = question.options ?? [];
  const multiple = question.multiple === true;

  // 1. Show the question in the chat flow.
  stream.markdown(`\n\n> **${title}**\n> ${question.question.replace(/\n/g, "\n> ")}\n`);

  // 2. Register the answer so the buttons can resolve it.
  const pending: PendingQuestion = {
    requestID,
    questionText: question.question,
    stream,
    selected: new Set(),
    settled: false,
    resolve: () => {},
  };
  pendingQuestions.set(requestID, pending);

  const answerPromise = new Promise<string[] | null>((resolve) => {
    let done = false;
    const finish = (answers: string[] | null) => {
      if (done) return;
      done = true;
      pending.settled = true;
      signal.removeEventListener("abort", onAbort);
      pendingQuestions.delete(requestID);
      resolve(answers);
    };
    pending.resolve = finish;
    const onAbort = () => finish(null);
    if (signal.aborted) {
      finish(null);
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
  if (signal.aborted) return null;

  // 3. Answer buttons. (Reached only while the run is still blocked on the
  //    question, so the stream is still open.)
  for (const option of options) {
    if (multiple) {
      stream.button({
        title: option.label,
        tooltip: option.description,
        command: "opencodeDiff.toggleQuestionOption",
        arguments: [requestID, option.label],
      });
    } else {
      stream.button({
        title: option.label,
        tooltip: option.description,
        command: "opencodeDiff.answerQuestion",
        arguments: [requestID, [option.label]],
      });
    }
  }
  if (multiple && options.length > 0) {
    stream.button({ title: "$(check) Confirm", command: "opencodeDiff.confirmQuestion", arguments: [requestID] });
  }
  const hasCustom = question.custom !== false;
  if (hasCustom) {
    stream.button({
      title: "Type your own answer…",
      command: "opencodeDiff.answerQuestionCustom",
      arguments: [requestID]
    });
  }
  stream.button({ title: "$(close) Skip", command: "opencodeDiff.rejectQuestion", arguments: [requestID] });

  return await answerPromise;
}

/** A pending opencode permission request, answered by clicking a chat button. */
interface PendingPermission {
  id: string;
  tool: string;
  stream: vscode.ChatResponseStream;
  settled: boolean;
  resolve: (response: PermissionResponse) => void;
}

const pendingPermissions = new Map<string, PendingPermission>();

/**
 * Ask the user to allow/deny an opencode tool call (edit, write, MCP…). The
 * request is shown in the chat and answered with inline buttons, so the user
 * always knows what opencode wants to do. Resolves with the chosen response;
 * defaults to "reject" when the run is cancelled.
 */
async function askPermission(
  permission: AskedPermission,
  stream: vscode.ChatResponseStream,
  signal: AbortSignal,
): Promise<PermissionResponse> {
  const { id, tool, title } = permission;

  stream.markdown(
    `\n\n> **Permission: ${tool}**\n> ${title.replace(/\n/g, "\n> ")}\n`,
  );

  const pending: PendingPermission = {
    id,
    tool,
    stream,
    settled: false,
    resolve: () => {},
  };
  pendingPermissions.set(id, pending);

  const responsePromise = new Promise<PermissionResponse>((resolve) => {
    let done = false;
    const finish = (response: PermissionResponse) => {
      if (done) return;
      done = true;
      pending.settled = true;
      signal.removeEventListener("abort", onAbort);
      pendingPermissions.delete(id);
      resolve(response);
    };
    pending.resolve = finish;
    const onAbort = () => finish("reject");
    if (signal.aborted) {
      finish("reject");
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
  if (signal.aborted) return "reject";

  stream.button({ title: "$(check) Allow once", command: "opencodeDiff.permissionResponse", arguments: [id, "once"] });
  stream.button({ title: "$(check-all) Always allow", command: "opencodeDiff.permissionResponse", arguments: [id, "always"] });
  stream.button({ title: "$(close) Reject", command: "opencodeDiff.permissionResponse", arguments: [id, "reject"] });

  return await responsePromise;
}

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("OpenCode Diff");
  log.appendLine("[activate] extension activated");
  const store = new ReviewStore();

  /** Stable per-workspace data dir so sessions survive server restarts. */
  const dataDirFor = (root: string): string => {
    const hash = createHash("sha1").update(root).digest("hex").slice(0, 16);
    return path.join(context.globalStorageUri.fsPath, "data", hash);
  };
  const serverManager = new ServerManager(dataDirFor);
  serverManager.log = (line) => log.appendLine(line);
  const modelProvider = new OpencodeModelProvider({
    resolveBinary: () => serverManager.resolveBinary(),
    getServer: (root) => serverManager.get(root),
  });
  let currentRun: AbortController | undefined;
  /** opencode session per chat conversation (key = first prompt of the conversation, or "" when sharing one session globally). */
  const sessionIds = new Map<string, string>();

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

  // A native Source Control repository per workspace root with pending changes,
  // created on demand so the SCM view stays clean when nothing is under review.
  const scms = new Map<string, OpencodeReviewSourceControl>();
  const reconcileSourceControls = (): void => {
    const roots = new Set(vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? []);
    const needed = new Set(
      [...store.all()]
        .filter((r) => r.changes.size > 0 && roots.has(r.root))
        .map((r) => r.root),
    );
    for (const [root, scm] of scms) {
      if (!needed.has(root)) {
        scm.dispose();
        scms.delete(root);
      }
    }
    for (const root of needed) {
      if (!scms.has(root)) {
        const scm = new OpencodeReviewSourceControl(store, root);
        scm.log = (line) => log.appendLine(`[scm] ${line}`);
        scms.set(root, scm);
      }
    }
  };

  context.subscriptions.push(
    treeView,
    editorProvider,
    vscode.workspace.registerTextDocumentContentProvider(ORIGINAL_SCHEME, originalProvider),
    vscode.window.registerFileDecorationProvider(new ReviewFileDecorationProvider(store)),
    vscode.lm.registerLanguageModelChatProvider(OPENCODE_VENDOR, modelProvider),
    vscode.workspace.onDidChangeWorkspaceFolders(() => reconcileSourceControls()),
    store.onDidChangeEvent(() => {
      updateContext();
      reviewTree.refresh();
      editorProvider.refresh();
      reconcileSourceControls();
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
    vscode.commands.registerCommand("opencodeDiff.acceptActiveSegment", () => {
      void editorProvider.acceptActiveSegment();
    }),
    vscode.commands.registerCommand("opencodeDiff.rejectActiveSegment", () => {
      void editorProvider.rejectActiveSegment();
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
    vscode.commands.registerCommand("opencodeDiff.answerQuestion", (requestID: string, labels: string[]) => {
      settleQuestion(requestID, labels);
    }),
    vscode.commands.registerCommand("opencodeDiff.toggleQuestionOption", (requestID: string, label: string) => {
      const pending = pendingQuestions.get(requestID);
      if (!pending || pending.settled) return;
      if (pending.selected.has(label)) pending.selected.delete(label);
      else pending.selected.add(label);
      const list = [...pending.selected].join(", ");
      pending.stream.markdown(`> Selected: ${list || "(none)"}\n`);
    }),
    vscode.commands.registerCommand("opencodeDiff.confirmQuestion", (requestID: string) => {
      const pending = pendingQuestions.get(requestID);
      if (!pending) return;
      settleQuestion(requestID, pending.selected.size > 0 ? [...pending.selected] : null);
    }),
    vscode.commands.registerCommand("opencodeDiff.answerQuestionCustom", async (requestID: string) => {
      const pending = pendingQuestions.get(requestID);
      if (!pending || pending.settled) return;
      log.appendLine(`[OpenCode] Custom answer requested for ${requestID}`);
      const input = await vscode.window.showInputBox({
        title: "OpenCode question",
        prompt: "Type your own answer. The question is displayed in the chat above.",
        placeHolder: "Type your answer…",
      });
      settleQuestion(requestID, input && input.trim() ? [input.trim()] : null);
    }),
    vscode.commands.registerCommand("opencodeDiff.rejectQuestion", (requestID: string) => {
      settleQuestion(requestID, null);
    }),
    vscode.commands.registerCommand("opencodeDiff.permissionResponse", (id: string, response: string) => {
      const pending = pendingPermissions.get(id);
      if (!pending || pending.settled) return;
      const label = response === "once" ? "Allowed once" : response === "always" ? "Always allowed" : "Rejected";
      pending.stream.markdown(`> **Permission:** ${label}\n`);
      pending.resolve(response as PermissionResponse);
    }),
    vscode.commands.registerCommand("opencodeDiff.refreshModels", async () => {
      await modelProvider.refresh();
      log.appendLine("[command] opencodeDiff.refreshModels → models refreshed");
      vscode.window.showInformationMessage("OpenCode Diff: model list refreshed.");
    }),
  );

  const participant = vscode.chat.createChatParticipant(
    "opencodeDiff.chat",
    async (request, context, stream, token) => {
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
      const firstTurn = context.history[0] as vscode.ChatRequestTurn | undefined;
      const sessionKey = cfg.newSession ? (firstTurn ? firstTurn.prompt : request.prompt) : "";
      const reusedSession = sessionIds.get(sessionKey);
      log.appendLine(`[run] workspace=${root}`);
      log.appendLine(`[run] sessionKey=${sessionKey ? JSON.stringify(sessionKey.slice(0, 60)) : "(global)"} reuse=${reusedSession ? "yes" : "no"}`);
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
      const planMode = resolvePlanMode(
        request as { command?: string; modeInstructions2?: ChatModeInstructions },
        cfg.mode,
      );
      const agent = planMode ? "plan" : cfg.agent || undefined;
      if (planMode) {
        stream.markdown("> Running in **plan** mode — opencode will only propose changes (read-only).\n\n");
      }
      log.appendLine(`[run] planMode=${planMode} agent=${agent ?? "default"}`);
      const controller = new AbortController();
      currentRun = controller;
      token.onCancellationRequested(() => controller.abort());
      const status = vscode.window.setStatusBarMessage("OpenCode: running…");

      await vscode.workspace.saveAll(false);

      // Remember the review as it stands before this run: if the run is aborted
      // the workspace is rolled back and the review must return to this state.
      const preRunReview = store.get(root);
      const preRunSnapshot = preRunReview ? cloneReview(preRunReview) : undefined;
      const preRunPaths = new Set(preRunReview ? [...preRunReview.changes.keys()] : []);
      store.setRunning(root, true);

      try {
        const server = await serverManager.get(root);
        log.appendLine("[run] opencode server started");
        const result = await runOpencode(
          server.client,
          {
            workspaceRoot: root,
            baseUrl: server.url,
            prompt: request.prompt,
            model,
            agent,
            sessionID: reusedSession,
            restoreOnComplete: planMode,
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
            onQuestion: (question) => askQuestion(question, stream, controller.signal),
            onPermission: (permission) => {
              // Tools with an explicit setting are answered from the config.
              if (permission.tool === "bash") return Promise.resolve(cfg.allowBash ? "always" : "reject");
              if (permission.tool === "webfetch") {
                return Promise.resolve(cfg.webfetchPermission === "allow" ? "always" : "reject");
              }
              // Plan mode is read-only: never grant file edits.
              if (planMode) return Promise.resolve("reject");
              // Everything else (edit, write, MCP tools…) is asked to the user.
              return askPermission(permission, stream, controller.signal);
            },
            onSession: (sessionID, reused) => {
              log.appendLine(`[session] ${reused ? "reused" : "created"} id=${sessionID}`);
            },
            onFilesChanged: (fileChanges: FileChange[]) => {
              if (planMode) return; // plan mode is read-only, nothing to review
              log.appendLine(`[live] ${fileChanges.length} file(s) changed so far: ${fileChanges.map((c) => c.relPath).join(", ")}`);
              store.merge(root, {
                sessionID: reusedSession ?? "",
                messageID: "",
                reply: "",
                changes: new Map(fileChanges.map((c) => [c.relPath, c])),
                createdAt: Date.now(),
                running: true,
              });
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

        sessionIds.set(sessionKey, result.sessionID);
        if (planMode) {
          // Plan mode is read-only: the workspace was restored, so there is
          // nothing to review. The plan itself was already streamed above.
          log.appendLine("[run] plan mode — no review created");
          stream.markdown("\n\n_Plan generated — no changes were made to your files._");
          return { metadata: { changes: 0, plan: true } };
        }

        const review = store.merge(
          root,
          {
            sessionID: result.sessionID,
            messageID: result.messageID,
            reply: result.reply,
            changes: new Map(result.changes.map((c) => [c.relPath, c])),
            createdAt: Date.now(),
            running: false,
          },
          { keepUntouched: (relPath) => preRunPaths.has(relPath) },
        );
        const merged = [...review.changes.values()].sort((a, b) => a.relPath.localeCompare(b.relPath));
        log.appendLine(`[review] ${merged.length} change(s) stored for ${root}`);
        log.appendLine(`[review] files: ${merged.map((c) => c.relPath).join(", ")}`);
        updateContext();

        if (merged.length > 0) {
          const lines = merged.map(
            (c) => `- \`${c.relPath}\` ${c.kind === "added" ? "(new)" : c.kind === "deleted" ? "(deleted)" : ""} +${c.additions} −${c.deletions}`,
          );
          stream.markdown(
            [
              `\n\n**${merged.length} file(s) changed** (on disk — accept or reject below):`,
              ...lines,
            ].join("\n"),
          );
          if (result.unrestorable.length > 0) {
            stream.markdown(
              `\n\n⚠️ Files changed but **not restorable** (too large or ignored): ${result.unrestorable.join(", ")}.`,
            );
          }
          stream.button({ command: "opencodeDiff.focusReview", title: "Review changes" });
          editorProvider.convertExistingTabs(root);
          if (cfg.autoOpenReview) {
            const first = merged[0];
            log.appendLine(`[run] autoOpenReview → showing review, opening ${first.relPath} in the diff editor`);
            await editorProvider.open(root, first.relPath);
            await vscode.commands.executeCommand("opencodeDiff.focusReview");
            const item = reviewTree.firstItem();
            if (item) {
              setTimeout(() => {
                void treeView.reveal(item, { select: true, focus: false });
              }, 100);
            }
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
        if (aborted) {
          sessionIds.delete(sessionKey);
          if (preRunSnapshot) store.set(preRunSnapshot);
          else store.clear(root);
          stream.markdown("\n\nRequest cancelled. The workspace has been restored to its original state.");
        } else {
          stream.markdown(`\n\n**Error**: ${err instanceof Error ? err.message : String(err)}`);
        }
        return { metadata: { error: true } };
      } finally {
        currentRun = undefined;
        store.setRunning(root, false);
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
