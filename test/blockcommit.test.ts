import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "bun:test";
import Ajv from "ajv/dist/2020";
import { digestCommit } from "../src/digest";
import { listCommits } from "../src/git";
import { renderIdentity, renderOps } from "../src/ops";
import { verifyCommit, verifyDigest } from "../src/verify";

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "blockcommit-"));
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test User"]);
  return repo;
}

function commitAll(repo: string, message: string): string {
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

function cli(args: string[], cwd = join(import.meta.dir, "..")) {
  return spawnSync("bun", [join(import.meta.dir, "..", "src", "cli.ts"), ...args], {
    cwd,
    encoding: "utf8"
  });
}

describe("digestCommit", () => {
  test("pairs identical removed and added lines as moves", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "a.txt"), "keep\nmove\nremove\n");
    writeFileSync(join(repo, "b.txt"), "target\n");
    commitAll(repo, "base");

    writeFileSync(join(repo, "a.txt"), "keep\n");
    writeFileSync(join(repo, "b.txt"), "target\nmove\nadd\n");
    const commit = commitAll(repo, "move one line");

    const digest = digestCommit({ cwd: repo, commit });
    expect(digest.schema_version).toBe("blockcommit.digest.v2");
    expect(JSON.parse(JSON.stringify(digest))).not.toHaveProperty("repo");
    expect(digest.algorithm).toEqual({
      name: "exact-line-sha256-identity-preserving",
      version: 2,
      anchor_min_alnum: 4,
      exact_block_fallback: true,
      whole_file_identity: true,
      git_diff: {
        algorithm: "myers",
        indent_heuristic: false
      }
    });
    expect(digest.summary).toMatchObject({
      blocks: 3,
      moves: 1,
      insertions: 1,
      deletions: 1
    });

    const move = digest.blocks.find((block) => block.kind === "move");
    expect(move?.src?.path).toBe("a.txt");
    expect(move?.src?.start_line).toBe(2);
    expect(move?.dst?.path).toBe("b.txt");
    expect(move?.dst?.start_line).toBe(2);
    expect(move?.id).toMatch(/^bc_[0-9a-f]{16}$/);
    expect(move?.payload_encoding).toBe("utf-8");
    expect(move?.payload_text).toBe("move\n");
    expect(move?.payload_base64).toBeUndefined();
  });

  test("canonical digests do not depend on checkout path", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "file.txt"), "base\n");
    commitAll(repo, "base");
    writeFileSync(join(repo, "file.txt"), "base\nnext\n");
    const commit = commitAll(repo, "add line");

    const clone = mkdtempSync(join(tmpdir(), "blockcommit-clone-"));
    git(tmpdir(), ["clone", repo, clone]);

    expect(JSON.stringify(digestCommit({ cwd: repo, commit }))).toBe(
      JSON.stringify(digestCommit({ cwd: clone, commit }))
    );
  });

  test("groups a delete/add rename into one moved block", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "old.txt"), "alpha\nbeta\n");
    commitAll(repo, "base");

    git(repo, ["rm", "old.txt"]);
    writeFileSync(join(repo, "new.txt"), "alpha\nbeta\n");
    const commit = commitAll(repo, "rename without git mv");

    const digest = digestCommit({ cwd: repo, commit });
    expect(digest.summary.moves).toBe(1);
    expect(digest.summary.insertions).toBe(0);
    expect(digest.summary.deletions).toBe(0);
    expect(digest.blocks[0]).toMatchObject({
      kind: "move",
      payload_lines: 2,
      src: { path: "old.txt", start_line: 1, end_line: 2 },
      dst: { path: "new.txt", start_line: 1, end_line: 2 }
    });
  });

  test("tracks whole-file creation and deletion as null endpoint blocks", () => {
    const repo = makeRepo();
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src/delete.txt"), "gone\n");
    commitAll(repo, "base");

    git(repo, ["rm", "src/delete.txt"]);
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src/create.txt"), "fresh\n");
    const commit = commitAll(repo, "create delete");

    const digest = digestCommit({ cwd: repo, commit });
    expect(digest.summary).toMatchObject({
      moves: 0,
      insertions: 1,
      deletions: 1,
      rendered_blockpatches: 2
    });
    expect(digest.blocks.map((block) => block.kind).sort()).toEqual(["delete", "insert"]);
    expect(digest.blocks.every((block) => block.blockpatch.status === "rendered")).toBe(true);
    expect(digest.blocks.some((block) => "patch" in block.blockpatch)).toBe(false);
  });

  test("keeps replacement insertions in JSON when their anchors are also deleted", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "file.txt"), "before\nold\nafter\n");
    commitAll(repo, "base");

    writeFileSync(join(repo, "file.txt"), "before\nnew\nafter\n");
    const commit = commitAll(repo, "replace line");

    const digest = digestCommit({ cwd: repo, commit });
    const insert = digest.blocks.find((block) => block.kind === "insert");
    expect(insert?.payload_text).toBe("new\n");
    expect(insert?.blockpatch).toMatchObject({
      status: "unsupported",
      reason: "target anchor is removed by the same commit"
    });
  });

  test("does not pair coincidental trivial lines as moves", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "a.txt"), "alpha\n\nbeta\n}\n");
    writeFileSync(join(repo, "b.txt"), "one\ntwo\n");
    commitAll(repo, "base");

    writeFileSync(join(repo, "a.txt"), "alpha\nbeta\n");
    writeFileSync(join(repo, "b.txt"), "one\n\ntwo\n}\n");
    const commit = commitAll(repo, "unrelated blank line and brace shuffles");

    const digest = digestCommit({ cwd: repo, commit });
    expect(digest.summary.moves).toBe(0);
    expect(digest.summary.deletions).toBe(2);
    expect(digest.summary.insertions).toBe(2);
  });

  test("extends unique anchors through non-unique neighbor lines", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "a.txt"), "keep\nfunction unique() {\n\n}\nkeep2\n");
    writeFileSync(join(repo, "b.txt"), "target\n\n}\n");
    commitAll(repo, "base");

    writeFileSync(join(repo, "a.txt"), "keep\nkeep2\n");
    writeFileSync(join(repo, "b.txt"), "target\nfunction unique() {\n\n}\n\n}\n");
    const commit = commitAll(repo, "move a block containing trivial lines");

    const digest = digestCommit({ cwd: repo, commit });
    expect(digest.summary.moves).toBe(1);
    expect(digest.blocks.find((block) => block.kind === "move")).toMatchObject({
      payload_text: "function unique() {\n\n}\n",
      payload_lines: 3,
      src: { path: "a.txt", start_line: 2, end_line: 4 },
      dst: { path: "b.txt", start_line: 2, end_line: 4 }
    });
    expect(verifyCommit({ cwd: repo, commit }).ok).toBe(true);
  });

  test("reports ambiguity when moved blocks contain duplicate identical lines", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "old.ts"), "function unique() {\nrepeat();\nrepeat();\n}\n");
    commitAll(repo, "base");

    git(repo, ["rm", "old.ts"]);
    writeFileSync(join(repo, "new.ts"), "function unique() {\nrepeat();\nrepeat();\n}\n");
    const commit = commitAll(repo, "move duplicate lines");

    const digest = digestCommit({ cwd: repo, commit });
    expect(digest.summary.moves).toBe(1);
    expect(digest.blocks[0].match).toMatchObject({
      algorithm: "exact-line-sha256-identity-preserving",
      ambiguous: true,
      duplicate_removed_candidates: 1,
      duplicate_added_candidates: 1
    });
  });

  test("locks duplicate-only whole-file moves before line pairing", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "old.txt"), "hello world line\nhello world line\n");
    commitAll(repo, "base");

    git(repo, ["rm", "old.txt"]);
    writeFileSync(join(repo, "new.txt"), "hello world line\nhello world line\n");
    const commit = commitAll(repo, "move duplicate-only file");

    const digest = digestCommit({ cwd: repo, commit });
    expect(digest.summary).toMatchObject({
      moves: 1,
      insertions: 0,
      deletions: 0
    });
    expect(digest.blocks[0]).toMatchObject({
      kind: "move",
      payload_lines: 2,
      src: { path: "old.txt", start_line: 1, end_line: 2 },
      dst: { path: "new.txt", start_line: 1, end_line: 2 },
      match: {
        chosen_by: "whole_file_identity",
        confidence: "ambiguous",
        ambiguous: true,
        duplicate_removed_candidates: 1,
        duplicate_added_candidates: 1
      }
    });
    expect(digest.identity[0]).toMatchObject({
      kind: "renamed",
      old_identity: { path: "old.txt", lines: 2 },
      moved_to: { path: "new.txt", lines_moved: 2 },
      confidence: "exact"
    });
    expect(verifyCommit({ cwd: repo, commit }).ok).toBe(true);
  });

  test("locks short-line whole-file moves before line pairing", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "old.txt"), "x=1\ny=2\nz=3\n");
    commitAll(repo, "base");

    git(repo, ["rm", "old.txt"]);
    writeFileSync(join(repo, "new.txt"), "x=1\ny=2\nz=3\n");
    const commit = commitAll(repo, "move short-line file");

    const digest = digestCommit({ cwd: repo, commit });
    expect(digest.summary).toMatchObject({
      moves: 1,
      insertions: 0,
      deletions: 0
    });
    expect(digest.blocks[0]).toMatchObject({
      kind: "move",
      payload_text: "x=1\ny=2\nz=3\n",
      src: { path: "old.txt", start_line: 1, end_line: 3 },
      dst: { path: "new.txt", start_line: 1, end_line: 3 },
      match: {
        chosen_by: "whole_file_identity",
        confidence: "exact",
        ambiguous: false
      }
    });
    expect(digest.identity[0]).toMatchObject({
      kind: "renamed",
      confidence: "exact"
    });
    expect(verifyCommit({ cwd: repo, commit }).ok).toBe(true);
  });

  test("records chmod-only changes as unsupported file metadata with no line blocks", () => {
    const repo = makeRepo();
    git(repo, ["config", "core.filemode", "true"]);
    const script = join(repo, "script.sh");
    writeFileSync(script, "echo hi\n");
    commitAll(repo, "base");

    chmodSync(script, 0o755);
    const commit = commitAll(repo, "chmod script");

    const digest = digestCommit({ cwd: repo, commit });
    expect(digest.blocks).toEqual([]);
    expect(digest.files[0]).toMatchObject({
      path: "script.sh",
      old_mode: "100644",
      new_mode: "100755",
      line_digest_status: "unsupported",
      unsupported_reason: "mode_only"
    });
  });

  test("preserves no-newline-at-EOF payloads", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "file.txt"), "one\n");
    commitAll(repo, "base");

    writeFileSync(join(repo, "file.txt"), "one\ntwo");
    const commit = commitAll(repo, "add final line without newline");

    const digest = digestCommit({ cwd: repo, commit });
    const insert = digest.blocks.find((block) => block.kind === "insert");
    expect(insert).toMatchObject({
      payload_encoding: "utf-8",
      payload_text: "two",
      payload_lines: 1
    });
    const blockpatch = cli(["digest", commit, "--cwd", repo, "--format", "blockpatch"]);
    expect(blockpatch.status).toBe(0);
    expect(blockpatch.stdout).toContain("\\ No newline at end of file");
    expect(verifyCommit({ cwd: repo, commit }).ok).toBe(true);
  });

  test("preserves CRLF payload bytes", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "a.txt"), "keep\r\nmove\r\n");
    writeFileSync(join(repo, "b.txt"), "target\r\n");
    commitAll(repo, "base");

    writeFileSync(join(repo, "a.txt"), "keep\r\n");
    writeFileSync(join(repo, "b.txt"), "target\r\nmove\r\n");
    const commit = commitAll(repo, "move CRLF line");

    const digest = digestCommit({ cwd: repo, commit });
    const move = digest.blocks.find((block) => block.kind === "move");
    expect(move).toMatchObject({
      payload_encoding: "utf-8",
      payload_text: "move\r\n",
      payload_bytes: Buffer.byteLength("move\r\n")
    });
    expect(verifyCommit({ cwd: repo, commit }).ok).toBe(true);
  });

  test("encodes non-UTF-8 text payloads as base64", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "file.bin"), Buffer.from("keep\n", "utf8"));
    commitAll(repo, "base");

    const payload = Buffer.from([0xff, 0xfe, 0x0a]);
    writeFileSync(join(repo, "file.bin"), Buffer.concat([Buffer.from("keep\n"), payload]));
    const commit = commitAll(repo, "add non utf8 bytes");

    const digest = digestCommit({ cwd: repo, commit });
    const insert = digest.blocks.find((block) => block.kind === "insert");
    expect(insert).toMatchObject({
      payload_encoding: "base64",
      payload_base64: payload.toString("base64"),
      payload_lines: 1
    });
    expect(insert?.payload_text).toBeUndefined();
    expect(insert?.blockpatch).toMatchObject({
      status: "unsupported",
      reason: "blockpatch rendering requires valid UTF-8 payloads and anchors"
    });
    expect(verifyCommit({ cwd: repo, commit }).ok).toBe(true);
  });

  test("keeps same-file reorders with duplicate lines verifiable", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "file.ts"), "function alpha() {}\nrepeat();\nfunction bravo() {}\nrepeat();\n");
    commitAll(repo, "base");

    writeFileSync(join(repo, "file.ts"), "function bravo() {}\nrepeat();\nfunction alpha() {}\nrepeat();\n");
    const commit = commitAll(repo, "reorder duplicate blocks");

    const digest = digestCommit({ cwd: repo, commit });
    expect(digest.summary.moves).toBeGreaterThan(0);
    expect(digest.blocks.every((block) => block.id.startsWith("bc_"))).toBe(true);
    expect(verifyCommit({ cwd: repo, commit }).ok).toBe(true);
  });

  test("handles root commits against the empty tree", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "root.txt"), "root\n");
    const commit = commitAll(repo, "root");

    const digest = digestCommit({ cwd: repo, commit });
    expect(digest.parent).toBeNull();
    expect(digest.files[0]).toMatchObject({
      path: "root.txt",
      old_exists: false,
      new_exists: true,
      line_digest_status: "represented"
    });
    expect(digest.blocks).toHaveLength(1);
    expect(verifyCommit({ cwd: repo, commit }).ok).toBe(true);
  });

  test("rejects merge commits", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "base.txt"), "base\n");
    commitAll(repo, "base");
    const mainBranch = git(repo, ["branch", "--show-current"]);

    git(repo, ["checkout", "-b", "feature"]);
    writeFileSync(join(repo, "feature.txt"), "feature\n");
    commitAll(repo, "feature");

    git(repo, ["checkout", mainBranch]);
    writeFileSync(join(repo, "main.txt"), "main\n");
    commitAll(repo, "main");
    git(repo, ["merge", "--no-ff", "feature", "-m", "merge feature"]);
    const mergeCommit = git(repo, ["rev-parse", "HEAD"]);

    expect(() => digestCommit({ cwd: repo, commit: mergeCommit })).toThrow(/single-parent commits/);
  });

  test("marks binary file changes as explicitly unsupported files", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x0a, 0x03]));
    commitAll(repo, "base");

    writeFileSync(join(repo, "blob.bin"), Buffer.from([0x00, 0xff, 0xfe]));
    const commit = commitAll(repo, "change binary");

    const digest = digestCommit({ cwd: repo, commit });
    expect(digest.files[0]).toMatchObject({
      path: "blob.bin",
      binary: true,
      line_digest_status: "unsupported",
      unsupported_reason: "binary",
      old_mode: "100644",
      new_mode: "100644"
    });
    expect(digest.summary).toMatchObject({ blocks: 0, moves: 0, insertions: 0, deletions: 0 });
    expect(verifyCommit({ cwd: repo, commit }).ok).toBe(true);
  });

  test("records binary delete/add paths without pretending to know line identity", () => {
    const repo = makeRepo();
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    writeFileSync(join(repo, "old.bin"), bytes);
    commitAll(repo, "base");

    git(repo, ["rm", "old.bin"]);
    writeFileSync(join(repo, "new.bin"), bytes);
    const commit = commitAll(repo, "rename binary");

    const digest = digestCommit({ cwd: repo, commit });
    expect(digest.summary.blocks).toBe(0);
    expect(digest.files.map((file) => [file.path, file.line_digest_status, file.unsupported_reason]).sort()).toEqual([
      ["new.bin", "unsupported", "binary"],
      ["old.bin", "unsupported", "binary"]
    ]);
    expect(verifyCommit({ cwd: repo, commit }).ok).toBe(true);
  });
});

