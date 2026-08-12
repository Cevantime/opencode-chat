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
  rebaseFileChange,
  mergeFileChanges,
} from "../src/snapshot.js";
import type { FileChange } from "../src/types.js";

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

function change(relPath: string, before: string, after: string): FileChange {
  return {
    path: `/abs/${relPath}`,
    relPath,
    kind: "modified",
    before: Buffer.from(before),
    after: Buffer.from(after),
    additions: 0,
    deletions: 0,
    hunks: [],
    acceptedRanges: [],
  };
}

test("rebaseFileChange keeps the original before and accumulates the diff across prompts", () => {
  const run1 = change("src/a.js", "a\nb\n", "a\nX\nb\n");
  run1.additions = 1;
  run1.deletions = 0;

  // Prompt 2 snapshots the post-run-1 state and adds another line.
  const run2 = change("src/a.js", "a\nX\nb\n", "a\nX\nb\nY\n");
  run2.additions = 1;
  run2.deletions = 0;

  const merged = rebaseFileChange(run1, run2);
  assert.equal(merged.before.toString("utf8"), "a\nb\n", "before must stay the very first original content");
  assert.equal(merged.after.toString("utf8"), "a\nX\nb\nY\n");
  assert.equal(merged.additions, 2, "+n−m must reflect the whole cumulative diff");
  assert.equal(merged.deletions, 0);
  assert.equal(merged.hunks.length, 2, "both edits must remain separate segments");
  assert.deepEqual(merged.acceptedRanges, [], "accepted segments reset when the diff moves");
});

test("rebaseFileChange normalizes the kind after a deleted file is recreated", () => {
  const deleted = change("src/x.js", "old content\n", "");
  deleted.kind = "deleted";
  const recreated = change("src/x.js", "", "new content\n");

  const merged = rebaseFileChange(deleted, recreated);
  assert.equal(merged.kind, "modified");
  assert.equal(merged.before.toString("utf8"), "old content\n");
  assert.equal(merged.after.toString("utf8"), "new content\n");
  assert.equal(merged.additions, 1);
  assert.equal(merged.deletions, 1);
});

test("rebaseFileChange keeps an added file added with the original empty before", () => {
  const added = change("src/new.js", "", "a\nb\n");
  added.kind = "added";
  // A live watch snapshot sees the file mid-writing: before = full current content.
  const grown = change("src/new.js", "a\nb\n", "a\nb\nc\n");

  const merged = rebaseFileChange(added, grown);
  assert.equal(merged.kind, "added");
  assert.equal(merged.before.length, 0, "before must stay empty for a file opencode created");
  assert.equal(merged.after.toString("utf8"), "a\nb\nc\n");
  assert.equal(merged.additions, 3, "stats must count the whole new file");
  assert.equal(merged.deletions, 0);
});

test("mergeFileChanges keeps untouched files and appends new ones", () => {
  const existing = new Map<string, FileChange>([
    ["src/a.js", change("src/a.js", "a\nb\n", "a\nX\nb\n")],
    ["src/b.js", change("src/b.js", "c\n", "c\nY\n")],
  ]);

  const merged = mergeFileChanges(existing, [
    change("src/a.js", "a\nX\nb\n", "a\nX\nb\nZ\n"),
    change("src/c.js", "", "new file\n"),
  ]);

  assert.equal(merged.length, 3);
  const a = merged.find((c) => c.relPath === "src/a.js")!;
  assert.equal(a.before.toString("utf8"), "a\nb\n");
  assert.equal(a.after.toString("utf8"), "a\nX\nb\nZ\n");
  assert.equal(a.additions, 2);
  assert.ok(merged.some((c) => c.relPath === "src/b.js"), "untouched file must stay in the review");
  const c = merged.find((c) => c.relPath === "src/c.js")!;
  assert.equal(c.kind, "added");
  assert.equal(c.before.length, 0);
});

test("mergeFileChanges drops a file that went back to its original content", () => {
  const existing = new Map<string, FileChange>([
    ["src/a.js", change("src/a.js", "a\nb\n", "a\nX\nb\n")],
  ]);
  // The file is now byte-identical to its original before content.
  const merged = mergeFileChanges(existing, [change("src/a.js", "a\nX\nb\n", "a\nb\n")]);
  assert.equal(merged.length, 0, "a file reverted to its original must leave the review");
});

test("mergeFileChanges drops untouched files not covered by keepUntouched", () => {
  const existing = new Map<string, FileChange>([
    ["src/prior.js", change("src/prior.js", "p\n", "p\nX\n")],
    ["src/live.js", change("src/live.js", "l\n", "l\nY\n")],
  ]);
  const merged = mergeFileChanges(
    existing,
    [],
    (relPath) => relPath === "src/prior.js",
  );
  assert.deepEqual(
    merged.map((c) => c.relPath),
    ["src/prior.js"],
    "only files predating the run must survive a live reconciliation",
  );
});
