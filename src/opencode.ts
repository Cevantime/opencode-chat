import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk";
import type { OpencodeClient, Config as OpenCodeConfig } from "@opencode-ai/sdk";

export interface ServerHandle {
  url: string;
  client: OpencodeClient;
  /** True once the server process has exited. */
  died: boolean;
  /** Called when the server process exits, so callers can invalidate the handle. */
  onExit?: (code: number | null) => void;
  close(): void;
}

/** Resolve the path to the opencode binary. */
export async function resolveOpencodeBinary(configured?: string): Promise<string> {
  const candidates: string[] = [];
  if (configured && configured.trim()) candidates.push(configured.trim());
  candidates.push("opencode");
  const home = os.homedir();
  candidates.push(path.join(home, ".opencode", "bin", "opencode"));
  candidates.push("/opt/homebrew/bin/opencode", "/usr/local/bin/opencode");

  const existing: string[] = [];
  for (const candidate of candidates) {
    if (candidate.includes("/")) {
      try {
        await fs.access(candidate, fs.constants.X_OK);
        existing.push(candidate);
      } catch {
        // not found
      }
    } else {
      // Search PATH.
      const search = (process.env.PATH ?? "").split(path.delimiter);
      for (const dir of search) {
        if (!dir) continue;
        const full = path.join(dir, candidate);
        try {
          await fs.access(full, fs.constants.X_OK);
          existing.push(full);
          break;
        } catch {
          // keep looking
        }
      }
    }
    if (existing.length) break;
  }

  if (!existing.length) {
    throw new Error(
      `opencode binary not found. Install it (npm i -g opencode-ai, brew install sst/tap/opencode…) or set the "opencodeDiff.opencodePath" setting.`,
    );
  }
  return existing[0];
}

export interface ServerStartOptions {
  binary: string;
  cwd: string;
  allowBash: boolean;
  webfetchPermission: "allow" | "deny";
  /**
   * Isolate opencode's data (sessions, DB) into this directory via
   * OPENCODE_DATA_DIR, so a concurrent opencode instance (e.g. the TUI in the
   * terminal) cannot corrupt or overwrite this server's context.
   */
  dataDir?: string;
  signal?: AbortSignal;
  log?: (line: string) => void;
}

function buildConfig(opts: ServerStartOptions): OpenCodeConfig {
  // Permissions that let opencode freely edit are scoped to the `build` agent:
  // opencode merges the global `permission` config into every agent (last wins),
  // so a global `edit: allow` would override the `plan` agent's read-only rules.
  const buildPermission: Record<string, "allow" | "deny"> = {
    edit: "allow",
    external_directory: "allow",
  };
  if (opts.allowBash) buildPermission.bash = "allow";
  return {
    permission: { webfetch: opts.webfetchPermission } as OpenCodeConfig["permission"],
    agent: {
      build: {
        permission: { ...buildPermission } as NonNullable<NonNullable<OpenCodeConfig["agent"]>["build"]>["permission"],
      },
    },
  };
}

/** Start a headless opencode server and wait until it is listening. */
export async function startOpencodeServer(opts: ServerStartOptions): Promise<ServerHandle> {
  const binDir = path.dirname(opts.binary);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: [binDir, process.env.PATH].filter(Boolean).join(path.delimiter),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(buildConfig(opts)),
  };
  if (opts.dataDir) env.OPENCODE_DATA_DIR = opts.dataDir;

  const proc = spawn(opts.binary, ["serve", "--hostname=127.0.0.1", "--port=0"], {
    env,
    cwd: opts.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  let resolved = false;

  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (!resolved) {
        reject(new Error(`Timed out while starting the opencode server.\n${output.slice(-2000)}`));
      }
    }, 20000);

    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      for (const line of output.split("\n")) {
        if (line.startsWith("opencode server listening")) {
          const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
          if (match) {
            resolved = true;
            clearTimeout(timeout);
            resolve(match[1]);
            return;
          }
        }
      }
      opts.log?.(output.slice(-2000));
    };

    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", (chunk) => {
      opts.log?.(chunk.toString());
      output += chunk.toString();
    });
    proc.on("error", (err) => {
      clearTimeout(timeout);
      if (!resolved) reject(err);
    });
    proc.on("exit", (code) => {
      clearTimeout(timeout);
      if (!resolved) {
        reject(new Error(`The opencode server exited (code ${code}).\n${output.slice(-2000)}`));
      }
    });
    opts.signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      if (!resolved) {
        proc.kill("SIGTERM");
        reject(opts.signal!.reason ?? new Error("aborted"));
      }
    });
  });

  if (opts.signal?.aborted) {
    proc.kill("SIGTERM");
    throw new Error("aborted");
  }

  const client = createOpencodeClient({ baseUrl: url });

  const handle: ServerHandle = {
    url,
    client,
    died: false,
    close() {
      try {
        proc.kill("SIGTERM");
      } catch {
        // already dead
      }
    },
  };
  proc.on("exit", (code) => {
    handle.died = true;
    handle.onExit?.(code);
  });

  return handle;
}
