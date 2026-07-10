import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import { computeDigestFor } from "./digest";
import { listCommitGraphInfos, resolveRepoStorePath, type CommitGraphInfo, type CommitInfo } from "./git";
import { digestAlgorithm, schemaVersion, type GitTrailsDigest } from "./types";

export const commitStoreSchemaVersion = "git-trails.commit-store.v2";

export type CommitStoreStatus = "digested" | "undigested" | "invalid" | "skipped";
export type CommitStoreReason = "merge" | "malformed_digest" | "incompatible_digest";

export interface CommitStoreCommit {
  commit: string;
  parents: string[];
  status: CommitStoreStatus;
  reason?: CommitStoreReason;
}

export interface CommitStoreSummary {
  tracked: number;
  digested: number;
  undigested: number;
  invalid: number;
  skipped: number;
}

export interface CommitStoreView {
  schema_version: typeof commitStoreSchemaVersion;
  range: string;
  summary: CommitStoreSummary;
  commits: CommitStoreCommit[];
}

export type CachedDigestRecord =
  | { ok: true; digest: unknown }
  | { ok: false; error: string };

interface StoredCommit {
  commit: string;
  parents: string[];
}

interface StoredIndex {
  schema_version: typeof commitStoreSchemaVersion;
  commits: Record<string, StoredCommit>;
}

interface StorePaths {
  root: string;
  index: string;
  digests: string;
  lock: string;
}

const defaultRange = "HEAD";

export function commitStoreView(cwd: string, range = defaultRange): CommitStoreView {
  const graph = listCommitGraphInfos(cwd, range);
  const paths = storePaths(graph[0]?.store ?? resolveRepoStorePath(cwd));
  withIndexLock(paths, () => {
    const index = loadIndex(paths);
    let changed = false;

    for (const info of graph) {
      const existing = index.commits[info.commit];
      if (existing === undefined || existing.parents.join(" ") !== info.parents.join(" ")) {
        index.commits[info.commit] = { commit: info.commit, parents: info.parents };
        changed = true;
      }
    }

    if (changed) {
      saveIndex(paths, index);
    }
  });

  return viewFromGraph(paths, range, graph);
}

export function cachedDigestForInfo(info: CommitInfo): GitTrailsDigest {
  const paths = storePaths(info.store);
  withIndexLock(paths, () => {
    const index = loadIndex(paths);
    index.commits[info.commit] = {
      commit: info.commit,
      parents: info.parent === null ? [] : [info.parent]
    };
    saveIndex(paths, index);
  });

  const cached = readCachedDigest(paths, info);
  if (cached !== null) {
    return cached;
  }

  const digest = computeDigestFor(info).digest;
  writeCachedDigest(paths, info, digest);
  return digest;
}

export function writeDigestToCache(info: CommitInfo, digest: GitTrailsDigest): void {
  writeCachedDigest(storePaths(info.store), info, digest);
}

export function cachedDigestRecordForInfo(info: CommitInfo): CachedDigestRecord | null {
  const paths = storePaths(info.store);
  const digestPath = objectPath(paths.digests, info.commit);
  if (!existsSync(digestPath)) {
    return null;
  }
  const parsed = readJson(digestPath);
  return parsed.ok
    ? { ok: true, digest: parsed.value }
    : { ok: false, error: `malformed cached digest: ${parsed.error}` };
}

export function renderCommitStoreView(view: CommitStoreView): string {
  const lines = [
    `tracked ${view.summary.tracked} commits (` +
      `digested ${view.summary.digested}, ` +
      `undigested ${view.summary.undigested}, ` +
      `invalid ${view.summary.invalid}, ` +
      `skipped ${view.summary.skipped})`
  ];

  for (const commit of view.commits) {
    const marker = commit.status === "digested"
      ? "D"
      : commit.status === "undigested"
        ? "U"
        : commit.status === "invalid"
          ? "I"
          : "S";
    const parent = commit.parents.length === 0
      ? "root"
      : commit.parents.length === 1
        ? commit.parents[0].slice(0, 12)
        : `${commit.parents.length} parents`;
    const suffix = commit.reason === undefined ? "" : ` ${commit.reason}`;
    lines.push(`${marker} ${commit.commit.slice(0, 12)} ${parent}${suffix}`);
  }

  return `${lines.join("\n")}\n`;
}

function viewFromGraph(paths: StorePaths, range: string, graph: CommitGraphInfo[]): CommitStoreView {
  const commits = graph.map((info): CommitStoreCommit => {
    if (info.parents.length > 1) {
      return { commit: info.commit, parents: info.parents, status: "skipped", reason: "merge" };
    }
    const cached = cachedCommitState(paths, toCommitInfo(info));
    return {
      commit: info.commit,
      parents: info.parents,
      status: cached.status,
      ...(cached.reason === undefined ? {} : { reason: cached.reason })
    };
  });
  const summary = commits.reduce<CommitStoreSummary>(
    (acc, commit) => {
      acc.tracked += 1;
      acc[commit.status] += 1;
      return acc;
    },
    { tracked: 0, digested: 0, undigested: 0, invalid: 0, skipped: 0 }
  );

  return {
    schema_version: commitStoreSchemaVersion,
    range,
    summary,
    commits
  };
}

