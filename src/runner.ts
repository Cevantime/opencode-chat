import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { createSnapshot, computeChanges, restoreSnapshot, toFileChanges, watchWorkspace } from "./snapshot.js";
import type { LiveChangeWatcher } from "./snapshot.js";
import type { RunOptions, RunResult, FileChange, AskedQuestion, AskedPermission, PermissionResponse } from "./types.js";

export interface RunnerHooks {
  /** Raw SSE events from the opencode server. */
  onEvent?: (event: unknown) => void;
  /** User-facing progress strings (snapshot, tools, permissions…). */
  onProgress?: (label: string) => void;
  /**
   * opencode asks the user a question mid-run. Resolve with the picked answer
   * labels (in order) to answer, or `null` to reject the question. This blocks
   * the run until it resolves.
   */
  onQuestion?: (question: AskedQuestion) => Promise<string[] | null>;
  /**
   * opencode asks the user to allow/deny a tool (edit, write, bash, webfetch,
   * MCP…). Resolve with the response to answer; this blocks the run until it
   * resolves.
   */
  onPermission?: (permission: AskedPermission) => Promise<PermissionResponse>;
  /**
   * Live changes detected while opencode is still running (files that already
   * differ from the snapshot), so the review can be updated as it goes.
   */
  onFilesChanged?: (changes: FileChange[]) => void;
  /** Called once the session for this run is known. `reused` is true when an existing session was kept. */
  onSession?: (sessionID: string, reused: boolean) => void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function unwrap(event: unknown): { type: string; props?: Record<string, unknown> } {
  const payload = isObject(event) && isObject(event.payload) ? (event.payload as Record<string, unknown>) : event;
  if (!isObject(payload)) return { type: "" };
  const type = typeof payload.type === "string" ? payload.type : "";
  const props = isObject(payload.properties) ? (payload.properties as Record<string, unknown>) : undefined;
  return { type, props };
}

/** Background SSE watcher: forwards events and auto-replies to permission prompts. */
async function watchEvents(
  client: OpencodeClient,
  sessionID: string,
  hooks: RunnerHooks,
  opts: { allowBash: boolean; webfetchPermission: "allow" | "deny"; baseUrl: string; directory: string },
  signal: AbortSignal,
): Promise<void> {
  try {
    const sub = await client.event.subscribe({
      signal,
      onSseError: () => {},
      sseMaxRetryAttempts: 1,
    } as never);
    const stream = (sub as unknown as { stream: AsyncGenerator<unknown> }).stream;
    for await (const raw of stream) {
      if (signal.aborted) break;
      hooks.onEvent?.(raw);
      const { type, props } = unwrap(raw);
      if (type === "permission.updated" && props?.permission && isObject(props.permission)) {
        const permission = props.permission as Record<string, unknown>;
        const tool = String(permission.type ?? permission.permission ?? "");
        const id = String(permission.id ?? "");
        if (id) {
          let response: PermissionResponse;
          if (hooks.onPermission) {
            response = await hooks.onPermission({
              id,
              tool,
              title: String(permission.title ?? tool),
              metadata: isObject(permission.metadata) ? permission.metadata : {},
            });
          } else {
            // No hook: fall back to the configured gates. Everything else is
            // rejected so a headless run never silently grants file edits.
            const isBash = tool === "bash" || tool.includes("bash");
            const isWeb = tool === "webfetch";
            const allow = isBash ? opts.allowBash : isWeb ? opts.webfetchPermission === "allow" : false;
            response = allow ? "always" : "reject";
          }
          await client
            .postSessionIdPermissionsPermissionId({
              path: { id: sessionID, permissionID: id },
              body: { response },
            })
            .catch(() => {});
          const title = String(permission.title ?? tool);
          const label =
            response === "always" ? "Always allowed" : response === "once" ? "Allowed once" : "Denied";
          hooks.onProgress?.(`${label}: ${title}`);
        }
      } else if (type === "question.asked" || type === "question.v2.asked") {
        await handleQuestion(props, type === "question.v2.asked", opts, hooks);
      }
    }
  } catch {
    // stream aborted or closed
  }
}

/**
 * A question request from the model. The prompt call stays pending until the
 * request is answered or rejected, so collect the user's input (via the hook)
 * then reply. If there is no hook the question is rejected so the run does not
 * hang forever.
 */
async function handleQuestion(
  props: Record<string, unknown> | undefined,
  v2: boolean,
  opts: { baseUrl: string; directory: string },
  hooks: RunnerHooks,
): Promise<void> {
  const requestID = String(props?.id ?? "");
  const rawQuestions = Array.isArray(props?.questions) ? (props.questions as unknown[]) : [];
  if (!requestID || rawQuestions.length === 0) return;

  const answers: string[][] = [];
  let rejected = !hooks.onQuestion;
  if (!rejected) {
    for (const raw of rawQuestions) {
      const answer = await hooks.onQuestion?.(raw as AskedQuestion);
      if (!answer || answer.length === 0) {
        rejected = true;
        break;
      }
      answers.push(answer);
    }
  }

  // v1 questions are answered through /question/{id}/reply?directory=…; v2
  // questions through /api/session/{sessionID}/question/{id}/reply. Try the
  // matching endpoint first, then fall back to the other for older servers.
  const action = rejected ? "reject" : "reply";
  const query = `?directory=${encodeURIComponent(opts.directory)}`;
  const sessionID = String(props?.sessionID ?? "");
  const v1Url = `${opts.baseUrl}/question/${requestID}/${action}${query}`;
  const v2Url = sessionID ? `${opts.baseUrl}/api/session/${sessionID}/question/${requestID}/${action}` : "";
  const endpoints = v2 ? [v2Url, v1Url].filter(Boolean) : [v1Url, v2Url].filter(Boolean);
  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: rejected ? undefined : JSON.stringify({ answers }),
      });
      if (res.ok) break;
    } catch {
      // try the next endpoint
    }
  }
  hooks.onProgress?.(rejected ? "Question rejected" : "Question answered");
}

