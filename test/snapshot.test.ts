import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createSnapshot,
  computeChanges,
  restoreSnapshot,
  toFileChanges,
  applyFileChange,
  revertFileChange,
  computeHunks,
  applyHunkReject,
  buildDiffLines,
  diffStat,
} from "../src/snapshot.js";

async function makeProject(): Promise<{ root: string; store: string }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "ocx-snap-test-"));
  const root = path.join(base, "project");
  const store = path.join(base, "store");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "node_modules/pkg"), { recursive: true });
  await fs.mkdir(store, { recursive: true });
  await fs.writeFile(path.join(root, "src", "math.js"), "export function add(a, b) {\n  return a + b;\n}\n");
  await fs.writeFile(path.join(root, "src", "main.js"), "console.log('hello');\n");
  await fs.writeFile(path.join(root, "node_modules", "pkg", "lib.js"), "export const x = 1;\n");
  return { root, store };
}

test("snapshot then computeChanges detects modified file and restores it", async () => {
  const { root, store } = await makeProject();
  const snap = await createSnapshot(root, store, { sizeLimitBytes: 10 * 1024 * 1024 });
  assert.equal(snap.entries.size, 2, "node_modules must be ignored");
  assert.ok(snap.entries.has("src/math.js"));
  assert.ok(snap.entries.has("src/main.js"));

  await fs.writeFile(path.join(root, "src", "math.js"), "export function add(a, b) {\n  return a * 2 + b;\n}\n");

  const changes = await computeChanges(snap, store);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].relPath, "src/math.js");
  assert.equal(changes[0].kind, "modified");

  const before = changes[0].before!.toString("utf8");
  assert.match(before, /a \+ b/);
  assert.match(changes[0].after!.toString("utf8"), /a \* 2 \+ b/);

  await restoreSnapshot(snap, store, changes);
  const restored = await fs.readFile(path.join(root, "src", "math.js"), "utf8");
  assert.match(restored, /a \+ b/);
});

test("new file created by opencode is deleted on restore", async () => {
  const { root, store } = await makeProject();
  const snap = await createSnapshot(root, store, { sizeLimitBytes: 10 * 1024 * 1024 });

  await fs.writeFile(path.join(root, "src", "new.js"), "export const y = 2;\n");

  const changes = await computeChanges(snap, store);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, "added");
  assert.equal(changes[0].relPath, "src/new.js");

  await restoreSnapshot(snap, store, changes);
  await assert.rejects(fs.stat(path.join(root, "src", "new.js")));
});

test("deleted file is recreated on restore", async () => {
  const { root, store } = await makeProject();
  const snap = await createSnapshot(root, store, { sizeLimitBytes: 10 * 1024 * 1024 });

  await fs.rm(path.join(root, "src", "main.js"));

  const changes = await computeChanges(snap, store);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, "deleted");

  await restoreSnapshot(snap, store, changes);
  const content = await fs.readFile(path.join(root, "src", "main.js"), "utf8");
  assert.match(content, /hello/);
});

test("files too big are skipped and reported as unrestorable", async () => {
  const { root, store } = await makeProject();
  const snap = await createSnapshot(root, store, { sizeLimitBytes: 15 });
  assert.ok(snap.skipped.has("src/main.js"));

  await fs.writeFile(path.join(root, "src", "main.js"), "console.log('changed');\n");
  const changes = await computeChanges(snap, store);
  const main = changes.find((c) => c.relPath === "src/main.js");
  assert.ok(main);
  assert.equal(main.unrestorable, true);

  const fileChanges = await toFileChanges(changes);
  assert.ok(!fileChanges.some((c) => c.relPath === "src/main.js"), "unrestorable files must be excluded from review");

  await restoreSnapshot(snap, store, changes);
  assert.equal((await fs.readFile(path.join(root, "src", "main.js"), "utf8")).trim(), "console.log('changed');");
});

test("diffStat counts additions and deletions", () => {
  const before = Buffer.from("a\nb\nc\n");
  const after = Buffer.from("a\nx\nc\nd\n");
  const stats = diffStat(before, after);
  assert.equal(stats.additions, 2);
  assert.equal(stats.deletions, 1);
});

test("applyFileChange writes the proposed content, revertFileChange restores it", async () => {
  const { root } = await makeProject();
  const target = path.join(root, "src", "math.js");
  const before = await fs.readFile(target);
  const after = Buffer.from("export const z = 42;\n");

  const change = {
    path: target,
    relPath: "src/math.js",
    kind: "modified",
    before,
    after,
    additions: 3,
    deletions: 2,
    acceptedRanges: [],
  };

  await applyFileChange(change);
  assert.equal(await fs.readFile(target, "utf8"), "export const z = 42;\n");

  await revertFileChange(change);
  assert.equal((await fs.readFile(target)).equals(before), true);
});

