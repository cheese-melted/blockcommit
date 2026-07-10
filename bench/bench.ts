import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { getCommitInfo } from "../src/git.js";
import { cachedDigestForInfo } from "../src/store.js";

interface Scenario {
  name: string;
  description: string;
  prepare(repo: string): string;
}

interface ScenarioResult {
  name: string;
  description: string;
  cold_ms: number;
  cache_hit_ms: number;
  digest_bytes: number;
  process_peak_rss_bytes: number;
}

const scenarios: Scenario[] = [
  {
    name: "many_changed_files",
    description: "160 changed files with 32 lines each",
    prepare: prepareManyChangedFiles
  },
  {
    name: "large_files",
    description: "two 12,000-line files with large moved regions",
    prepare: prepareLargeFiles
  },
  {
    name: "repeated_lines",
    description: "6,000-line files dominated by repeated content",
    prepare: prepareRepeatedLines
  },
  {
    name: "fan_out_and_in",
    description: "one-to-many and many-to-one movement across 24 files",
    prepare: prepareFanOutAndIn
  }
];

const root = mkdtempSync(join(tmpdir(), "git-trails-bench-"));
const started = performance.now();

try {
  const results = scenarios.map(runScenario);
  const report = {
    schema_version: "git-trails.benchmark.v1",
    generated_at: new Date().toISOString(),
    runtime: {
      bun: Bun.version,
      node: process.versions.node,
      git: git(root, ["--version"])
    },
    total_wall_ms: milliseconds(performance.now() - started),
    peak_rss_bytes: peakRssBytes(),
    scenarios: results
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  rmSync(root, { force: true, recursive: true });
}

function runScenario(scenario: Scenario): ScenarioResult {
  const repo = join(root, scenario.name);
  mkdirSync(repo);
  initRepo(repo);
  const commit = scenario.prepare(repo);
  const info = getCommitInfo(repo, commit);
  rmSync(info.store, { force: true, recursive: true });

  const coldStarted = performance.now();
  const digest = cachedDigestForInfo(info);
  const coldMs = performance.now() - coldStarted;

  const hitStarted = performance.now();
  cachedDigestForInfo(info);
  const hitMs = performance.now() - hitStarted;

  return {
    name: scenario.name,
    description: scenario.description,
    cold_ms: milliseconds(coldMs),
    cache_hit_ms: milliseconds(hitMs),
    digest_bytes: Buffer.byteLength(JSON.stringify(digest)),
    process_peak_rss_bytes: peakRssBytes()
  };
}

function prepareManyChangedFiles(repo: string): string {
  for (let file = 0; file < 160; file += 1) {
    writeRepoFile(repo, `files/file-${file.toString().padStart(3, "0")}.txt`, generatedLines(`base-${file}`, 32));
  }
  commitAll(repo, "many files base");
  for (let file = 0; file < 160; file += 1) {
    writeRepoFile(repo, `files/file-${file.toString().padStart(3, "0")}.txt`, generatedLines(`changed-${file}`, 32));
  }
  return commitAll(repo, "many files changed");
}

function prepareLargeFiles(repo: string): string {
  const first = generatedLines("large-a", 12_000).split("\n").filter(Boolean);
  const second = generatedLines("large-b", 12_000).split("\n").filter(Boolean);
  writeRepoFile(repo, "large-a.txt", `${first.join("\n")}\n`);
  writeRepoFile(repo, "large-b.txt", `${second.join("\n")}\n`);
  commitAll(repo, "large files base");
  const moved = first.splice(3_000, 3_000);
  second.splice(6_000, 0, ...moved);
  writeRepoFile(repo, "large-a.txt", `${first.join("\n")}\n`);
  writeRepoFile(repo, "large-b.txt", `${second.join("\n")}\n`);
  return commitAll(repo, "large files move");
}

function prepareRepeatedLines(repo: string): string {
  const repeated = Array.from({ length: 6_000 }, (_, index) =>
    index % 40 === 0 ? `anchor_${index}();\n` : "repeat();\n"
  );
  writeRepoFile(repo, "repeated-a.ts", repeated.join(""));
  writeRepoFile(repo, "repeated-b.ts", "target();\n");
  commitAll(repo, "repeated base");
  const moved = repeated.splice(1_500, 3_000);
  writeRepoFile(repo, "repeated-a.ts", repeated.join(""));
  writeRepoFile(repo, "repeated-b.ts", `target();\n${moved.join("")}`);
  return commitAll(repo, "repeated move");
}

function prepareFanOutAndIn(repo: string): string {
  const outChunks = Array.from({ length: 12 }, (_, chunk) => generatedLines(`out-${chunk}`, 48));
  writeRepoFile(repo, "fan-out-source.ts", outChunks.join(""));
  for (let source = 0; source < 12; source += 1) {
    writeRepoFile(repo, `in/source-${source}.ts`, generatedLines(`in-${source}`, 48));
  }
  commitAll(repo, "fan base");

  rmSync(join(repo, "fan-out-source.ts"));
  for (let chunk = 0; chunk < outChunks.length; chunk += 1) {
    writeRepoFile(repo, `out/chunk-${chunk}.ts`, outChunks[chunk]);
  }
  const merged = Array.from({ length: 12 }, (_, source) => generatedLines(`in-${source}`, 48)).join("");
  rmSync(join(repo, "in"), { recursive: true });
  writeRepoFile(repo, "fan-in.ts", merged);
  return commitAll(repo, "fan out and in");
}

function generatedLines(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, index) => `${prefix}_line_${index}();\n`).join("");
}

function writeRepoFile(repo: string, path: string, contents: string): void {
  const fullPath = join(repo, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, contents);
}

function initRepo(repo: string): void {
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "bench@example.com"]);
  git(repo, ["config", "user.name", "Benchmark"]);
  git(repo, ["config", "core.autocrlf", "false"]);
}

function commitAll(repo: string, message: string): string {
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function peakRssBytes(): number {
  return process.resourceUsage().maxRSS * 1024;
}

function milliseconds(value: number): number {
  return Math.round(value * 100) / 100;
}
