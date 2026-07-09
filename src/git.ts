import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const gitlinkMode = "160000";

export interface CommitInfo {
  repo: string;
  commit: string;
  parent: string | null;
  diffBase: string;
}

export interface CommitGraphInfo {
  repo: string;
  commit: string;
  parents: string[];
}

export interface FilePair {
  path: string;
  status: string;
  oldMode: string | null;
  newMode: string | null;
  oldOid: string | null;
  newOid: string | null;
  oldExists: boolean;
  newExists: boolean;
  oldBytes: Buffer | null;
  newBytes: Buffer | null;
  diff: string;
  gitBinary: boolean;
  unparsedDiff: boolean;
}

interface RawEntry {
  oldMode: string;
  newMode: string;
  oldSha: string;
  newSha: string;
  status: string;
  path: string;
}

export function getCommitInfo(cwd: string, commitish: string): CommitInfo {
  const repo = resolveRepoCwd(cwd);
  assertSha1ObjectFormat(repo);
  const commit = gitText(repo, ["rev-parse", "--verify", `${commitish}^{commit}`]).trim();
  const revLine = gitText(repo, ["rev-list", "--parents", "-n", "1", commit]).trim();
  const [, ...parents] = revLine.split(/\s+/);

  if (parents.length > 1) {
    throw new Error(`blockcommit only supports single-parent commits; ${commit} has ${parents.length} parents`);
  }

  return {
    repo,
    commit,
    parent: parents[0] ?? null,
    diffBase: parents[0] ?? emptyTree
  };
}