describe("identity", () => {
  test("names path reuse: whole file cut-pasted elsewhere, old name given new content", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "a.ts"), "export function first() {}\nexport function second() {}\nexport function third() {}\n");
    commitAll(repo, "base");

    writeFileSync(join(repo, "b.ts"), "export function first() {}\nexport function second() {}\nexport function third() {}\n");
    writeFileSync(join(repo, "a.ts"), "export const replacement = true;\nexport const fresh = 1;\n");
    const commit = commitAll(repo, "cut-paste a.ts to b.ts, reuse the name");

    const digest = digestCommit({ cwd: repo, commit });
    expect(digest.identity).toHaveLength(1);
    expect(digest.identity[0]).toMatchObject({
      kind: "path_reused",
      old_identity: { path: "a.ts", lines: 3 },
      moved_to: { path: "b.ts", lines_moved: 3 },
      new_identity: { path: "a.ts", lines: 2 },
      confidence: "exact",
      coverage: { old_file_lines_moved: 1, new_file_lines_from_old: 1 }
    });

    const oldA = digest.files.find((file) => file.path === "a.ts");
    const newB = digest.files.find((file) => file.path === "b.ts");
    expect(oldA?.old_sha256).toBe(newB?.new_sha256 ?? "");
    expect(digest.identity[0].old_identity.sha256).toBe(oldA?.old_sha256 ?? "");
    expect(verifyCommit({ cwd: repo, commit }).ok).toBe(true);
  });

  test("names a delete/add rename as an exact renamed event", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "old.txt"), "alpha\nbeta\n");
    commitAll(repo, "base");

    git(repo, ["rm", "old.txt"]);
    writeFileSync(join(repo, "new.txt"), "alpha\nbeta\n");
    const commit = commitAll(repo, "rename without git mv");

    const digest = digestCommit({ cwd: repo, commit });
    expect(digest.identity).toHaveLength(1);
    expect(digest.identity[0]).toMatchObject({
      kind: "renamed",
      old_identity: { path: "old.txt", lines: 2 },
      moved_to: { path: "new.txt", lines_moved: 2 },
      new_identity: null,
      confidence: "exact"
    });
  });

  test("reports partial confidence with coverage when a move is not whole-file", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "a.ts"), "moved one()\nmoved two()\nmoved three()\nstays behind()\n");
    commitAll(repo, "base");

    git(repo, ["rm", "a.ts"]);
    writeFileSync(join(repo, "b.ts"), "moved one()\nmoved two()\nmoved three()\n");
    const commit = commitAll(repo, "move most of a.ts");

    const digest = digestCommit({ cwd: repo, commit });
    expect(digest.identity).toHaveLength(1);
    expect(digest.identity[0]).toMatchObject({
      kind: "renamed",
      confidence: "partial",
      coverage: { old_file_lines_moved: 0.75, new_file_lines_from_old: 1 }
    });
    expect(renderIdentity(digest)).toBe("a.ts:4 -> b.ts:3 (3)\n");
  });

  test("emits no identity event for in-file reordering or minority moves", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "a.ts"), "function alpha() {}\nfunction bravo() {}\nfunction charlie() {}\n");
    commitAll(repo, "base");

    writeFileSync(join(repo, "a.ts"), "function charlie() {}\nfunction alpha() {}\nfunction bravo() {}\n");
    const commit = commitAll(repo, "reorder in place");

    const digest = digestCommit({ cwd: repo, commit });
    expect(digest.summary.moves).toBeGreaterThan(0);
    expect(digest.identity).toEqual([]);
  });

  test("renders minority cross-path movement in the pairwise identity view", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "a.ts"), "move alpha()\nstay bravo()\nstay charlie()\n");
    writeFileSync(join(repo, "b.ts"), "target delta()\n");
    commitAll(repo, "base");

    writeFileSync(join(repo, "a.ts"), "stay bravo()\nstay charlie()\n");
    writeFileSync(join(repo, "b.ts"), "target delta()\nmove alpha()\n");
    const commit = commitAll(repo, "move one line across paths");

    const digest = digestCommit({ cwd: repo, commit });
    expect(digest.identity).toEqual([]);
    expect(renderIdentity(digest)).toBe("a.ts:3 -> b.ts:2 (1)\n");
  });
});