async function extractReply(client: OpencodeClient, sessionID: string): Promise<string> {
  try {
    const messages = await client.session.messages({ path: { id: sessionID } });
    const lastAssistant = [...(messages.data ?? [])].reverse().find((m) => m.info.role === "assistant");
    if (!lastAssistant) return "";
    return lastAssistant.parts
      .filter((p) => p.type === "text")
      .map((p) => (p as { text: string }).text)
      .join("\n");
  } catch {
    return "";
  }
}

/**
 * Run one opencode turn against a workspace.
 *
 * Flow: snapshot the workspace → prompt opencode (streaming) → detect the
 * changed files → return the before/after diffs. The workspace is left
 * modified (Copilot-style): the caller presents the diffs for accept/reject.
 * On abort the workspace is rolled back completely; on error it is left as-is
 * so the partial changes remain reviewable.
 */
export async function runOpencode(
  client: OpencodeClient,
  opts: RunOptions,
  hooks: RunnerHooks = {},
): Promise<RunResult> {
  const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-diff-snap-"));
  const watcher = new AbortController();
  let sessionID = opts.sessionID ?? "";
  let snapshot: Awaited<ReturnType<typeof createSnapshot>> | undefined;
  let liveWatcher: LiveChangeWatcher | undefined;

  try {
    hooks.onProgress?.("Snapshotting the workspace…");
    snapshot = await createSnapshot(opts.workspaceRoot, storeDir, {
      sizeLimitBytes: opts.snapshotSizeLimitBytes,
    });

    if (hooks.onFilesChanged) {
      liveWatcher = watchWorkspace(snapshot, storeDir, (fileChanges) => {
        for (const file of fileChanges) {
          file.path = path.join(opts.workspaceRoot, ...file.relPath.split("/"));
        }
        hooks.onFilesChanged?.(fileChanges);
      });
    }

    // Reuse the existing session when possible so the conversation context
    // survives across prompts (and even server restarts). Validate it first
    // and fall back to a brand-new session if it disappeared.
    if (sessionID) {
      try {
        await client.session.messages({ path: { id: sessionID } });
        hooks.onSession?.(sessionID, true);
      } catch {
        sessionID = "";
      }
    }
    if (!sessionID) {
      const created = await client.session.create({ query: { directory: opts.workspaceRoot } });
      sessionID = created.data?.id ?? "";
      if (sessionID) hooks.onSession?.(sessionID, false);
    }
    if (!sessionID) throw new Error("opencode returned no session.");

    void watchEvents(
      client,
      sessionID,
      hooks,
      { allowBash: opts.allowBash, webfetchPermission: opts.webfetchPermission, baseUrl: opts.baseUrl, directory: opts.workspaceRoot },
      watcher.signal,
    );

    const body: Record<string, unknown> = {
      parts: [{ type: "text", text: opts.prompt }],
    };
    if (opts.model) body.model = opts.model;
    if (opts.agent) body.agent = opts.agent;

    hooks.onProgress?.("Starting opencode…");
    const abortSession = () => {
      void client.session.abort({ path: { id: sessionID } }).catch(() => {});
    };
    opts.signal?.addEventListener("abort", abortSession, { once: true });

    let result;
    try {
      result = await client.session.prompt({ path: { id: sessionID }, body: body as never });
    } catch (err) {
      if (opts.signal?.aborted) throw new Error("aborted");
      throw new Error(`opencode call failed: ${String(err)}`);
    }
    opts.signal?.removeEventListener("abort", abortSession);

    if (result.error) {
      const data = (result.error as { data?: { message?: string } }).data;
      throw new Error(data?.message ?? "opencode call failed.");
    }

    hooks.onProgress?.("Analyzing changes…");
    const changes = await computeChanges(snapshot, storeDir);

    // The workspace stays modified (Copilot-style): the diff compares the
    // original (snapshot) against the modified content. Accepting keeps the
    // current state, rejecting restores the original via revertFileChange.
    // In plan mode the workspace must end up untouched, so any change opencode
    // made is rolled back right here.
    if (opts.restoreOnComplete) {
      await restoreSnapshot(snapshot, storeDir, changes);
      hooks.onProgress?.("Restored the workspace (plan mode is read-only).");
    }

    const reply = await extractReply(client, sessionID);
    const fileChanges = await toFileChanges(changes);
    for (const file of fileChanges) {
      file.path = path.join(opts.workspaceRoot, ...file.relPath.split("/"));
    }
    const unrestorable = changes.filter((c) => c.unrestorable).map((c) => c.relPath);

    return {
      sessionID,
      messageID: result.data?.info?.id ?? "",
      reply,
      changes: fileChanges,
      unrestorable,
      aborted: false,
    };
  } catch (err) {
    if (opts.signal?.aborted) {
      // Rollback complet en cas d'abandon afin de ne laisser aucune modif partielle.
      if (snapshot) {
        try {
          const changes = await computeChanges(snapshot, storeDir);
          await restoreSnapshot(snapshot, storeDir, changes);
        } catch {
          // nothing more we can do
        }
      }
      throw Object.assign(new Error("aborted"), { sessionID });
    }
    throw err;
  } finally {
    watcher.abort();
    liveWatcher?.dispose();
    await fs.rm(storeDir, { recursive: true, force: true }).catch(() => {});
  }
}
