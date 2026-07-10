import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "bun:test";
import Ajv from "ajv/dist/2020";
import { renderContent } from "../src/content";
import { digestCommit } from "../src/digest";
import { listCommits } from "../src/git";
import { renderIdentity, renderIdentityFrom, renderIdentityTo } from "../src/identity-view";
import { validateDigest } from "../src/index";
import { schemaVersion } from "../src/types";
import { verifyCommit, verifyDigest } from "../src/verify";

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "git-trails-"));
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

interface GeneratedFile {
  content: Buffer;
  executable?: boolean;
}

function writeRepoFile(repo: string, path: string, file: GeneratedFile): void {
  const fullPath = join(repo, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, file.content);
  if (file.executable === true) {
    chmodSync(fullPath, 0o755);
  }
}

function applyFiles(repo: string, files: Record<string, GeneratedFile>): void {
  for (const [path, file] of Object.entries(files)) {
    writeRepoFile(repo, path, file);
  }
}

function replaceFiles(repo: string, oldFiles: Record<string, GeneratedFile>, newFiles: Record<string, GeneratedFile>): void {
  for (const path of Object.keys(oldFiles)) {
    if (!(path in newFiles)) {
      rmSync(join(repo, path), { force: true });
    }
  }
  applyFiles(repo, newFiles);
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function shuffled<T>(values: T[], random: () => number): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function textFile(lines: string[], options: { finalNewline?: boolean; executable?: boolean } = {}): GeneratedFile {
  let text = lines.join("");
  if (options.finalNewline === false && text.endsWith("\n")) {
    text = text.slice(0, -1);
  }
  return { content: Buffer.from(text, "utf8"), executable: options.executable };
}

function mixedTextFile(prefix: string, seed: number): GeneratedFile {
  return {
    content: Buffer.concat([
      Buffer.from(`${prefix} start ${seed}\n`, "utf8"),
      Buffer.from([0xff, 0xfe, 0x0a]),
      Buffer.from(`${prefix} end ${seed}\n`, "utf8")
    ])
  };
}

function generatedLines(seed: number, name: string, count: number, random: () => number): string[] {
  const repeated = [
    "repeat();\n",
    "repeat();\n",
    "\n",
    "}\n",
    "{\n",
    "x=1\n",
    "case shared:\n",
    "return value;\n"
  ];
  const lines: string[] = [];
  for (let index = 0; index < count; index += 1) {
    if (index % 5 === 0) {
      lines.push(`${name}_unique_${seed}_${index}();\n`);
      continue;
    }
    lines.push(repeated[Math.floor(random() * repeated.length)]);
  }
  return lines;
}

function generatedCommitCase(seed: number): {
  oldFiles: Record<string, GeneratedFile>;
  newFiles: Record<string, GeneratedFile>;
} {
  const random = seededRandom(seed);
  const oldA = generatedLines(seed, "a", 24, random);
  const oldB = generatedLines(seed, "b", 20, random);
  const oldLarge = generatedLines(seed, "large", 140, random);
  const split = generatedLines(seed, "split", 18, random);
  const mergeOne = generatedLines(seed, "merge_one", 12, random);
  const mergeTwo = generatedLines(seed, "merge_two", 12, random);

  const oldFiles: Record<string, GeneratedFile> = {
    "a.ts": textFile(oldA),
    "b.ts": textFile(oldB),
    "large.txt": textFile(oldLarge),
    "script.sh": textFile(["echo base\n"], { executable: false }),
    "split.ts": textFile(split),
    "merge-one.ts": textFile(mergeOne),
    "merge-two.ts": textFile(mergeTwo),
    [`unicode-${seed}-é.txt`]: textFile([`héllo ${seed}\n`, "repeat();\n"], { finalNewline: seed % 2 === 0 }),
    "nonutf8.txt": mixedTextFile("old", seed)
  };

  const movedFromA = oldA.slice(2, 9);
  const reorderedA = shuffled(oldA.slice(9, 18), random);
  const reorderedB = shuffled(oldB.slice(3, 15), random);
  const largePrefix = oldLarge.slice(0, 20);
  const largeMiddle = oldLarge.slice(60, 95);
  const largeSuffix = oldLarge.slice(120);

  const newFiles: Record<string, GeneratedFile> = {
    "a.ts": textFile([
      `fresh_a_${seed}();\n`,
      ...reorderedA,
      "repeat();\n",
      "\n",
      "}\n"
    ], { finalNewline: seed % 3 !== 0 }),
    "b.ts": textFile([
      ...oldB.slice(0, 3),
      ...movedFromA,
      `fresh_b_${seed}();\n`,
      ...reorderedB
    ]),
    "large.txt": textFile([
      ...largePrefix,
      `large_insert_${seed}();\n`,
      ...largeSuffix,
      ...largeMiddle
    ]),
    "script.sh": textFile(["echo base\n", `echo changed ${seed}\n`], { executable: true }),
    "split-left.ts": textFile(split.slice(0, 9)),
    "split-right.ts": textFile(split.slice(9)),
    "merged.ts": textFile([...mergeTwo.slice(0, 6), ...mergeOne, ...mergeTwo.slice(6)]),
    [`unicode-${seed}-é.txt`]: textFile([`héllo ${seed}\n`, ...movedFromA.slice(0, 2), `fin ${seed}\n`], {
      finalNewline: seed % 2 !== 0
    }),
    "nonutf8.txt": {
      content: Buffer.concat([
        Buffer.from(`new start ${seed}\n`, "utf8"),
        Buffer.from([0xfa, 0xfb, 0x0a]),
        Buffer.from(`new end ${seed}`, "utf8")
      ])
    }
  };

  return { oldFiles, newFiles };
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
    expect(digest.schema_version).toBe("git-trails.digest.v4");
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

    const clone = mkdtempSync(join(tmpdir(), "git-trails-clone-"));
    git(tmpdir(), ["clone", repo, clone]);

    expect(JSON.stringify(digestCommit({ cwd: repo, commit }))).toBe(
      JSON.stringify(digestCommit({ cwd: clone, commit }))
    );
  });

  test("rejects SHA-256-format Git repositories", () => {
    const repo = mkdtempSync(join(tmpdir(), "git-trails-sha256-"));
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
      confidence: "exact"
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

  test("reports partial confidence when a move is not whole-file", () => {
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
      old_identity: { path: "a.ts", lines: 4 },
      moved_to: { path: "b.ts", lines_moved: 3 },
      new_identity: null,
      confidence: "partial"
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
    expect(renderIdentityFrom(digest)).toBe("from a.ts:3 => b.ts (1/3, 33.3%), unmoved (2/3, 66.7%)\n");
    expect(renderIdentityFrom(digest, { pretty: true })).toBe(
      "a.ts:3  ->  b.ts     (1/3, 33.3%)\n" +
      "            unmoved  (2/3, 66.7%)\n"
    );
    expect(renderIdentityTo(digest)).toBe("to b.ts:2 <= a.ts (1/2, 50%), new (1/2, 50%)\n");
    expect(renderIdentityTo(digest, { pretty: true })).toBe(
      "b.ts:2  <-  a.ts  (1/2, 50%)\n" +
      "            new   (1/2, 50%)\n"
    );
  });

  test("summarizes new-file identity makeup", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "a.ts"), "part one()\npart two()\n");
    writeFileSync(join(repo, "b.ts"), "part three()\npart four()\n");
    commitAll(repo, "base");

    git(repo, ["rm", "a.ts"]);
    git(repo, ["rm", "b.ts"]);
    writeFileSync(join(repo, "c.ts"), "part one()\npart two()\npart three()\npart four()\n");
    const mergeCommit = commitAll(repo, "merge files");

    const mergeDigest = digestCommit({ cwd: repo, commit: mergeCommit });
    expect(renderIdentityFrom(mergeDigest)).toBe(
      "from a.ts:2 => c.ts (2/2, 100%)\n" +
      "from b.ts:2 => c.ts (2/2, 100%)\n"
    );
    expect(renderIdentityTo(mergeDigest)).toBe("to c.ts:4 <= a.ts (2/4, 50%), b.ts (2/4, 50%)\n");

    git(repo, ["rm", "c.ts"]);
    writeFileSync(join(repo, "d.ts"), "part one()\npart two()\n");
    writeFileSync(join(repo, "e.ts"), "part three()\npart four()\n");
    const splitCommit = commitAll(repo, "split file");

    const splitDigest = digestCommit({ cwd: repo, commit: splitCommit });
    expect(renderIdentityFrom(splitDigest)).toBe("from c.ts:4 => d.ts (2/4, 50%), e.ts (2/4, 50%)\n");
    expect(renderIdentityTo(splitDigest)).toBe(
      "to d.ts:2 <= c.ts (2/2, 100%)\n" +
      "to e.ts:2 <= c.ts (2/2, 100%)\n"
    );
  });
});