describe("renderOps", () => {
  test("renders compact content op lines", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "a.ts"), "export function first() {}\nexport function second() {}\nexport function third() {}\n");
    commitAll(repo, "base");

    writeFileSync(join(repo, "b.ts"), "export function first() {}\nexport function second() {}\nexport function third() {}\n");
    writeFileSync(join(repo, "a.ts"), "export const replacement = true;\nexport const fresh = 1;\n");
    const commit = commitAll(repo, "cut-paste with name reuse");

    const lines = renderOps(digestCommit({ cwd: repo, commit })).trimEnd().split("\n");
    expect(lines).toEqual([
      "M a.ts:1+3 -> b.ts:1+3",
      "+ a.ts:1+2"
    ]);
  });

  test("renders pairwise identity flows", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "a.ts"), "export function first() {}\nexport function second() {}\nexport function third() {}\n");
    commitAll(repo, "base");

    writeFileSync(join(repo, "b.ts"), "export function first() {}\nexport function second() {}\nexport function third() {}\n");
    writeFileSync(join(repo, "a.ts"), "export const replacement = true;\nexport const fresh = 1;\n");
    const commit = commitAll(repo, "cut-paste with name reuse");

    expect(renderIdentity(digestCommit({ cwd: repo, commit }))).toBe("a.ts:3 -> b.ts:3 (3)\n");
  });
});

