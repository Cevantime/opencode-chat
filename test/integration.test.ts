import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startOpencodeServer, resolveOpencodeBinary } from "../src/opencode.js";
import { runOpencode } from "../src/runner.js";
import { revertFileChange } from "../src/snapshot.js";

const SKIP = process.env.OPENCODE_TEST_SKIP_INTEGRATION === "1";

test("real opencode run: edits detected and workspace left modified", { skip: SKIP }, async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "ocx-integration-"));
  const root = path.join(base, "project");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  const original = "export function add(a, b) {\n  return a + b;\n}\n\nexport function multiply(a, b) {\n  return a * b;\n}\n";
  await fs.writeFile(path.join(root, "src", "math.js"), original);

  const binary = await resolveOpencodeBinary();
  const server = await startOpencodeServer({
    binary,
    cwd: root,
    allowBash: false,
    webfetchPermission: "deny",
  });
  t.after(() => server.close());

  const result = await runOpencode(
    server.client,
    {
      workspaceRoot: root,
      prompt: "Ajoute une fonction subtract(a, b) dans src/math.js. Ne fais rien d'autre.",
      model: { providerID: "opencode", modelID: "big-pickle" },
      snapshotSizeLimitBytes: 10 * 1024 * 1024,
      allowBash: false,
      webfetchPermission: "deny",
    },
    {
      onProgress: (label) => console.log("  ·", label),
    },
  );

  const changed = result.changes.find((c) => c.relPath === "src/math.js");
  assert.ok(changed, `expected src/math.js to be in changes, got: ${JSON.stringify(result.changes.map((c) => c.relPath))}`);
  assert.equal(changed.kind, "modified");
  assert.match(changed.after.toString("utf8"), /subtract/);
  assert.equal(changed.before.toString("utf8"), original);
  assert.equal(result.unrestorable.length, 0);

  // Copilot-style: the workspace stays modified after the run.
  const onDisk = await fs.readFile(path.join(root, "src", "math.js"), "utf8");
  assert.match(onDisk, /subtract/, "workspace must stay modified after the run");

  // Rejecting the change restores the original content.
  await revertFileChange(changed);
  const reverted = await fs.readFile(path.join(root, "src", "math.js"), "utf8");
  assert.equal(reverted, original, "reject must restore the original content");
});

test("restoreOnComplete leaves the workspace untouched (plan mode)", { skip: SKIP }, async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "ocx-integration-"));
  const root = path.join(base, "project");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  const original = "export function add(a, b) {\n  return a + b;\n}\n";
  await fs.writeFile(path.join(root, "src", "math.js"), original);

  const binary = await resolveOpencodeBinary();
  const server = await startOpencodeServer({
    binary,
    cwd: root,
    allowBash: false,
    webfetchPermission: "deny",
  });
  t.after(() => server.close());

  const result = await runOpencode(
    server.client,
    {
      workspaceRoot: root,
      prompt: "Ajoute une fonction subtract(a, b) dans src/math.js. Ne fais rien d'autre.",
      model: { providerID: "opencode", modelID: "big-pickle" },
      snapshotSizeLimitBytes: 10 * 1024 * 1024,
      allowBash: false,
      webfetchPermission: "deny",
      restoreOnComplete: true,
    },
    {
      onProgress: (label) => console.log("  ·", label),
    },
  );

  const onDisk = await fs.readFile(path.join(root, "src", "math.js"), "utf8");
  assert.equal(onDisk, original, "plan mode must leave the workspace untouched");
});