export function tryResolveCommit(cwd: string, commitish: string): string | null {
  const repo = tryResolveRepoCwd(cwd) ?? cwd;
  const result = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${commitish}^{commit}`], {
    cwd: repo,
    encoding: "utf8"
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

// Resolves the repo and every commit's parent in two git calls total, so
// range walks don't pay per-commit rev-parse/rev-list spawns.
export function listCommitInfos(cwd: string, range: string): CommitInfo[] {
  const repo = resolveRepoCwd(cwd);
  assertSha1ObjectFormat(repo);
  return gitText(repo, ["rev-list", "--no-merges", "--reverse", "--parents", range])
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [commit, ...parents] = line.split(/\s+/);
      return { repo, commit, parent: parents[0] ?? null, diffBase: parents[0] ?? emptyTree };
    });
}

export function listCommitGraphInfos(cwd: string, range: string): CommitGraphInfo[] {
  const repo = resolveRepoCwd(cwd);
  assertSha1ObjectFormat(repo);
  return gitText(repo, ["rev-list", "--reverse", "--parents", range])
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [commit, ...parents] = line.split(/\s+/);
      return { repo, commit, parents };
    });
}

export function resolveRepoCacheCwd(cwd: string): string {
  const repo = resolveRepoCwd(cwd);
  assertSha1ObjectFormat(repo);
  return repo;
}

function resolveRepoCwd(cwd: string): string {
  const repo = tryResolveRepoCwd(cwd);
  if (repo !== null) {
    return repo;
  }
  return ensureBgitCache(resolve(gitText(cwd, ["rev-parse", "--absolute-git-dir"]).trim()));
}

function tryResolveRepoCwd(cwd: string): string | null {
  const direct = spawnSync("git", ["rev-parse", "--absolute-git-dir"], {
    cwd,
    encoding: "utf8"
  });
  if (direct.status === 0) {
    return ensureBgitCache(resolve(direct.stdout.trim()));
  }

  const gitDir = resolve(cwd);
  if (!isPointedGitDir(gitDir)) {
    return null;
  }
  return ensureBgitCache(gitDir);
}

function isPointedGitDir(path: string): boolean {
  if (!existsSync(path)) {
    return false;
  }
  const gitDir = spawnSync("git", ["rev-parse", "--git-dir"], {
    cwd: path,
    encoding: "utf8"
  });
  if (gitDir.status !== 0 || gitDir.stdout.trim() !== ".") {
    return false;
  }
  const bare = spawnSync("git", ["rev-parse", "--is-bare-repository"], {
    cwd: path,
    encoding: "utf8"
  });
  return bare.status === 0 && bare.stdout.trim() === "false";
}

function ensureBgitCache(gitDir: string): string {
  const cache = resolve(gitDir, ".bgit_cache");
  mkdirSync(cache, { recursive: true });
  writeFileSync(resolve(cache, ".git"), `gitdir: ${gitDir}\n`);
  return cache;
}

function assertSha1ObjectFormat(repo: string): void {
  const objectFormat = gitText(repo, ["rev-parse", "--show-object-format"]).trim();
  if (objectFormat !== "sha1") {
    throw new Error(`blockcommit digest v3 only supports sha1 Git object format, got ${objectFormat}`);
  }
}

export function listCommits(cwd: string, range: string): string[] {
  return listCommitInfos(cwd, range).map((info) => info.commit);
}

export function readChangedFilePairs(info: CommitInfo): FilePair[] {
  const { entries, patch } = splitRawAndPatch(
    gitBuffer(info.repo, [
      "diff",
      "--raw",
      "--patch",
      "-z",
      "--no-renames",
      "--diff-algorithm=myers",
      "--no-indent-heuristic",
      "--full-index",
      "--abbrev=40",
      "--no-ext-diff",
      "--no-color",
      "--no-textconv",
      "--submodule=short",
      "--unified=0",
      info.diffBase,
      info.commit
    ])
  );
  const blobs = readBlobs(info.repo, collectBlobShas(entries));
  const sections = splitPatchSections(patch);

  const expectedSections = entries.reduce((count, entry) => count + patchSectionsFor(entry), 0);
  const parsedSections = sections.length === expectedSections;

  const pairs: FilePair[] = [];
  let sectionIndex = 0;
  for (const entry of entries) {
    const take = parsedSections ? patchSectionsFor(entry) : 0;
    const diff = parsedSections ? sections.slice(sectionIndex, sectionIndex + take).join("") : "";
    sectionIndex += take;

    const oldIsBlob = isBlobSide(entry.oldMode, entry.oldSha);
    const newIsBlob = isBlobSide(entry.newMode, entry.newSha);
    const oldExists = !isZeroOid(entry.oldSha);
    const newExists = !isZeroOid(entry.newSha);

    pairs.push({
      path: entry.path,
      status: entry.status,
      oldMode: oldExists ? entry.oldMode : null,
      newMode: newExists ? entry.newMode : null,
      oldOid: oldExists ? entry.oldSha : null,
      newOid: newExists ? entry.newSha : null,
      oldExists,
      newExists,
      oldBytes: oldIsBlob ? blobs.get(entry.oldSha) ?? null : null,
      newBytes: newIsBlob ? blobs.get(entry.newSha) ?? null : null,
      diff,
      gitBinary: /^Binary files /m.test(diff) || /^GIT binary patch/m.test(diff),
      unparsedDiff: !parsedSections
    });
  }

  return pairs;
}

function patchSectionsFor(entry: RawEntry): number {
  return entry.status === "T" ? 2 : 1;
}

function isBlobSide(mode: string, sha: string): boolean {
  return mode !== gitlinkMode && !isZeroOid(sha);
}

function isZeroOid(sha: string): boolean {
  return /^0+$/.test(sha);
}

function collectBlobShas(entries: RawEntry[]): string[] {
  const shas = new Set<string>();
  for (const entry of entries) {
    if (isBlobSide(entry.oldMode, entry.oldSha)) {
      shas.add(entry.oldSha);
    }
    if (isBlobSide(entry.newMode, entry.newSha)) {
      shas.add(entry.newSha);
    }
  }
  return [...shas];
}

// A combined `git diff --raw --patch -z` emits `:meta\0path\0` records, a
// lone NUL closing the raw section, then the patch text.
function splitRawAndPatch(output: Buffer): { entries: RawEntry[]; patch: string } {
  const entries: RawEntry[] = [];
  let cursor = 0;

  while (cursor < output.length && output[cursor] === 0x3a) {
    const metaEnd = output.indexOf(0, cursor);
    const pathEnd = metaEnd === -1 ? -1 : output.indexOf(0, metaEnd + 1);
    if (pathEnd === -1) {
      throw new Error("unexpected end of git diff --raw output");
    }
    const meta = output.subarray(cursor, metaEnd).toString("utf8");
    const [oldMode, newMode, oldSha, newSha, status] = meta.slice(1).split(" ");
    entries.push({
      oldMode,
      newMode,
      oldSha,
      newSha,
      status,
      path: output.subarray(metaEnd + 1, pathEnd).toString("utf8")
    });
    cursor = pathEnd + 1;
  }

  if (cursor < output.length && output[cursor] === 0) {
    cursor += 1;
  }
  return { entries, patch: output.subarray(cursor).toString("utf8") };
}

function splitPatchSections(patch: string): string[] {
  if (patch.length === 0) {
    return [];
  }

  const starts: number[] = [];
  const header = /^diff --git /gm;
  let match: RegExpExecArray | null;
  while ((match = header.exec(patch)) !== null) {
    starts.push(match.index);
  }
  if (starts.length === 0 || starts[0] !== 0) {
    throw new Error("unexpected git diff output: missing diff --git header");
  }

  return starts.map((start, index) => patch.slice(start, starts[index + 1] ?? patch.length));
}

function readBlobs(repo: string, shas: string[]): Map<string, Buffer> {
  const blobs = new Map<string, Buffer>();
  if (shas.length === 0) {
    return blobs;
  }

  const output = gitBuffer(repo, ["cat-file", "--batch"], shas.join("\n") + "\n");
  let cursor = 0;
  for (const sha of shas) {
    const newline = output.indexOf(0x0a, cursor);
    if (newline === -1) {
      throw new Error("unexpected end of git cat-file --batch output");
    }
    const header = output.subarray(cursor, newline).toString("utf8");
    cursor = newline + 1;
    const fields = header.split(" ");
    if (fields[1] === "missing") {
      throw new Error(`git object ${sha} is missing`);
    }
    const size = Number(fields[2]);
    if (!Number.isInteger(size) || size < 0) {
      throw new Error(`unexpected git cat-file header: ${header}`);
    }
    blobs.set(sha, Buffer.from(output.subarray(cursor, cursor + size)));
    cursor += size + 1;
  }

  return blobs;
}

function gitText(cwd: string, args: string[]): string {
  return gitBuffer(cwd, args).toString("utf8");
}

function gitBuffer(cwd: string, args: string[], input?: string): Buffer {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "buffer",
    input: input === undefined ? undefined : Buffer.from(input, "utf8"),
    maxBuffer: 1024 * 1024 * 1024
  });

  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : String(result.stderr);
    throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
  }

  return Buffer.from(result.stdout as Buffer);
}