describe("renderContent", () => {
  test("renders compact content op lines", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "a.ts"), "export function first() {}\nexport function second() {}\nexport function third() {}\n");
    commitAll(repo, "base");

    writeFileSync(join(repo, "b.ts"), "export function first() {}\nexport function second() {}\nexport function third() {}\n");
    writeFileSync(join(repo, "a.ts"), "export const replacement = true;\nexport const fresh = 1;\n");
    const commit = commitAll(repo, "cut-paste with name reuse");

    const lines = renderContent(digestCommit({ cwd: repo, commit })).trimEnd().split("\n");
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

  test("generated hard commits verify, validate, and digest deterministically across paths", () => {
    const schema = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "schema", `${schemaVersion}.schema.json`), "utf8")
    );
    const ajv = new Ajv({ strict: false, allErrors: true });
    const validate = ajv.compile(schema);

    for (let seed = 1; seed <= 12; seed += 1) {
      const repo = makeRepo();
      git(repo, ["config", "core.filemode", "true"]);
      const generated = generatedCommitCase(seed);
      applyFiles(repo, generated.oldFiles);
      commitAll(repo, `generated base ${seed}`);

      replaceFiles(repo, generated.oldFiles, generated.newFiles);
      const commit = commitAll(repo, `generated change ${seed}`);

      const digest = digestCommit({ cwd: repo, commit });
      const verifyResult = verifyCommit({ cwd: repo, commit });
      expect(verifyResult.files.filter((file) => !file.ok)).toEqual([]);
      expect(validate(digest)).toBe(true);

      const clone = mkdtempSync(join(tmpdir(), "git-trails-fuzz-clone-"));
      git(tmpdir(), ["clone", repo, clone]);
      expect(JSON.stringify(digestCommit({ cwd: clone, commit }))).toBe(JSON.stringify(digest));
    }
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

  test("validateDigest reports schema failures before saved digest verification", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "file.txt"), "base\n");
    commitAll(repo, "base");
    writeFileSync(join(repo, "file.txt"), "base\nnext\n");
    const commit = commitAll(repo, "add line");
    const digest = digestCommit({ cwd: repo, commit });

    expect(validateDigest(digest)).toEqual({ ok: true, errors: [] });

    const malformed: Record<string, unknown> = { ...digest };
    delete malformed.blocks;
    const validation = validateDigest(malformed);
    expect(validation.ok).toBe(false);
    expect(validation.errors).toContainEqual(expect.objectContaining({
      path: "/",
      keyword: "required",
      message: expect.stringContaining("blocks")
    }));

    const result = verifyDigest({ cwd: repo, digest: malformed });
    expect(result).toMatchObject({
      commit,
      ok: false,
      files: [
        {
          path: "<digest>",
          ok: false,
          reason: expect.stringContaining("schema validation failed")
        }
      ]
    });
  });
});

