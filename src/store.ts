import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { couplingPayload } from "./coupling";
import { computeDigestFor } from "./digest";
import { listCommitGraphInfos, resolveRepoCacheCwd, type CommitGraphInfo, type CommitInfo } from "./git";
import { type BlockCommitDigest } from "./types";

export const commitStoreSchemaVersion = "blockcommit.commit-store.v1";

export type CommitStoreStatus = "digested" | "undigested" | "skipped";

export interface CommitStoreCommit {
  commit: string;
  parents: string[];
  status: CommitStoreStatus;
  reason?: "merge";
}

export interface CommitStoreSummary {
  tracked: number;
  digested: number;
  undigested: number;
  skipped: number;
}

export interface CommitStoreView {
  schema_version: typeof commitStoreSchemaVersion;
  range: string;
  summary: CommitStoreSummary;
  commits: CommitStoreCommit[];
}

export interface CommitCacheResult extends CommitStoreView {
  cached: number;
}

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
  coupling: string;
}

const defaultRange = "HEAD";

export function commitStoreView(cwd: string, range = defaultRange): CommitStoreView {
  const graph = listCommitGraphInfos(cwd, range);
  const paths = storePaths(graph[0]?.repo ?? resolveRepoCacheCwd(cwd));
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

  return viewFromGraph(paths, range, graph);
}

export function cacheCommitRange(cwd: string, range = defaultRange): CommitCacheResult {
  const graph = listCommitGraphInfos(cwd, range);
  const paths = storePaths(graph[0]?.repo ?? resolveRepoCacheCwd(cwd));
  const index = loadIndex(paths);

  for (const info of graph) {
    index.commits[info.commit] = { commit: info.commit, parents: info.parents };
  }
  saveIndex(paths, index);

  let cached = 0;
  for (const info of graph) {
    if (info.parents.length > 1 || hasCachedCommit(paths, info.commit)) {
      continue;
    }
    writeCachedDigest(paths, toCommitInfo(info), computeDigestFor(toCommitInfo(info)).digest);
    cached += 1;
  }

  return {
    ...viewFromGraph(paths, range, graph),
    cached
  };
}

export function cachedDigestForInfo(info: CommitInfo): BlockCommitDigest {
  const paths = storePaths(info.repo);
  const index = loadIndex(paths);
  index.commits[info.commit] = {
    commit: info.commit,
    parents: info.parent === null ? [] : [info.parent]
  };
  saveIndex(paths, index);

  if (hasCachedCommit(paths, info.commit)) {
    return JSON.parse(readFileSync(objectPath(paths.digests, info.commit), "utf8")) as BlockCommitDigest;
  }

  const digest = computeDigestFor(info).digest;
  writeCachedDigest(paths, info, digest);
  return digest;
}

export function writeDigestToCache(info: CommitInfo, digest: BlockCommitDigest): void {
  writeCachedDigest(storePaths(info.repo), info, digest);
}

export function renderCommitStoreView(view: CommitStoreView): string {
  const lines = [
    `tracked ${view.summary.tracked} commits (` +
      `digested ${view.summary.digested}, ` +
      `undigested ${view.summary.undigested}, ` +
      `skipped ${view.summary.skipped})`
  ];

  for (const commit of view.commits) {
    const marker = commit.status === "digested" ? "D" : commit.status === "undigested" ? "U" : "S";
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

export function renderCommitCacheResult(result: CommitCacheResult): string {
  return `cached ${result.cached} commits (` +
    `digested ${result.summary.digested}/${result.summary.tracked}, ` +
    `undigested ${result.summary.undigested}, ` +
    `skipped ${result.summary.skipped})\n`;
}

function viewFromGraph(paths: StorePaths, range: string, graph: CommitGraphInfo[]): CommitStoreView {
  const commits = graph.map((info): CommitStoreCommit => {
    if (info.parents.length > 1) {
      return { commit: info.commit, parents: info.parents, status: "skipped", reason: "merge" };
    }
    return {
      commit: info.commit,
      parents: info.parents,
      status: hasCachedCommit(paths, info.commit) ? "digested" : "undigested"
    };
  });
  const summary = commits.reduce<CommitStoreSummary>(
    (acc, commit) => {
      acc.tracked += 1;
      acc[commit.status] += 1;
      return acc;
    },
    { tracked: 0, digested: 0, undigested: 0, skipped: 0 }
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
    commit: info.commit,
    parent: info.parents[0] ?? null,
    diffBase: info.parents[0] ?? "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
  };
}

function hasCachedCommit(paths: StorePaths, commit: string): boolean {
  return existsSync(objectPath(paths.digests, commit)) && existsSync(objectPath(paths.coupling, commit));
}

function writeCachedDigest(paths: StorePaths, info: CommitInfo, digest: BlockCommitDigest): void {
  writeJson(objectPath(paths.digests, info.commit), digest);
  writeJson(objectPath(paths.coupling, info.commit), couplingPayload(digest));
}

function storePaths(repoCacheCwd: string): StorePaths {
  const root = resolve(repoCacheCwd, "blockcommit");
  const paths = {
    root,
    index: resolve(root, "index.json"),
    digests: resolve(root, "digests"),
    coupling: resolve(root, "coupling")
  };
  mkdirSync(paths.digests, { recursive: true });
  mkdirSync(paths.coupling, { recursive: true });
  return paths;
}

function objectPath(dir: string, commit: string): string {
  return resolve(dir, `${commit}.json`);
}

function loadIndex(paths: StorePaths): StoredIndex {
  if (!existsSync(paths.index)) {
    return { schema_version: commitStoreSchemaVersion, commits: {} };
  }
  const parsed = JSON.parse(readFileSync(paths.index, "utf8")) as StoredIndex;
  if (parsed.schema_version !== commitStoreSchemaVersion) {
    return { schema_version: commitStoreSchemaVersion, commits: {} };
  }
  return parsed;
}

function saveIndex(paths: StorePaths, index: StoredIndex): void {
  writeJson(paths.index, index);
}

function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`);
  renameSync(tmp, path);
}