function toCommitInfo(info: CommitGraphInfo): CommitInfo {
  return {
    repo: info.repo,
    store: info.store,
    commit: info.commit,
    parent: info.parents[0] ?? null,
    diffBase: info.parents[0] ?? "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
  };
}

function cachedCommitState(
  paths: StorePaths,
  info: CommitInfo
): { status: "digested" | "undigested" | "invalid"; reason?: CommitStoreReason } {
  const path = objectPath(paths.digests, info.commit);
  if (!existsSync(path)) {
    return { status: "undigested" };
  }
  const parsed = readJson(path);
  if (!parsed.ok) {
    return { status: "invalid", reason: "malformed_digest" };
  }
  if (!cachedDigestMatches(info, parsed.value)) {
    return { status: "invalid", reason: "incompatible_digest" };
  }
  return { status: "digested" };
}

function readCachedDigest(paths: StorePaths, info: CommitInfo): GitTrailsDigest | null {
  const path = objectPath(paths.digests, info.commit);
  if (!existsSync(path)) {
    return null;
  }
  const parsed = readJson(path);
  return parsed.ok && cachedDigestMatches(info, parsed.value)
    ? parsed.value as GitTrailsDigest
    : null;
}

function cachedDigestMatches(info: CommitInfo, digest: unknown): digest is GitTrailsDigest {
  if (typeof digest !== "object" || digest === null) {
    return false;
  }
  const candidate = digest as Partial<GitTrailsDigest>;
  return candidate.schema_version === schemaVersion &&
    candidate.commit === info.commit &&
    candidate.parent === info.parent &&
    JSON.stringify(candidate.algorithm) === JSON.stringify(digestAlgorithm);
}

function writeCachedDigest(paths: StorePaths, info: CommitInfo, digest: GitTrailsDigest): void {
  writeJson(objectPath(paths.digests, info.commit), digest);
}

function storePaths(root: string): StorePaths {
  const paths = {
    root,
    index: resolve(root, "index.json"),
    digests: resolve(root, "digests"),
    lock: resolve(root, "index.lock")
  };
  mkdirSync(paths.digests, { recursive: true });
  return paths;
}

function objectPath(dir: string, commit: string): string {
  return resolve(dir, `${commit}.json`);
}

function loadIndex(paths: StorePaths): StoredIndex {
  if (!existsSync(paths.index)) {
    return { schema_version: commitStoreSchemaVersion, commits: {} };
  }
  const result = readJson(paths.index);
  if (!result.ok || !isStoredIndex(result.value)) {
    return { schema_version: commitStoreSchemaVersion, commits: {} };
  }
  return result.value;
}

function saveIndex(paths: StorePaths, index: StoredIndex): void {
  writeJson(paths.index, index);
}

function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`);
  renameSync(tmp, path);
}

function readJson(path: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function isStoredIndex(value: unknown): value is StoredIndex {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<StoredIndex>;
  if (candidate.schema_version !== commitStoreSchemaVersion || typeof candidate.commits !== "object" || candidate.commits === null) {
    return false;
  }
  return Object.entries(candidate.commits).every(([key, entry]) =>
    typeof entry === "object" &&
    entry !== null &&
    (entry as StoredCommit).commit === key &&
    Array.isArray((entry as StoredCommit).parents) &&
    (entry as StoredCommit).parents.every((parent) => typeof parent === "string")
  );
}

function withIndexLock<T>(paths: StorePaths, operation: () => T): T {
  const descriptor = acquireIndexLock(paths.lock);
  try {
    return operation();
  } finally {
    try {
      closeSync(descriptor);
    } finally {
      try {
        unlinkSync(paths.lock);
      } catch (error) {
        if (!isErrorCode(error, "ENOENT")) {
          throw error;
        }
      }
    }
  }
}

function acquireIndexLock(path: string): number {
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      const descriptor = openSync(path, "wx");
      try {
        writeFileSync(descriptor, `${process.pid}\n`);
        return descriptor;
      } catch (error) {
        closeSync(descriptor);
        unlinkSync(path);
        throw error;
      }
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) {
        throw error;
      }
      if (removeStaleLock(path)) {
        continue;
      }
      Atomics.wait(waiter, 0, 0, 10);
    }
  }
  throw new Error(`timed out waiting for cache index lock ${path}`);
}

function removeStaleLock(path: string): boolean {
  try {
    const owner = Number(readFileSync(path, "utf8").trim());
    if (Number.isInteger(owner) && owner > 0 && processExists(owner)) {
      return false;
    }
    if ((!Number.isInteger(owner) || owner <= 0) && Date.now() - statSync(path).mtimeMs < 30_000) {
      return false;
    }
    unlinkSync(path);
    return true;
  } catch (error) {
    return isErrorCode(error, "ENOENT");
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrorCode(error, "ESRCH");
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}