test("revertFileChange deletes a file created by opencode", async () => {
  const { root } = await makeProject();
  const target = path.join(root, "src", "brand-new.js");
  const change = {
    path: target,
    relPath: "src/brand-new.js",
    kind: "added",
    before: Buffer.alloc(0),
    after: Buffer.from("export const n = 1;\n"),
    additions: 1,
    deletions: 0,
    acceptedRanges: [],
  };

  await applyFileChange(change);
  assert.ok(await fs.readFile(target, "utf8").then(() => true));

  await revertFileChange(change);
  await assert.rejects(fs.stat(target));
});

test("revertFileChange recreates a file deleted by opencode", async () => {
  const { root } = await makeProject();
  const target = path.join(root, "src", "main.js");
  const before = await fs.readFile(target);
  const change = {
    path: target,
    relPath: "src/main.js",
    kind: "deleted",
    before,
    after: Buffer.alloc(0),
    additions: 0,
    deletions: 1,
    acceptedRanges: [],
  };

  await applyFileChange(change);
  await assert.rejects(fs.stat(target));

  await revertFileChange(change);
  assert.ok((await fs.readFile(target)).equals(before));
});

test("computeHunks splits changes into separate segments", () => {
  const before = Buffer.from("a\nb\nc\nd\ne\nf\n");
  const after = Buffer.from("a\nb\nX\nc\nd\ne\nf\nY\n");
  const hunks = computeHunks(before, after);
  assert.equal(hunks.length, 2, "two separate edits must yield two hunks");
  // First hunk: replaced b → b, X
  assert.equal(hunks[0].newStart, 3);
  assert.equal(hunks[0].newLines, 1);
  // Second hunk: added Y at the end (line 8)
  assert.equal(hunks[1].newStart, 8);
  assert.equal(hunks[1].newLines, 1);
});

test("applyHunkReject reverts only the targeted segment", () => {
  const before = Buffer.from("a\nb\nc\nd\ne\nf\n");
  const after = Buffer.from("a\nb\nX\nc\nd\ne\nf\nY\n");
  const hunks = computeHunks(before, after);

  // Reject only the second hunk (added Y) → X must stay.
  const withoutSecond = applyHunkReject(before, after, hunks[1]).toString("utf8");
  assert.equal(withoutSecond, "a\nb\nX\nc\nd\ne\nf\n");

  // Reject the first hunk too → back to the original.
  const back = applyHunkReject(before, Buffer.from(withoutSecond), hunks[0]).toString("utf8");
  assert.equal(back, before.toString("utf8"));
});

test("applyHunkReject restores deleted lines", () => {
  const before = Buffer.from("a\nb\nc\nd\n");
  const after = Buffer.from("a\nd\n");
  const hunks = computeHunks(before, after);
  assert.equal(hunks.length, 1);
  const restored = applyHunkReject(before, after, hunks[0]).toString("utf8");
  assert.equal(restored, before.toString("utf8"));
});

test("applyHunkReject removes added lines at end of file", () => {
  const before = Buffer.from("a\nb\n");
  const after = Buffer.from("a\nb\nc\nd\n");
  const hunks = computeHunks(before, after);
  assert.equal(hunks.length, 1);
  const removed = applyHunkReject(before, after, hunks[0]).toString("utf8");
  assert.equal(removed, "a\nb\n");
});

test("buildDiffLines tags context, additions and deletions", () => {
  const before = Buffer.from("a\nb\nc\nd\n");
  const after = Buffer.from("a\nX\nc\nd\nY\n");
  const lines = buildDiffLines(before, after);
  assert.deepEqual(
    lines.map((l) => l.kind),
    ["context", "del", "add", "context", "context", "add"],
  );
  assert.deepEqual(
    lines.map((l) => l.hunkIndex),
    [-1, 0, 0, -1, -1, 1],
  );
  assert.deepEqual(lines.map((l) => l.text), ["a", "b", "X", "c", "d", "Y"]);
});

test("diffLinesFromHunks tags old and new line numbers", () => {
  const before = Buffer.from("a\nb\nc\nd\n");
  const after = Buffer.from("a\nX\nc\nd\nY\n");
  const lines = buildDiffLines(before, after);
  assert.deepEqual(
    lines.map((l) => [l.oldLine, l.newLine]),
    [
      [1, 1],
      [2, 0],
      [0, 2],
      [3, 3],
      [4, 4],
      [0, 5],
    ],
  );
});

test("buildDiffLines on a new file is all additions", () => {
  const lines = buildDiffLines(Buffer.alloc(0), Buffer.from("x\ny\n"));
  assert.deepEqual(lines.map((l) => l.kind), ["add", "add"]);
  assert.ok(lines.every((l) => l.hunkIndex === 0));
});

test("buildDiffLines on a deleted file is all deletions", () => {
  const lines = buildDiffLines(Buffer.from("x\ny\n"), Buffer.alloc(0));
  assert.deepEqual(lines.map((l) => l.kind), ["del", "del"]);
  assert.ok(lines.every((l) => l.hunkIndex === 0));
});
