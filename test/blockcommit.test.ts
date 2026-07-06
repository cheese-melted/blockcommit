import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "bun:test";
import { digestCommit } from "../src/digest";

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
    expect(move?.payload).toBe("move\n");
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
  });

  test("keeps replacement insertions in JSON when their anchors are also deleted", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "file.txt"), "before\nold\nafter\n");
    commitAll(repo, "base");

    writeFileSync(join(repo, "file.txt"), "before\nnew\nafter\n");
    const commit = commitAll(repo, "replace line");

    const digest = digestCommit({ cwd: repo, commit });
    const insert = digest.blocks.find((block) => block.kind === "insert");
    expect(insert?.payload).toBe("new\n");
    expect(insert?.blockpatch).toMatchObject({
      status: "unsupported",
      reason: "target anchor is removed by the same commit"
    });
  });
});
