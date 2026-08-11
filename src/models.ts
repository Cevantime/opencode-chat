import { spawn } from "node:child_process";
import * as vscode from "vscode";
import type { ServerHandle } from "./opencode.js";

/** Vendor id under which opencode's models are registered in VS Code. */
export const OPENCODE_VENDOR = "opencode";

export interface OpencodeModelProviderDeps {
  /** Resolve the path to the opencode binary. */
  resolveBinary(): Promise<string>;
  /** Start (or reuse) a headless opencode server for a workspace root. */
  getServer(root: string): Promise<ServerHandle>;
}

interface OpenCodeModel {
  providerID: string;
  modelID: string;
}

const MODELS_CACHE_MS = 60_000;

function parseModelsOutput(output: string): OpenCodeModel[] {
  const models: OpenCodeModel[] = [];
  for (const line of output.split("\n")) {
    const value = line.trim();
    if (!value) continue;
    const idx = value.indexOf("/");
    if (idx <= 0 || idx === value.length - 1) continue;
    models.push({ providerID: value.slice(0, idx), modelID: value.slice(idx + 1) });
  }
  return models;
}

function runOpencodeModels(binary: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, ["models"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString()));
    proc.stderr?.on("data", (chunk: Buffer) => (err += chunk.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `opencode models exited with code ${code}`));
    });
  });
}

/**
 * Exposes opencode's models (from `opencode models`, any provider) to VS Code's
 * chat model picker via the {@link vscode.LanguageModelChatProvider} API. The
 * `id` of each model carries the full `provider/model` identity so it survives
 * the round-trip through VS Code; the OpenCode chat participant and direct
 * `sendRequest` calls both forward it to opencode verbatim.
 */
export class OpencodeModelProvider implements vscode.LanguageModelChatProvider {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.changeEmitter.event;

  private cache: { at: number; models: OpenCodeModel[] } | undefined;

  constructor(private readonly deps: OpencodeModelProviderDeps) {}

  async refresh(): Promise<void> {
    this.cache = undefined;
    this.changeEmitter.fire();
  }

  private async listModels(): Promise<OpenCodeModel[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < MODELS_CACHE_MS) return this.cache.models;
    const binary = await this.deps.resolveBinary();
    const output = await runOpencodeModels(binary);
    const models = parseModelsOutput(output);
    this.cache = { at: now, models };
    return models;
  }

  async provideLanguageModelChatInformation(): Promise<vscode.LanguageModelChatInformation[]> {
    const models = await this.listModels();
    return models.map((model) => ({
      id: `${model.providerID}/${model.modelID}`,
      name: model.modelID.replace(/-/g, " "),
      family: model.modelID,
      version: "1.0",
      detail: model.providerID === OPENCODE_VENDOR ? "OpenCode" : model.providerID,
      maxInputTokens: 128_000,
      maxOutputTokens: 8_192,
      capabilities: { toolCalling: true },
    }));
  }

  /**
   * Maps a model picked in VS Code's chat model picker (any vendor, e.g. a
   * Copilot or Ollama extension model) to a model opencode can use, when one
   * with the same id/name is available in `opencode models`. Used so a pick of
   * a local Ollama model ("qwen3.6-coding:latest") runs opencode with
   * "ollama/qwen3.6-coding" instead of silently falling back to the default.
   */
  async resolveOpenCodeModel(pickerId: string): Promise<OpenCodeModel | undefined> {
    const models = await this.listModels();
    const normalized = pickerId.trim();
    if (!normalized) return undefined;
    const withoutTag = normalized.split(":")[0].trim().toLowerCase();
    for (const candidate of [normalized.toLowerCase(), withoutTag]) {
      if (!candidate) continue;
      const full = models.find((m) => `${m.providerID}/${m.modelID}`.toLowerCase() === candidate);
      if (full) return full;
      const byModel = models.filter((m) => m.modelID.toLowerCase() === candidate);
      if (byModel.length > 0) {
        return byModel.find((m) => m.providerID === "ollama") ?? byModel[0];
      }
    }
    return undefined;
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    _options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) throw new Error("Open a folder first to chat with opencode models.");

    const text = messages
      .map((message) =>
        message.content
          .map((part) => {
            const value =
              typeof part === "string"
                ? part
                : (part as { value?: unknown; text?: unknown })?.value ??
                  (part as { value?: unknown; text?: unknown })?.text;
            return typeof value === "string" ? value : "";
          })
          .filter((value) => value.length > 0)
          .join("\n"),
      )
      .filter((value) => value.length > 0)
      .join("\n\n");
    if (!text.trim()) throw new Error("No text to send to opencode.");

    const server = await this.deps.getServer(root);
    const created = await server.client.session.create({ query: { directory: root } });
    const sessionID = created.data?.id ?? "";
    if (!sessionID) throw new Error("opencode returned no session.");

    const controller = new AbortController();
    const cancellation = token.onCancellationRequested(() => controller.abort());

    const roles = new Map<string, string>();
    const seen = new Map<string, number>();
    const sub = await server.client.event.subscribe({
      signal: controller.signal,
      onSseError: () => {},
      sseMaxRetryAttempts: 1,
    } as never);
    const stream = (sub as unknown as { stream: AsyncGenerator<unknown> }).stream;
    const reader = (async () => {
      for await (const raw of stream) {
        if (controller.signal.aborted) break;
        const wrapped = raw as { payload?: unknown } | null | undefined;
        const event =
          wrapped && typeof wrapped === "object" && "payload" in wrapped ? wrapped.payload : raw;
        const ev = event as { type?: string; properties?: Record<string, unknown> } | null | undefined;
        const props = ev?.properties ?? {};
        if (ev?.type === "message.updated") {
          const info = props.info as { id?: string; role?: string } | undefined;
          if (info?.id && info.role) roles.set(info.id, info.role);
          continue;
        }
        if (ev?.type !== "message.part.updated") continue;
        const part = props.part as { id?: string; messageID?: string; type?: string; text?: string } | undefined;
        if (!part || part.type !== "text" || !part.text) continue;
        const role = part.messageID ? roles.get(part.messageID) : undefined;
        if (role && role !== "assistant") continue;
        const id = part.id ?? "";
        const start = seen.get(id) ?? 0;
        if (part.text.length > start) {
          progress.report(new vscode.LanguageModelTextPart(part.text.slice(start)));
          seen.set(id, part.text.length);
        }
      }
    })().catch(() => {});

    try {
      const body: Record<string, unknown> = { parts: [{ type: "text", text }] };
      if (model.id) {
        const slash = model.id.indexOf("/");
        if (slash > 0) body.model = { providerID: model.id.slice(0, slash), modelID: model.id.slice(slash + 1) };
        else body.model = model.id;
      }
      const result = await server.client.session.prompt({ path: { id: sessionID }, body: body as never });
      if (result.error) {
        const data = (result.error as { data?: { message?: string } }).data;
        throw new Error(data?.message ?? "opencode call failed.");
      }
    } finally {
      cancellation.dispose();
      controller.abort();
      await reader;
      void server.client.session.delete({ path: { id: sessionID } }).catch(() => {});
    }
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
  ): Promise<number> {
    const content =
      typeof text === "string"
        ? text
        : text.content
            .map((part) =>
              typeof part === "string"
                ? part
                : String((part as { value?: unknown; text?: unknown })?.value ?? (part as { value?: unknown; text?: unknown })?.text ?? ""),
            )
            .join("\n");
    return Math.max(1, Math.ceil(content.length / 4));
  }
}
