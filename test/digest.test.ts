import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, test } from "bun:test";
import { Ajv2020 as Ajv } from "ajv/dist/2020.js";
import { renderContent } from "../src/content.js";
import { digestCommit } from "../src/digest.js";
import { listCommits } from "../src/git.js";
import { renderIdentity, renderIdentityFrom, renderIdentityTo } from "../src/identity-view.js";
import { validateDigest } from "../src/index.js";
import { schemaVersion } from "../src/types.js";
import { verifyCommit, verifyDigest } from "../src/verify.js";
import { applyFiles, generatedCommitCase, replaceFiles } from "./support/generated-case.js";
import { cleanupTempDirectories, cli, commitAll, commitCanonicalTree, git, makeRepo, makeTempDir } from "./support/repo.js";

afterEach(cleanupTempDirectories);

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
    expect(digest.schema_version).toBe("git-trails.digest.v4");
    expect(JSON.parse(JSON.stringify(digest))).not.toHaveProperty("repo");
    expect(digest.algorithm).toEqual({
      name: "exact-line-sha256-identity-preserving",
      version: 3,
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
    expect(digest.symbols).toEqual(["a.txt", "b.txt"]);

    const move = digest.blocks.find((block) => block.kind === "move");
    expect(move?.src?.path).toBe("a.txt");
    expect(move?.src?.start_line).toBe(2);
    expect(move?.src?.symbol).toBe(0);
    expect(move?.src?.total_lines).toBe(3);
    expect(move?.dst?.path).toBe("b.txt");
    expect(move?.dst?.start_line).toBe(2);
    expect(move?.dst?.symbol).toBe(1);
    expect(move?.dst?.total_lines).toBe(3);
    expect(move?.id).toMatch(/^gt_[0-9a-f]{16}$/);
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

    const clone = makeTempDir("git-trails-clone-");
    git(repo, ["clone", repo, clone]);

    expect(JSON.stringify(digestCommit({ cwd: repo, commit }))).toBe(
      JSON.stringify(digestCommit({ cwd: clone, commit }))
    );
  });

  test("canonical digests ignore ambient diff ordering and attributes", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "a.txt"), "alpha\nmove this line\n");
    writeFileSync(join(repo, "z.txt"), "zeta\n");
    commitAll(repo, "base");
    writeFileSync(join(repo, "a.txt"), "alpha\n");
    writeFileSync(join(repo, "z.txt"), "zeta\nmove this line\nchanged\n");
    const commit = commitAll(repo, "move and change");

    const firstClone = makeTempDir("git-trails-config-first-");
    const secondClone = makeTempDir("git-trails-config-second-");
    git(repo, ["clone", repo, firstClone]);
    git(repo, ["clone", repo, secondClone]);

    const firstOrder = join(firstClone, ".git", "diff-order");
    const secondOrder = join(secondClone, ".git", "diff-order");
    const firstAttributes = join(firstClone, ".git", "global-attributes");
    const secondAttributes = join(secondClone, ".git", "global-attributes");
    writeFileSync(firstOrder, "z.txt\na.txt\n");
    writeFileSync(secondOrder, "a.txt\nz.txt\n");
    writeFileSync(firstAttributes, "*.txt binary\n");
    writeFileSync(secondAttributes, "*.txt text\n");
    git(firstClone, ["config", "diff.orderFile", firstOrder]);
    git(secondClone, ["config", "diff.orderFile", secondOrder]);
    git(firstClone, ["config", "core.attributesFile", firstAttributes]);
    git(secondClone, ["config", "core.attributesFile", secondAttributes]);

    const firstDigest = digestCommit({ cwd: firstClone, commit });
    const secondDigest = digestCommit({ cwd: secondClone, commit });
    expect(JSON.stringify(firstDigest)).toBe(JSON.stringify(secondDigest));
    expect(firstDigest.files.map((file) => file.path)).toEqual(["a.txt", "z.txt"]);
    expect(firstDigest.files.every((file) => file.binary === false)).toBe(true);
  });

  test("matches the canonical algorithm v3 golden digest", () => {
    const repo = makeRepo();
    git(repo, ["config", "core.autocrlf", "false"]);
    writeFileSync(join(repo, "a.txt"), "alpha\nmove this line\n");
    writeFileSync(join(repo, "binary.dat"), Buffer.from([0, 1, 2, 10]));
    writeFileSync(join(repo, "z.txt"), "zeta\n");
    const parent = commitCanonicalTree(repo, "canonical base", "2000-01-01T00:00:00Z");

    writeFileSync(join(repo, "a.txt"), "alpha\n");
    writeFileSync(join(repo, "binary.dat"), Buffer.from([0, 1, 3, 10]));
    writeFileSync(join(repo, "m.txt"), "move this line\nnew line\n");
    writeFileSync(join(repo, "z.txt"), "zeta\nchanged\n");
    const commit = commitCanonicalTree(repo, "canonical change", "2000-01-02T00:00:00Z", parent);

    const actual = `${JSON.stringify(digestCommit({ cwd: repo, commit }), null, 2)}\n`;
    const expected = readFileSync(
      join(import.meta.dir, "fixtures", "canonical", "digest-v4-algorithm-v3.json"),
      "utf8"
    );
    expect(actual).toBe(expected);
  });

  test("rejects SHA-256-format Git repositories", () => {
    const repo = makeTempDir("git-trails-sha256-");
    const init = spawnSync("git", ["init", "--object-format=sha256"], { cwd: repo, encoding: "utf8" });
    if (init.status !== 0) {
      return;
    }

    expect(() => digestCommit({ cwd: repo })).toThrow(/only supports sha1 Git object format/);
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
      deletions: 1
    });
    expect(digest.blocks.map((block) => block.kind).sort()).toEqual(["delete", "insert"]);
  });

  test("keeps replacement insertions when their anchors are also deleted", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "file.txt"), "before\nold\nafter\n");
    commitAll(repo, "base");

    writeFileSync(join(repo, "file.txt"), "before\nnew\nafter\n");
    const commit = commitAll(repo, "replace line");

    const digest = digestCommit({ cwd: repo, commit });
    const insert = digest.blocks.find((block) => block.kind === "insert");
    expect(insert?.payload_text).toBe("new\n");
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

  test("keeps duplicate identical lines in one exact moved block", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "old.ts"), "function unique() {\nrepeat();\nrepeat();\n}\n");
    commitAll(repo, "base");

    git(repo, ["rm", "old.ts"]);
    writeFileSync(join(repo, "new.ts"), "function unique() {\nrepeat();\nrepeat();\n}\n");
    const commit = commitAll(repo, "move duplicate lines");

    const digest = digestCommit({ cwd: repo, commit });
    expect(digest.summary.moves).toBe(1);
    expect(digest.blocks[0]).toMatchObject({
      kind: "move",
      payload_text: "function unique() {\nrepeat();\nrepeat();\n}\n",
      src: { path: "old.ts", start_line: 1, end_line: 4 },
      dst: { path: "new.ts", start_line: 1, end_line: 4 }
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
      dst: { path: "new.txt", start_line: 1, end_line: 2 }
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
      dst: { path: "new.txt", start_line: 1, end_line: 3 }
    });
    expect(digest.identity[0]).toMatchObject({
      kind: "renamed",
      confidence: "exact"
    });
    expect(verifyCommit({ cwd: repo, commit }).ok).toBe(true);
  });

  test("uses dominant path identity to pair exact leftover blocks", () => {
    const repo = makeRepo();
    writeFileSync(
      join(repo, "a.txt"),
      "alpha unique()\nx=1\ny=2\nz=3\nbeta unique()\nstay put()\n"
    );
    commitAll(repo, "base");

    writeFileSync(join(repo, "a.txt"), "stay put()\n");
    writeFileSync(
      join(repo, "b.txt"),
      "alpha unique()\nbeta unique()\nx=1\ny=2\nz=3\n"
    );
    const commit = commitAll(repo, "move dominant path with reordered short block");

    const digest = digestCommit({ cwd: repo, commit });
    const shortBlock = digest.blocks.find((block) => block.kind === "move" && block.payload_text === "x=1\ny=2\nz=3\n");
    expect(shortBlock).toMatchObject({
      src: { path: "a.txt", start_line: 2, end_line: 4 },
      dst: { path: "b.txt", start_line: 3, end_line: 5 }
    });
    expect(verifyCommit({ cwd: repo, commit }).ok).toBe(true);
  });

  test("leaves weak one-line duplicate leftovers as insert and delete blocks", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "a.txt"), "alpha()\ncommon call\nleft only\n");
    writeFileSync(join(repo, "b.txt"), "beta()\ncommon call\n");
    commitAll(repo, "base");

    writeFileSync(join(repo, "a.txt"), "alpha()\nleft only\n");
    writeFileSync(join(repo, "b.txt"), "beta()\ncommon call\ncommon call\n");
    const commit = commitAll(repo, "shuffle common one line");

    const digest = digestCommit({ cwd: repo, commit });
    expect(digest.summary.moves).toBe(0);
    expect(digest.summary.insertions).toBe(1);
    expect(digest.summary.deletions).toBe(1);
    expect(verifyCommit({ cwd: repo, commit }).ok).toBe(true);
  });

  test("records chmod-only changes as unsupported file metadata with no line blocks", () => {
    if (process.platform === "win32") {
      return;
    }
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

  test("represents content changes even when file mode also changes", () => {
    if (process.platform === "win32") {
      return;
    }
    const repo = makeRepo();
    git(repo, ["config", "core.filemode", "true"]);
    const script = join(repo, "script.sh");
    writeFileSync(script, "echo hi\n");
    commitAll(repo, "base");

    chmodSync(script, 0o755);
    writeFileSync(script, "echo hi\necho bye\n");
    const commit = commitAll(repo, "chmod and edit script");

    const digest = digestCommit({ cwd: repo, commit });
    expect(digest.files[0]).toMatchObject({
      path: "script.sh",
      old_mode: "100644",
      new_mode: "100755",
      line_digest_status: "represented"
    });
    expect(digest.files[0].unsupported_reason).toBeUndefined();
    expect(digest.summary.insertions).toBe(1);
    expect(verifyCommit({ cwd: repo, commit }).ok).toBe(true);
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
    expect(verifyCommit({ cwd: repo, commit }).ok).toBe(true);
  });

  test("rejects changed Git paths that are not valid UTF-8", () => {
    if (process.platform === "win32") {
      return;
    }
    const repo = makeRepo();
    const rawPath = Buffer.concat([
      Buffer.from(`${repo}/bad-`, "utf8"),
      Buffer.from([0xff]),
      Buffer.from(".txt", "utf8")
    ]);
    writeFileSync(rawPath, "content\n");
    const commit = commitAll(repo, "non-utf8 path");

    expect(() => digestCommit({ cwd: repo, commit })).toThrow(
      /does not support non-UTF-8 Git paths \(raw bytes: 6261642dff2e747874\)/
    );
  });

  test("keeps same-file reorders with duplicate lines verifiable", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "file.ts"), "function alpha() {}\nrepeat();\nfunction bravo() {}\nrepeat();\n");
    commitAll(repo, "base");

    writeFileSync(join(repo, "file.ts"), "function bravo() {}\nrepeat();\nfunction alpha() {}\nrepeat();\n");
    const commit = commitAll(repo, "reorder duplicate blocks");

    const digest = digestCommit({ cwd: repo, commit });
    expect(digest.summary.moves).toBeGreaterThan(0);
    expect(digest.blocks.every((block) => block.id.startsWith("gt_"))).toBe(true);
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
      old_lines: 0,
      new_lines: 0,
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
    expect(digest.files.map((file) => [
      file.path,
      file.line_digest_status,
      file.unsupported_reason,
      file.old_lines,
      file.new_lines
    ]).sort()).toEqual([
      ["new.bin", "unsupported", "binary", 0, 0],
      ["old.bin", "unsupported", "binary", 0, 0]
    ]);
    expect(verifyCommit({ cwd: repo, commit }).ok).toBe(true);
  });
});
