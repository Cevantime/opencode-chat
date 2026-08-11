import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { createSnapshot, computeChanges, restoreSnapshot, toFileChanges } from "./snapshot.js";
import type { RunOptions, RunResult } from "./types.js";

export interface RunnerHooks {
  /** Raw SSE events from the opencode server. */
  onEvent?: (event: unknown) => void;
  /** User-facing progress strings (snapshot, tools, permissions…). */
  onProgress?: (label: string) => void;
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
  opts: { allowBash: boolean; webfetchPermission: "allow" | "deny" },
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
        const isBash = tool === "bash" || tool.includes("bash");
        const isWeb = tool === "webfetch";
        const allow = isBash ? opts.allowBash : isWeb ? opts.webfetchPermission === "allow" : true;
        const response = allow ? "always" : "reject";
        const id = String(permission.id ?? "");
        if (id) {
          await client
            .postSessionIdPermissionsPermissionId({
              path: { id: sessionID, permissionID: id },
              body: { response },
            })
            .catch(() => {});
          const title = String(permission.title ?? tool);
          hooks.onProgress?.(`${allow ? "Allowed" : "Denied"}: ${title}`);
        }
      }
    }
  } catch {
    // stream aborted or closed
  }
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
 * In case of abort or error the workspace is rolled back completely.
 */
export async function runOpencode(
  client: OpencodeClient,
  opts: RunOptions,
  hooks: RunnerHooks = {},
): Promise<RunResult> {
  const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-diff-snap-"));
  const watcher = new AbortController();
  let sessionID = "";
  let snapshot: Awaited<ReturnType<typeof createSnapshot>> | undefined;

  try {
    hooks.onProgress?.("Snapshotting the workspace…");
    snapshot = await createSnapshot(opts.workspaceRoot, storeDir, {
      sizeLimitBytes: opts.snapshotSizeLimitBytes,
    });

    const created = await client.session.create({ query: { directory: opts.workspaceRoot } });
    sessionID = created.data?.id ?? "";
    if (!sessionID) throw new Error("opencode returned no session.");

    void watchEvents(
      client,
      sessionID,
      hooks,
      { allowBash: opts.allowBash, webfetchPermission: opts.webfetchPermission },
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
      throw new Error("aborted");
    }
    throw err;
  } finally {
    watcher.abort();
    await fs.rm(storeDir, { recursive: true, force: true }).catch(() => {});
  }
}