describe("verifyCommit", () => {
  test("round-trips a commit mixing moves, edits, creations, and deletions", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\nfour\nfive\n");
    writeFileSync(join(repo, "gone.txt"), "so long\n");
    commitAll(repo, "base");

    writeFileSync(join(repo, "a.txt"), "one\nthree\nfour!\nfive\ntwo\n");
    git(repo, ["rm", "gone.txt"]);
    writeFileSync(join(repo, "fresh.txt"), "brand new\nno trailing newline");
    const commit = commitAll(repo, "mixed change");

    const result = verifyCommit({ cwd: repo, commit });
    expect(result.ok).toBe(true);
    expect(result.files.map((file) => file.path).sort()).toEqual(["a.txt", "fresh.txt", "gone.txt"]);
  });

  test("round-trips every commit in this repository's history", () => {
    const commits = listCommits(import.meta.dir, "HEAD");
    expect(commits.length).toBeGreaterThan(0);
    for (const commit of commits) {
      const result = verifyCommit({ cwd: import.meta.dir, commit });
      const failures = result.files.filter((file) => !file.ok);
      expect(failures).toEqual([]);
    }
  });

  test("verifyDigest rejects stale or malicious identity events", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "old.txt"), "alpha\nbeta\n");
    commitAll(repo, "base");

    git(repo, ["rm", "old.txt"]);
    writeFileSync(join(repo, "new.txt"), "alpha\nbeta\n");
    const commit = commitAll(repo, "rename without git mv");

    const digest = digestCommit({ cwd: repo, commit });
    expect(verifyDigest({ cwd: repo, digest }).ok).toBe(true);

    const tampered = JSON.parse(JSON.stringify(digest)) as typeof digest;
    tampered.identity[0].kind = "path_reused";
    const result = verifyDigest({ cwd: repo, digest: tampered });
    expect(result.ok).toBe(false);
    expect(result.files).toContainEqual({
      path: "<digest>",
      ok: false,
      reason: "identity does not match recomputed digest"
    });
  });
});