describe("cli", () => {
  test("supports --cwd for digesting another repository", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "file.txt"), "base\n");
    commitAll(repo, "base");
    writeFileSync(join(repo, "file.txt"), "base\nnext\n");
    const commit = commitAll(repo, "add line");

    const result = cli(["view", commit, "--cwd", repo]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^\+ file\.txt:2\+1$/m);
  });

  test("prints pairwise identity flows", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "old.txt"), "alpha\nbeta\n");
    commitAll(repo, "base");

    git(repo, ["rm", "old.txt"]);
    writeFileSync(join(repo, "new.txt"), "alpha\nbeta\ngamma\n");
    const commit = commitAll(repo, "rename without git mv");

    const result = cli(["view", commit, "--cwd", repo, "--view", "identity"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("old.txt:2 -> new.txt:3 (2)\n");

    const alias = cli(["view", commit, "--cwd", repo, "--identity"]);
    expect(alias.status).toBe(0);
    expect(alias.stdout).toBe(result.stdout);

    const from = cli(["view", commit, "--cwd", repo, "--view", "identity-from"]);
    expect(from.status).toBe(0);
    expect(from.stdout).toBe("old.txt:2  ->  new.txt  (2/2, 100%)\n");

    const to = cli(["view", commit, "--cwd", repo, "--view", "identity-to"]);
    expect(to.status).toBe(0);
    expect(to.stdout).toBe("new.txt:3  <-  old.txt  (2/3, 66.7%)\n");

    const toAlias = cli(["view", commit, "--cwd", repo, "--identity-to"]);
    expect(toAlias.status).toBe(0);
    expect(toAlias.stdout).toBe(to.stdout);
  });

  test("prints empty identity view messages", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "file.txt"), "one\n");
    commitAll(repo, "base");
    writeFileSync(join(repo, "file.txt"), "one\ntwo\n");
    const commit = commitAll(repo, "add line");

    const identity = cli(["view", commit, "--cwd", repo, "--identity"]);
    expect(identity.status).toBe(0);
    expect(identity.stdout).toBe("no cross-path identity flows\n");

    const from = cli(["view", commit, "--cwd", repo, "--identity-from"]);
    expect(from.status).toBe(0);
    expect(from.stdout).toBe("no cross-path identity sources\n");

    const to = cli(["view", commit, "--cwd", repo, "--identity-to"]);
    expect(to.status).toBe(0);
    expect(to.stdout).toBe("no cross-path identity destinations\n");
  });

  test("supports pointing --cwd at a .git directory", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "file.txt"), "one\n");
    commitAll(repo, "one");
    writeFileSync(join(repo, "file.txt"), "one\ntwo\n");
    const commit = commitAll(repo, "two");
    const gitDir = join(repo, ".git");

    const worktreeResult = cli(["view", commit, "--cwd", repo]);
    expect(worktreeResult.status).toBe(0);
    expect(existsSync(join(repo, ".git-trails", "index.json"))).toBe(true);
    expect(existsSync(join(gitDir, ".bgit_cache"))).toBe(false);

    const result = cli(["view", commit, "--cwd", gitDir]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("+ file.txt:2+1\n");
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
    expect(digest.schema_version).toBe("git-trails.digest.v4");
  });

  test("builds the cache by default and supports --no-cache", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "file.txt"), "one\n");
    commitAll(repo, "one");
    writeFileSync(join(repo, "file.txt"), "one\ntwo\n");
    const commit = commitAll(repo, "two");
    const root = join(repo, ".git-trails");

    const uncached = cli(["view", commit, "--cwd", repo, "--no-cache"]);
    expect(uncached.status).toBe(0);
    expect(existsSync(root)).toBe(false);

    const cached = cli(["view", commit, "--cwd", repo]);
    expect(cached.status).toBe(0);
    expect(existsSync(join(root, "index.json"))).toBe(true);
    expect(existsSync(join(root, "digests", `${commit}.json`))).toBe(true);

    const view = cli(["cache", "--range", `${commit}^..${commit}`, "--cwd", repo, "--format", "json"]);
    expect(view.status).toBe(0);
    expect(JSON.parse(view.stdout)).toMatchObject({
      summary: { tracked: 1, digested: 1, undigested: 0, skipped: 0 }
    });
  });

  test("reports cache state and lets digest ranges warm the cache", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "file.txt"), "one\n");
    const first = commitAll(repo, "one");
    writeFileSync(join(repo, "file.txt"), "one\ntwo\n");
    const second = commitAll(repo, "two");

    const tracked = cli(["cache", "--range", `${first}..${second}`, "--cwd", repo, "--format", "json"]);
    expect(tracked.status).toBe(0);
    expect(JSON.parse(tracked.stdout)).toMatchObject({
      schema_version: "git-trails.commit-store.v2",
      summary: { tracked: 1, digested: 0, undigested: 1, skipped: 0 },
      commits: [{ commit: second, status: "undigested" }]
    });

    const root = join(repo, ".git-trails");
    expect(existsSync(join(root, "index.json"))).toBe(true);

    const warmed = cli(["digest", "--range", `${first}..${second}`, "--cwd", repo, "--format", "jsonl"]);
    expect(warmed.status).toBe(0);
    expect(warmed.stdout.trim().split("\n")).toHaveLength(1);
    expect(existsSync(join(root, "digests", `${second}.json`))).toBe(true);

    const cached = cli(["cache", "--range", `${first}..${second}`, "--cwd", repo, "--format", "json"]);
    expect(cached.status).toBe(0);
    expect(JSON.parse(cached.stdout)).toMatchObject({
      summary: { tracked: 1, digested: 1, undigested: 0, skipped: 0 },
      commits: [{ commit: second, status: "digested" }]
    });

    const text = cli(["cache", "--range", `${first}..${second}`, "--cwd", repo]);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain("tracked 1 commits (digested 1, undigested 0, invalid 0, skipped 0)");
    expect(text.stdout).toContain(`D ${second.slice(0, 12)} ${first.slice(0, 12)}`);
  });

  test("ignores and overwrites cached digests that do not match the requested commit info", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "file.txt"), "one\n");
    const first = commitAll(repo, "one");
    writeFileSync(join(repo, "file.txt"), "one\ntwo\n");
    const second = commitAll(repo, "two");
    const root = join(repo, ".git-trails");

    const cached = cli(["digest", second, "--cwd", repo]);
    expect(cached.status).toBe(0);
    const original = JSON.parse(cached.stdout);
    expect(original.parent).toBe(first);

    const digestPath = join(root, "digests", `${second}.json`);
    const poisoned = { ...original, parent: "0".repeat(40) };
    writeFileSync(digestPath, `${JSON.stringify(poisoned)}\n`);

    const status = cli(["cache", "--range", `${first}..${second}`, "--cwd", repo, "--format", "json"]);
    expect(status.status).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      summary: { tracked: 1, digested: 0, undigested: 0, invalid: 1, skipped: 0 },
      commits: [{ commit: second, status: "invalid", reason: "incompatible_digest" }]
    });

    const repaired = cli(["digest", second, "--cwd", repo]);
    expect(repaired.status).toBe(0);
    expect(JSON.parse(repaired.stdout)).toMatchObject({ commit: second, parent: first });
    expect(JSON.parse(readFileSync(digestPath, "utf8"))).toMatchObject({ commit: second, parent: first });
  });

  test("reports malformed store files and repairs them on the next digest", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "file.txt"), "one\n");
    const first = commitAll(repo, "one");
    writeFileSync(join(repo, "file.txt"), "one\ntwo\n");
    const second = commitAll(repo, "two");
    const root = join(repo, ".git-trails");

    expect(cli(["digest", second, "--cwd", repo]).status).toBe(0);
    writeFileSync(join(root, "index.json"), JSON.stringify({
      schema_version: "git-trails.commit-store.v1",
      commits: {}
    }));

    const upgradedIndex = cli(["cache", "--range", `${first}..${second}`, "--cwd", repo, "--format", "json"]);
    expect(upgradedIndex.status).toBe(0);
    expect(JSON.parse(upgradedIndex.stdout).schema_version).toBe("git-trails.commit-store.v2");

    writeFileSync(join(root, "index.json"), "{\n");
    writeFileSync(join(root, "index.lock"), "999999999\n");

    const rebuiltIndex = cli(["cache", "--range", `${first}..${second}`, "--cwd", repo, "--format", "json"]);
    expect(rebuiltIndex.status).toBe(0);
    expect(JSON.parse(readFileSync(join(root, "index.json"), "utf8"))).toMatchObject({
      schema_version: "git-trails.commit-store.v2",
      commits: { [second]: { commit: second, parents: [first] } }
    });

    const digestPath = join(root, "digests", `${second}.json`);
    writeFileSync(digestPath, "{\n");
    writeFileSync(`${digestPath}.interrupted.tmp`, "partial");

    const invalid = cli(["cache", "--range", `${first}..${second}`, "--cwd", repo, "--format", "json"]);
    expect(invalid.status).toBe(0);
    expect(JSON.parse(invalid.stdout)).toMatchObject({
      summary: { tracked: 1, digested: 0, undigested: 0, invalid: 1, skipped: 0 },
      commits: [{ commit: second, status: "invalid", reason: "malformed_digest" }]
    });

    const verification = cli(["cache", "verify", "--range", `${first}..${second}`, "--cwd", repo, "--format", "json"]);
    expect(verification.status).toBe(1);
    expect(JSON.parse(verification.stdout)).toMatchObject({
      summary: { checked: 1, ok: 0, failed: 1, missing: 0, skipped: 0 },
      results: [{ commit: second, ok: false }]
    });

    const repaired = cli(["digest", second, "--cwd", repo]);
    expect(repaired.status).toBe(0);
    expect(JSON.parse(readFileSync(digestPath, "utf8"))).toMatchObject({ commit: second, parent: first });
  });

  test("preserves every index update from concurrent digest writers", async () => {
    const repo = makeRepo();
    const commits: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      writeFileSync(join(repo, "file.txt"), `${index}\n`);
      commits.push(commitAll(repo, `commit ${index}`));
    }

    const executable = join(import.meta.dir, "..", "src", "cli.ts");
    const processes = commits.map((commit) => Bun.spawn(
      ["bun", executable, "digest", commit, "--cwd", repo],
      { stdout: "ignore", stderr: "pipe" }
    ));
    const statuses = await Promise.all(processes.map((process) => process.exited));
    expect(statuses).toEqual(commits.map(() => 0));

    const index = JSON.parse(readFileSync(
      join(repo, ".git-trails", "index.json"),
      "utf8"
    ));
    expect(index.schema_version).toBe("git-trails.commit-store.v2");
    expect(Object.keys(index.commits).sort()).toEqual([...commits].sort());
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

    const noCacheStoreCommand = cli(["cache", "--no-cache", "--cwd", repo]);
    expect(noCacheStoreCommand.status).toBe(1);
    expect(noCacheStoreCommand.stderr).toContain("cache does not support --no-cache");
  });

  test("rejects removed commands and invalid view options", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "file.txt"), "one\n");
    const first = commitAll(repo, "one");
    writeFileSync(join(repo, "file.txt"), "one\ntwo\n");
    const second = commitAll(repo, "two");

    const content = cli(["content", second, "--cwd", repo]);
    expect(content.status).toBe(1);
    expect(content.stderr).toContain("unknown command: content");

    const identity = cli(["identity", second, "--cwd", repo]);
    expect(identity.status).toBe(1);
    expect(identity.stderr).toContain("unknown command: identity");

    const commits = cli(["commits", "--range", `${first}..${second}`, "--cwd", repo]);
    expect(commits.status).toBe(1);
    expect(commits.stderr).toContain("unknown command: commits");

    const verify = cli(["verify", second, "--cwd", repo]);
    expect(verify.status).toBe(1);
    expect(verify.stderr).toContain("unknown command: verify");

    const digestRange = cli(["digest", "--range", `${first}..${second}`, "--cwd", repo, "--format", "jsonl", "--pretty"]);
    expect(digestRange.status).toBe(1);
    expect(digestRange.stderr).toContain("unknown option: --pretty");

    const digestJsonl = cli(["digest", second, "--cwd", repo, "--format", "jsonl", "--pretty"]);
    expect(digestJsonl.status).toBe(1);
    expect(digestJsonl.stderr).toContain("unknown option: --pretty");

    const viewRange = cli(["view", "--range", `${first}..${second}`, "--cwd", repo, "--format", "jsonl"]);
    expect(viewRange.status).toBe(1);
    expect(viewRange.stderr).toContain("view does not support --range");

    const removedView = cli(["view", second, "--cwd", repo, "--view", "coupling", "--format", "jsonl"]);
    expect(removedView.status).toBe(1);
    expect(removedView.stderr).toContain("unknown view: coupling");

    const removedFlag = cli(["view", second, "--cwd", repo, "--coupling"]);
    expect(removedFlag.status).toBe(1);
    expect(removedFlag.stderr).toContain("unknown option: --coupling");

    const cacheVerify = cli(["cache", "verify", "--cwd", repo, "--pretty"]);
    expect(cacheVerify.status).toBe(1);
    expect(cacheVerify.stderr).toContain("unknown option: --pretty");
  });

  test("verifies cached digests against their referenced commits", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "file.txt"), "base\n");
    const first = commitAll(repo, "base");
    writeFileSync(join(repo, "file.txt"), "base\nnext\n");
    const commit = commitAll(repo, "add line");

    const missing = cli(["cache", "verify", "--range", `${first}..${commit}`, "--cwd", repo, "--format", "json"]);
    expect(missing.status).toBe(0);
    expect(JSON.parse(missing.stdout)).toMatchObject({
      schema_version: "git-trails.cache-verify.v1",
      summary: { checked: 0, ok: 0, failed: 0, missing: 1, skipped: 0 },
      results: []
    });

    const warmed = cli(["digest", commit, "--cwd", repo]);
    expect(warmed.status).toBe(0);

    const ok = cli(["cache", "verify", "--range", `${first}..${commit}`, "--cwd", repo]);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain(`ok ${commit.slice(0, 12)}`);
    expect(ok.stdout).toContain("verified 1/1 cached commits");

    const okJson = cli(["cache", "verify", "--range", `${first}..${commit}`, "--cwd", repo, "--format", "json"]);
    expect(okJson.status).toBe(0);
    expect(JSON.parse(okJson.stdout)).toMatchObject({
      schema_version: "git-trails.cache-verify.v1",
      summary: { checked: 1, ok: 1, failed: 0, missing: 0, skipped: 0 },
      results: [{ commit, ok: true }]
    });

    const digestPath = join(repo, ".git-trails", "digests", `${commit}.json`);
    const tampered = JSON.parse(readFileSync(digestPath, "utf8"));
    tampered.blocks[0].payload_sha256 = "0".repeat(64);
    writeFileSync(digestPath, JSON.stringify(tampered));

    const fail = cli(["cache", "verify", "--range", `${first}..${commit}`, "--cwd", repo]);
    expect(fail.status).toBe(1);
    expect(fail.stdout).toContain("payload_sha256");
  });

  test("ships a JSON schema for the canonical digest", () => {
    const schemaFileName = `${schemaVersion}.schema.json`;
    const schemaPath = join(import.meta.dir, "..", "schema", schemaFileName);
    expect(existsSync(schemaPath)).toBe(true);

    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    expect(schema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: expect.stringContaining(schemaFileName),
      properties: {
        schema_version: { const: schemaVersion },
        algorithm: { $ref: "#/$defs/algorithm" },
        symbols: { type: "array" }
      }
    });
  });
});

describe("digest schema", () => {
  test("generated digests validate against the shipped schema", () => {
    const schema = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "schema", "git-trails.digest.v4.schema.json"), "utf8")
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
