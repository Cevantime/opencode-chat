import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk";
import type { OpencodeClient, Config as OpenCodeConfig } from "@opencode-ai/sdk";

export interface ServerHandle {
  url: string;
  client: OpencodeClient;
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
      `Binaire opencode introuvable. Installez-le (npm i -g opencode-ai, brew install sst/tap/opencode…) ou renseignez le paramètre "opencodeDiff.opencodePath".`,
    );
  }
  return existing[0];
}

export interface ServerStartOptions {
  binary: string;
  cwd: string;
  allowBash: boolean;
  webfetchPermission: "allow" | "deny";
  signal?: AbortSignal;
  log?: (line: string) => void;
}

function buildConfig(opts: ServerStartOptions): OpenCodeConfig {
  const permission: Record<string, "allow" | "deny"> = {
    edit: "allow",
    webfetch: opts.webfetchPermission,
    external_directory: "allow",
  };
  if (opts.allowBash) permission.bash = "allow";
  return {
    permission: { ...permission } as OpenCodeConfig["permission"],
  };
}

/** Start a headless opencode server and wait until it is listening. */
export async function startOpencodeServer(opts: ServerStartOptions): Promise<ServerHandle> {
  const binDir = path.dirname(opts.binary);
  const env = {
    ...process.env,
    PATH: [binDir, process.env.PATH].filter(Boolean).join(path.delimiter),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(buildConfig(opts)),
  };

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
        reject(new Error(`Délai dépassé au démarrage du serveur opencode.\n${output.slice(-2000)}`));
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
        reject(new Error(`Le serveur opencode s'est arrêté (code ${code}).\n${output.slice(-2000)}`));
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

  return {
    url,
    client,
    close() {
      try {
        proc.kill("SIGTERM");
      } catch {
        // already dead
      }
    },
  };
}