describe("cli", () => {
  test("--format blockpatch --strict fails when any block is unsupported", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "file.txt"), "before\nold\nafter\n");
    commitAll(repo, "base");

    writeFileSync(join(repo, "file.txt"), "before\nnew\nafter\n");
    const commit = commitAll(repo, "replace line");

    const result = cli(["digest", commit, "--cwd", repo, "--format", "blockpatch", "--strict"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unsupported bc_");
    expect(result.stdout).toBe("");
  });

  test("supports --cwd for digesting another repository", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "file.txt"), "base\n");
    commitAll(repo, "base");
    writeFileSync(join(repo, "file.txt"), "base\nnext\n");
    const commit = commitAll(repo, "add line");

    const result = cli(["content", commit, "--cwd", repo]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^\+ file\.txt:2\+1$/m);
  });

  test("prints pairwise identity flows", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "old.txt"), "alpha\nbeta\n");
    commitAll(repo, "base");

    git(repo, ["rm", "old.txt"]);
    writeFileSync(join(repo, "new.txt"), "alpha\nbeta\n");
    const commit = commitAll(repo, "rename without git mv");

    const result = cli(["identity", commit, "--cwd", repo]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("old.txt:2 -> new.txt:2 (2)\n");
  });

  test("prints canonical digest ranges as JSONL", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "file.txt"), "one\n");
    const first = commitAll(repo, "one");
    writeFileSync(join(repo, "file.txt"), "one\ntwo\n");
    const second = commitAll(repo, "two");

    const result = cli(["digest", "--range", `${first}..${second}`, "--cwd", repo, "--format", "jsonl"]);
    expect(result.status).toBe(0);
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    const digest = JSON.parse(lines[0]);
    expect(digest.commit).toBe(second);
    expect(digest.schema_version).toBe("blockcommit.digest.v2");
  });

  test("reports bad commits and unknown options", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "file.txt"), "base\n");
    commitAll(repo, "base");

    const badCommit = cli(["digest", "not-a-commit", "--cwd", repo]);
    expect(badCommit.status).toBe(1);
    expect(badCommit.stderr).toContain("git rev-parse");

    const unknownOption = cli(["digest", "--definitely-unknown"], repo);
    expect(unknownOption.status).toBe(1);
    expect(unknownOption.stderr).toContain("unknown option");
  });

  test("verifies digest JSON files against their referenced commit", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "file.txt"), "base\n");
    commitAll(repo, "base");
    writeFileSync(join(repo, "file.txt"), "base\nnext\n");
    const commit = commitAll(repo, "add line");
    const digest = digestCommit({ cwd: repo, commit });
    const digestPath = join(repo, "digest.json");
    writeFileSync(digestPath, JSON.stringify(digest, null, 2));

    const missingCwd = cli(["verify", digestPath]);
    expect(missingCwd.status).toBe(1);
    expect(missingCwd.stdout).toContain("cwd is required to verify a saved digest");

    const ok = cli(["verify", digestPath, "--cwd", repo]);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain(`ok ${commit.slice(0, 12)} digest`);

    const okJson = cli(["verify", digestPath, "--cwd", repo, "--format", "json"]);
    expect(okJson.status).toBe(0);
    expect(JSON.parse(okJson.stdout)).toMatchObject({
      commit,
      ok: true
    });

    const tampered = JSON.parse(JSON.stringify(digest)) as typeof digest;
    tampered.blocks[0].payload_sha256 = "0".repeat(64);
    const tamperedPath = join(repo, "tampered.json");
    writeFileSync(tamperedPath, JSON.stringify(tampered));

    const fail = cli(["verify", tamperedPath, "--cwd", repo]);
    expect(fail.status).toBe(1);
    expect(fail.stdout).toContain("payload_sha256");
  });

  test("prefers a commit over a same-named file when verifying", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "file.txt"), "base\n");
    const commit = commitAll(repo, "base");
    git(repo, ["branch", "dev"]);
    writeFileSync(join(repo, "dev"), "not json\n");

    const result = cli(["verify", "dev", "--cwd", repo], repo);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`ok ${commit.slice(0, 12)}`);
  });

  test("prints structured verify output for commits", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "file.txt"), "base\n");
    const commit = commitAll(repo, "base");

    const result = cli(["verify", commit, "--cwd", repo, "--format", "json"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      commit,
      ok: true,
      files: [{ path: "file.txt", ok: true }]
    });
  });

  test("ships a JSON schema for the canonical digest", () => {
    const schema = JSON.parse(readFileSync(join(import.meta.dir, "..", "schema", "blockcommit.digest.v2.schema.json"), "utf8"));
    expect(schema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      properties: {
        schema_version: { const: "blockcommit.digest.v2" },
        algorithm: { $ref: "#/$defs/algorithm" }
      }
    });
    expect(schema.$defs.blockpatch.properties.patch).toBeUndefined();
  });
});

