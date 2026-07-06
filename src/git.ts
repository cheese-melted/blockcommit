import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export interface CommitInfo {
  repo: string;
  commit: string;
  parent: string | null;
  diffBase: string;
}

export interface FilePair {
  path: string;
  oldBytes: Buffer | null;
  newBytes: Buffer | null;
  diff: string;
}

export function getCommitInfo(cwd: string, commitish: string): CommitInfo {
  const repo = gitText(cwd, ["rev-parse", "--show-toplevel"]).trim();
  const commit = gitText(repo, ["rev-parse", "--verify", `${commitish}^{commit}`]).trim();
  const revLine = gitText(repo, ["rev-list", "--parents", "-n", "1", commit]).trim();
  const [, ...parents] = revLine.split(/\s+/);

  if (parents.length > 1) {
    throw new Error(`blockcommit only supports single-parent commits; ${commit} has ${parents.length} parents`);
  }

  return {
    repo: resolve(repo),
    commit,
    parent: parents[0] ?? null,
    diffBase: parents[0] ?? emptyTree
  };
}

export function readChangedFilePairs(info: CommitInfo): FilePair[] {
  const paths = changedPaths(info.repo, info.diffBase, info.commit);
  return paths.map((path) => ({
    path,
    oldBytes: blobExists(info.repo, info.diffBase, path) ? gitBuffer(info.repo, ["show", `${info.diffBase}:${path}`]) : null,
    newBytes: blobExists(info.repo, info.commit, path) ? gitBuffer(info.repo, ["show", `${info.commit}:${path}`]) : null,
    diff: gitText(info.repo, [
      "diff",
      "--no-ext-diff",
      "--no-color",
      "--no-renames",
      "--unified=0",
      info.diffBase,
      info.commit,
      "--",
      path
    ])
  }));
}

function changedPaths(repo: string, base: string, commit: string): string[] {
  const output = gitBuffer(repo, ["diff", "--name-only", "-z", "--no-renames", base, commit]);
  return output
    .toString("utf8")
    .split("\0")
    .filter((path) => path.length > 0);
}

function blobExists(repo: string, rev: string, path: string): boolean {
  const result = spawnSync("git", ["cat-file", "-e", `${rev}:${path}`], {
    cwd: repo,
    encoding: "buffer"
  });
  return result.status === 0;
}

function gitText(cwd: string, args: string[]): string {
  return gitBuffer(cwd, args).toString("utf8");
}

function gitBuffer(cwd: string, args: string[]): Buffer {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "buffer",
    maxBuffer: 1024 * 1024 * 256
  });

  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : String(result.stderr);
    throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
  }

  return Buffer.from(result.stdout as Buffer);
}