describe("digest schema", () => {
  test("generated digests validate against the shipped schema", () => {
    const schema = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "schema", "blockcommit.digest.v2.schema.json"), "utf8")
    );
    const ajv = new Ajv({ strict: false, allErrors: true });
    const validate = ajv.compile(schema);

    const repo = makeRepo();
    writeFileSync(join(repo, "a.txt"), "keep\nmove one\nmove two\nmove three\n");
    writeFileSync(join(repo, "b.txt"), "target\n");
    const root = commitAll(repo, "base");

    writeFileSync(join(repo, "a.txt"), "keep\nadd\n");
    writeFileSync(join(repo, "b.txt"), "target\nmove one\nmove two\nmove three\n");
    writeFileSync(join(repo, "bin.dat"), Buffer.from([0, 1, 2, 3]));
    writeFileSync(join(repo, "latin.txt"), Buffer.from([0x66, 0xff, 0x0a]));
    const moves = commitAll(repo, "moves, binary, non-utf8");

    chmodSync(join(repo, "b.txt"), 0o755);
    const modeOnly = commitAll(repo, "mode only");

    const digests = [root, moves, modeOnly].map((commit) => digestCommit({ cwd: repo, commit }));
    for (const digest of digests) {
      validate(digest);
      expect(validate.errors ?? []).toEqual([]);
    }

    // Guard that the fixtures still exercise the schema's conditional shapes.
    const [rootDigest, movesDigest, modeOnlyDigest] = digests;
    expect(rootDigest.parent).toBeNull();
    expect(rootDigest).not.toHaveProperty("repo");
    expect(rootDigest.algorithm).toMatchObject({
      name: "exact-line-sha256-identity-preserving",
      version: 2,
      anchor_min_alnum: 4,
      exact_block_fallback: true,
      whole_file_identity: true
    });
    expect(movesDigest.blocks.some((block) => block.payload_encoding === "base64")).toBe(true);
    expect(movesDigest.files.some((file) => file.unsupported_reason === "binary")).toBe(true);
    expect(movesDigest.identity.length).toBeGreaterThan(0);
    expect(modeOnlyDigest.files.some((file) => file.unsupported_reason === "mode_only")).toBe(true);

    const invalidInsert = JSON.parse(JSON.stringify(movesDigest));
    const moveBlock = invalidInsert.blocks.find((block: { kind: string }) => block.kind === "move");
    moveBlock.kind = "insert";
    expect(validate(invalidInsert)).toBe(false);
    expect(validate.errors ?? []).not.toEqual([]);
  });
});
